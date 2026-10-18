import { scopedSignInPreparation } from "./signin-preparation";
import { parsePendingCreatorEdit } from "../../../review-ui/src/creator-edit";
import { parsePrivateNote, parsePatientIdentity } from "./visit-features";
import { parseEncounterDisplay } from "./encounter-display";
import { openDesktopAudioPreflight } from "./desktop-audio-preflight";
import { parseProviderAccount, parseSetupState, parseEncounterDraft, type ProviderEncounterSetup, type ProviderAccount } from "./encounter-setup";
import { mountProviderApplication, type ProviderApplicationHost } from "./application";
import type { ProviderSessionState } from "./native-plugin";
import type { ProviderWorkspaceHost } from "./workspace";
import type { ProviderEncounter } from "./workspace-contracts";
import { assertProgress, type JournalSnapshot } from "./workspace-journal";
import { parsePendingReviewDecision } from "../../../review-ui/src/creator-review-journal";
import { connectDesktopRecorderView, type DesktopRecorderPort } from "./desktop-recorder-view";
import { reference, type CoreCaptureScope } from "./core-client";
import { parseOpeningReview } from "./opening-review";
import type { ConsentPreparationRelease } from "./consent-preparation";
import { parseDesktopProviderEvent, sessionState, exact, object, uuid, jsonCopy, unavailable,
  type DesktopProviderMethod, type DesktopProviderPort, type DesktopProviderRequest } from "./desktop-host-protocol";

/** Mount the complete provider UI with the reviewed sandboxed desktop preload.
 * No backend origin, token, native source or storage/key object enters this page. */
export function mountDesktopProviderApplication(root: HTMLElement, provider: DesktopProviderPort,
  recorder: DesktopRecorderPort, consentPreparation?: ConsentPreparationRelease): () => Promise<void> {
  const connection = createDesktopProviderApplicationHost(provider, recorder, consentPreparation);
  let unmount: () => Promise<void>;
  try { unmount = mountProviderApplication(root, connection.host); }
  catch (error) { void connection.dispose().catch(() => undefined); throw error; }
  return async () => { await unmount(); await connection.dispose(); };
}

export function createDesktopProviderApplicationHost(port: DesktopProviderPort, recorderPort: DesktopRecorderPort,
  consentPreparation?: ConsentPreparationRelease): {
  readonly host: ProviderApplicationHost; dispose(): Promise<void>;
} {
  const lifetime = new AbortController();
  const sessionListeners = new Set<(state: ProviderSessionState) => void>();
  const connections = new Map<string, { abort: AbortController; dispose(): Promise<void> }>();
  const encounters = new Map<string, AbortController>(), closedIds = new Set<string>();
  let state: ProviderSessionState | null = null, observations = 0, closed = false;
  const emitState = (value: unknown): ProviderSessionState => {
    state = sessionState(value); observations++;
    for (const listener of sessionListeners) listener({ ...state }); return state;
  };
  const unsubscribe = port.subscribe(value => {
    if (closed) return;
    try {
      const event = parseDesktopProviderEvent(value);
      if (event.kind === "session") {
        if (state && (event.state.phase !== "ready" || event.state.revision !== state.revision)) {
          connections.forEach(connection => connection.abort.abort());
        }
        emitState(event.state);
      } else {
        closedIds.add(event.id);
        if (closedIds.size > 1024) throw unavailable();
        connections.get(event.id)?.abort.abort(); encounters.get(event.id)?.abort();
      }
    } catch {
      connections.forEach(connection => connection.abort.abort());
      emitState({ phase: "unavailable", revision: crypto.randomUUID() });
    }
  });
  const request = (method: DesktopProviderMethod, payload: Readonly<Record<string, unknown>>,
    connectionId: string | null = null, encounterId: string | null = null, signal = lifetime.signal): Promise<unknown> => {
    if (closed || signal.aborted) return Promise.reject(unavailable());
    const requestId = crypto.randomUUID();
    const command: DesktopProviderRequest = { method, requestId, payload, connectionId, encounterId };
    return new Promise((resolve, reject) => {
      let settled = false;
      const cancel = (): void => {
        if (settled) return;
        settled = true; signal.removeEventListener("abort", cancel);
        void Promise.resolve().then(() => port.request({ method: "cancel", requestId: crypto.randomUUID(), connectionId: null,
          encounterId: null, payload: { requestId } })).catch(() => undefined);
        reject(unavailable());
      };
      signal.addEventListener("abort", cancel, { once: true });
      let response: Promise<unknown>;
      try { response = port.request(command); }
      catch { signal.removeEventListener("abort", cancel); reject(unavailable()); return; }
      void response.then(value => {
        if (settled) return;
        settled = true; signal.removeEventListener("abort", cancel);
        try {
          const reply = exact(value, ["requestId", "ok", "result"]);
          if (closed || signal.aborted || reply.requestId !== requestId || reply.ok !== true) throw unavailable();
          resolve(jsonCopy(reply.result));
        } catch { reject(unavailable()); }
      }, () => {
        if (!settled) { settled = true; signal.removeEventListener("abort", cancel); reject(unavailable()); }
      });
    });
  };
  const sessionRequest = async (method: "session_read" | "sign_in" | "sign_out"): Promise<ProviderSessionState> => {
    const before = observations, value = sessionState(await request(method, {}));
    return before === observations ? emitState(value) : state!;
  };
  const host: ProviderApplicationHost = {
    supportsRecorderStopReauthentication: true,
    supportsWorkspaceCloseReauthentication: true,
    session: {
      getState: () => sessionRequest("session_read"),
      signIn: () => sessionRequest("sign_in"),
      signOut: () => sessionRequest("sign_out"),
      addListener: (_event, listener) => {
        sessionListeners.add(listener);
        return Promise.resolve({ remove: () => { sessionListeners.delete(listener); return Promise.resolve(); } });
      },
    },
    connect: async signal => {
      const expected = state;
      if (!expected || expected.phase !== "ready") throw unavailable();
      const opened = exact(await request("connect", {}, null, null, signal), ["connectionId", "revision"]);
      const id = uuid(opened.connectionId);
      const abort = new AbortController();
      let closing: Promise<void> | null = null;
      const cancel = (): void => abort.abort();
      signal.addEventListener("abort", cancel, { once: true });
      const dispose = (): Promise<void> => {
        abort.abort(); signal.removeEventListener("abort", cancel);
        return closing ??= request("disconnect", {}, id).then(() => { connections.delete(id); })
          .catch(error => { closing = null; throw error; });
      };
      connections.set(id, { abort, dispose });
      if (signal.aborted || state?.phase !== "ready" || state.revision !== expected.revision
        || opened.revision !== expected.revision || closedIds.has(id)) { await dispose(); throw unavailable(); }
      const current = (operationSignal?: AbortSignal): void => {
        if (abort.signal.aborted || signal.aborted || operationSignal?.aborted) throw unavailable();
      };
      const send = (method: DesktopProviderMethod, payload: Readonly<Record<string, unknown>>, encounterId: string | null = null,
        operationSignal = abort.signal): Promise<unknown> => {
        current(operationSignal); return request(method, payload, id, encounterId, AbortSignal.any([abort.signal, operationSignal]));
      };
      let creationEnabled = false, account: ProviderAccount | undefined;
      let currentEncounter: { id: string; appointmentRef: string } | null = null;
      const visitRequest = (selected: ProviderEncounter, payload: Record<string, unknown>, extra: AbortSignal): Promise<unknown> => {
        if (!currentEncounter || currentEncounter.appointmentRef !== selected.appointmentRef) throw unavailable();
        return send("visit_features", payload, currentEncounter.id, extra);
      };
      const privateNote = (value: unknown) => { const row = object(value); return parsePrivateNote({ text: row.text, version: row.version, updated_at: row.updatedAt }); };
      const identity = (value: unknown) => { const row = object(value); return parsePatientIdentity({ state: row.state, version: row.version, canonical_patient_ref: row.canonicalPatientRef, name: row.name, date_of_birth: row.dateOfBirth }); };
      const setup: ProviderEncounterSetup = {
        readPrivateNote: async (selected, extra) => privateNote(await visitRequest(selected, { action: "private_read" }, extra)),
        savePrivateNote: async (selected, text, expectedVersion, key, extra) => privateNote(await visitRequest(selected, { action: "private_save", text, expectedVersion, key }, extra)),
        patientCandidates: async (selected, query, dateOfBirth, extra) => {
          const value = object(await visitRequest(selected, { action: "candidates", query, dateOfBirth }, extra));
          const parsed = parseSetupState({ account: account?.email, patients: value.patients, moreResults: value.moreResults, pending: null });
          return { patients: parsed.patients, moreResults: parsed.moreResults, identity: identity(value.identity) };
        },
        matchPatient: async (selected, selection, expectedVersion, key, extra) => {
          const value = object(await visitRequest(selected, { action: "match", selection, expectedVersion, key }, extra));
          return { encounter: encounter(value.encounter), identity: identity(value.identity) };
        },
        addDateOfBirth: async (selected, dateOfBirth, key, extra) => {
          if (!currentEncounter || currentEncounter.appointmentRef !== selected.appointmentRef) throw unavailable();
          return encounter(await send("add_birth_date", { dateOfBirth, key }, currentEncounter.id, extra));
        },
        hidden: async extra => {
          const refs = await send("encounter_setup", { action: "hidden" }, null, extra);
          if (!Array.isArray(refs) || refs.length > 1000 || refs.some(ref => !reference(ref, "appointment")) || new Set(refs).size !== refs.length) throw unavailable();
          return refs as string[];
        },
        setHidden: async (appointmentRef, hidden, extra) => { await send("encounter_setup", { action: "set_hidden", appointmentRef, hidden }, null, extra); },
        state: async extra => parseSetupState(await send("encounter_setup", { action: "state" }, null, extra)),
        search: async (query, extra) => {
          const result = object(await send("encounter_setup", { action: "search", query }, null, extra));
          const parsed = parseSetupState({ ...result, pending: null });
          return { account: parsed.account, patients: parsed.patients, moreResults: parsed.moreResults };
        },
        submit: async (draft, extra) => encounter(await send("encounter_setup", {
          action: "submit", draft: draft === null ? null : parseEncounterDraft(draft),
        }, null, extra)),
      };
      const workspace: ProviderWorkspaceHost = {
        ...(consentPreparation ? { consentPreparation } : {}),
        audioPreflight: extra => {
          if (!currentEncounter) return Promise.reject(unavailable());
          const selectedId = currentEncounter.id;
          return openDesktopAudioPreflight(extra, (payload, operation) => send("preflight", payload, selectedId, operation));
        },
        recorderRechecksReview: true,
        get providerDisplayName() {
          return !abort.signal.aborted && !signal.aborted && state?.phase === "ready"
            && state.revision === expected.revision ? state.providerDisplayName : undefined;
        },
        get account() { return account; },
        get encounterSetup() { return creationEnabled ? setup : undefined; },
        signal: abort.signal,
        listEncounters: async operationSignal => {
          const values = await send("list", {}, null, operationSignal); current(operationSignal);
          if (!Array.isArray(values) || values.length > 1000) throw unavailable();
          const info = exact(await send("encounter_setup", { action: "info" }, null, operationSignal), ["enabled", "account"]);
          current(operationSignal);
          if (typeof info.enabled !== "boolean") throw unavailable();
          creationEnabled = info.enabled; account = info.account === null ? undefined : parseProviderAccount(info.account);
          return values.map(encounter);
        },
        createEncounter: async operationSignal => { await send("create", {}, null, operationSignal); current(operationSignal); },
        openEncounter: async (appointmentRef, operationSignal) => {
          const result = await send("open", { appointmentRef }, null, operationSignal);
          const hasOpening = typeof result === "object" && result !== null && "openingReview" in result;
          const hasSignInPreparation = typeof result === "object" && result !== null && "signInPreparationSupported" in result;
          const hasNoteOpening = typeof result === "object" && result !== null && "noteOpeningSupported" in result;
          const value = exact(result, ["encounterId", "encounter", "scope", ...(hasOpening ? ["openingReview"] : []),
            ...(hasNoteOpening ? ["noteOpeningSupported"] : []), ...(hasSignInPreparation ? ["signInPreparationSupported"] : [])]);
          if (hasNoteOpening && value.noteOpeningSupported !== true || hasSignInPreparation && value.signInPreparationSupported !== true) throw unavailable();
          current(operationSignal);
          const encounterId = uuid(value.encounterId), displayed = encounter(value.encounter), scope = captureScope(value.scope);
          if (displayed.appointmentRef !== appointmentRef || scope.appointmentRef !== appointmentRef) throw unavailable();
          const local = new AbortController(); encounters.set(encounterId, local);
          currentEncounter = { id: encounterId, appointmentRef };
          local.signal.addEventListener("abort", () => { if (currentEncounter?.id === encounterId) currentEncounter = null; }, { once: true });
          const linked = AbortSignal.any([abort.signal, operationSignal, local.signal]);
          linked.addEventListener("abort", () => { encounters.delete(encounterId); }, { once: true });
          if (closedIds.has(encounterId) || linked.aborted) { local.abort(); throw unavailable(); }
          const call = (method: DesktopProviderMethod, payload: Readonly<Record<string, unknown>>, extra = linked): Promise<unknown> =>
            send(method, payload, encounterId, AbortSignal.any([linked, extra]));
          return {
            ...(hasSignInPreparation ? { signInPreparation: scopedSignInPreparation({
              signal: linked, current: () => current(linked),
              prepare: async (_id, signal) => { await call("signin_preparation", { action: "prepare" }, signal); },
              abandon: () => request("signin_preparation", { action: "abandon" }, id, encounterId).then(() => undefined),
            }) } : {}), encounter: displayed, scope, signal: linked,
            ...(hasNoteOpening ? { noteOpeningSupported: true as const } : {}),
            ...(hasOpening ? { openingReview: parseOpeningReview(value.openingReview, scope) } : {}),
            request: async (path, body, key, extra) => {
              const result = exact(await call("core", { path, body, key }, extra), ["status", "body"]);
              if (![200, 401, 403, 409, 422, 503].includes(Number(result.status))) throw unavailable();
              return Response.json(result.body, { status: Number(result.status) });
            },
            journal: {
              load: async () => journal(await call("journal_load", {})),
              save: async (previous, progress) => journal(await call("journal_save", { previous, progress })),
            },
            editJournal: sessionId => ({
              load: async () => { const value = await call("edit_load", { sessionId }); return value === null ? null : parsePendingCreatorEdit(value); },
              save: async operation => { await call("edit_save", { sessionId, operation }); },
              clear: async key => { await call("edit_clear", { sessionId, key }); },
            }),
            reviewJournal: sessionId => ({
              load: async () => {
                const value = await call("review_load", { sessionId }); return value === null ? null : parsePendingReviewDecision(value);
              },
              save: async operation => { await call("review_save", { sessionId, operation }); },
              clear: async key => { await call("review_clear", { sessionId, key }); },
            }),
            recorder: async (sessionId, extra) => {
              await call("recorder", { sessionId }, extra);
              // Main revokes recorder IPC immediately when a connection closes.
              // Its retained disconnect path still waits for physical and server
              // cessation, including after same-account reauthentication.
              const cleanupPort: DesktopRecorderPort = {
                subscribe: listener => recorderPort.subscribe(listener),
                request: async command => {
                  if (command.kind === "deactivate" && (abort.signal.aborted || signal.aborted)) {
                    await dispose();
                    return { requestId: command.requestId, ok: true, state: null };
                  }
                  return recorderPort.request(command);
                },
              };
              return connectDesktopRecorderView(cleanupPort, sessionId, AbortSignal.any([linked, extra]));
            },
            playPassage: async (sessionId, segmentId, extra) => {
              const value = await call("play_passage", { sessionId, segmentId }, extra);
              if (value === null) return null;
              const result = exact(value, ["wavBase64"]);
              if (typeof result.wavBase64 !== "string" || result.wavBase64.length > 1_300_000 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(result.wavBase64)) throw unavailable();
              return { wavBase64: result.wavBase64 };
            },
            openInCore: async noteRef => { await call("open_core", { noteRef }); },
          };
        },
      };
      return { workspace, dispose };
    },
  };
  return { host, dispose: async () => {
    // Close native owners while the port is usable; a failed close is retryable.
    for (const connection of connections.values()) await connection.dispose();
    closed = true; lifetime.abort(); unsubscribe(); sessionListeners.clear(); encounters.forEach(abort => abort.abort()); encounters.clear();
  } };
}
const encounter = parseEncounterDisplay;

function captureScope(value: unknown): CoreCaptureScope {
  const scope = exact(value, ["workspaceId", "bindingRef", "appointmentRef"]);
  if (!reference(scope.bindingRef, "scribe_capture_binding") || !reference(scope.appointmentRef, "appointment")) throw unavailable();
  return { workspaceId: uuid(scope.workspaceId), bindingRef: scope.bindingRef, appointmentRef: scope.appointmentRef };
}
function journal(value: unknown): JournalSnapshot {
  const snapshot = exact(value, ["revision", "progress"]);
  if (snapshot.revision !== null && (typeof snapshot.revision !== "string" || !/^[1-9][0-9]{0,15}$/u.test(snapshot.revision))) throw unavailable();
  if (snapshot.progress !== null) assertProgress(snapshot.progress);
  return snapshot as unknown as JournalSnapshot;
}
