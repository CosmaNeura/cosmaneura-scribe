import { mountProviderApplication, type ProviderApplicationHost } from "./application";
import type { ProviderSessionState } from "./native-plugin";
import type { ProviderEncounter, ProviderWorkspaceHost } from "./workspace";
import { assertProgress, type JournalSnapshot } from "./workspace-journal";
import { parsePendingReviewDecision } from "../../../review-ui/src/creator-review-journal";
import { connectDesktopRecorderView, type DesktopRecorderPort } from "./desktop-recorder-view";
import { reference, type CoreCaptureScope } from "./core-client";
import { parseDesktopProviderEvent, sessionState, exact, uuid, jsonCopy, unavailable,
  type DesktopProviderMethod, type DesktopProviderPort, type DesktopProviderRequest } from "./desktop-host-protocol";

/** Mount the complete provider UI with the reviewed sandboxed desktop preload.
 * No backend origin, token, native source or storage/key object enters this page. */
export function mountDesktopProviderApplication(root: HTMLElement, provider: DesktopProviderPort,
  recorder: DesktopRecorderPort): () => Promise<void> {
  const connection = createDesktopProviderApplicationHost(provider, recorder);
  let unmount: () => Promise<void>;
  try { unmount = mountProviderApplication(root, connection.host); }
  catch (error) { void connection.dispose().catch(() => undefined); throw error; }
  return async () => { await unmount(); await connection.dispose(); };
}

export function createDesktopProviderApplicationHost(port: DesktopProviderPort, recorderPort: DesktopRecorderPort): {
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
      const workspace: ProviderWorkspaceHost = {
        signal: abort.signal,
        listEncounters: async operationSignal => {
          const values = await send("list", {}, null, operationSignal); current(operationSignal);
          if (!Array.isArray(values) || values.length > 1000) throw unavailable(); return values.map(encounter);
        },
        createEncounter: async operationSignal => { await send("create", {}, null, operationSignal); current(operationSignal); },
        openEncounter: async (appointmentRef, operationSignal) => {
          const value = exact(await send("open", { appointmentRef }, null, operationSignal), ["encounterId", "encounter", "scope"]);
          current(operationSignal);
          const encounterId = uuid(value.encounterId), displayed = encounter(value.encounter), scope = captureScope(value.scope);
          if (displayed.appointmentRef !== appointmentRef || scope.appointmentRef !== appointmentRef) throw unavailable();
          const local = new AbortController(); encounters.set(encounterId, local);
          const linked = AbortSignal.any([abort.signal, operationSignal, local.signal]);
          linked.addEventListener("abort", () => { encounters.delete(encounterId); }, { once: true });
          if (closedIds.has(encounterId) || linked.aborted) { local.abort(); throw unavailable(); }
          const call = (method: DesktopProviderMethod, payload: Readonly<Record<string, unknown>>, extra = linked): Promise<unknown> =>
            send(method, payload, encounterId, AbortSignal.any([linked, extra]));
          return { encounter: displayed, scope, signal: linked,
            request: async (path, body, key, extra) => {
              const result = exact(await call("core", { path, body, key }, extra), ["status", "body"]);
              if (![200, 401, 403, 409, 422, 503].includes(Number(result.status))) throw unavailable();
              return Response.json(result.body, { status: Number(result.status) });
            },
            journal: {
              load: async () => journal(await call("journal_load", {})),
              save: async (previous, progress) => journal(await call("journal_save", { previous, progress })),
            },
            reviewJournal: sessionId => ({
              load: async () => {
                const value = await call("review_load", { sessionId }); return value === null ? null : parsePendingReviewDecision(value);
              },
              save: async operation => { await call("review_save", { sessionId, operation }); },
              clear: async key => { await call("review_clear", { sessionId, key }); },
            }),
            recorder: async (sessionId, extra) => {
              await call("recorder", { sessionId }, extra);
              return connectDesktopRecorderView(recorderPort, sessionId, AbortSignal.any([linked, extra]));
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
function encounter(value: unknown): ProviderEncounter {
  const row = exact(value, ["appointmentRef", "title", "detail"]);
  if (!reference(row.appointmentRef, "appointment") || typeof row.title !== "string" || row.title.length > 300
    || typeof row.detail !== "string" || row.detail.length > 1000) throw unavailable();
  return { appointmentRef: row.appointmentRef, title: row.title, detail: row.detail };
}
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
