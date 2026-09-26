import type { PluginListenerHandle } from "@capacitor/core";
import type { NativeProviderSession, ProviderSessionState } from "../../capture/src/provider/native-plugin";
import type { AuthorizedProviderEncounter, ProviderWorkspaceHost } from "../../capture/src/provider/workspace-contracts";
import { assertProgress, type JournalSnapshot } from "../../capture/src/provider/workspace-journal";
import { parsePendingReviewDecision } from "../../review-ui/src/creator-review-journal";
import { reference } from "../../capture/src/provider/core-client";
import { readBoundedJson } from "../../review-ui/src/beta-api";
import { coreCaptureResponseLimit } from "../../review-ui/src/capture-response-limits";
import { parseDesktopProviderRequest, sessionState, exact, object, uuid, jsonCopy, unavailable,
  type DesktopProviderRequest, type DesktopProviderEvent } from "../../capture/src/provider/desktop-host-protocol";
import type { DesktopProviderRecorder } from "./provider-recorder.js";

export interface DesktopProviderMainHost {
  readonly session: NativeProviderSession;
  /** Main-only complete provider workspace; never forward this object to preload. */
  connect(signal: AbortSignal): Promise<{ readonly workspace: ProviderWorkspaceHost<DesktopProviderRecorder>; dispose(): Promise<void> }>;
}
interface Connection {
  readonly id: string;
  readonly revision: string;
  readonly abort: AbortController;
  readonly work: Set<Promise<unknown>>;
  opening?: Promise<void>;
  value?: Awaited<ReturnType<DesktopProviderMainHost["connect"]>>;
  encounter?: Encounter;
  transitioning: boolean;
  closing?: Promise<void>;
}
interface Encounter {
  readonly id: string;
  readonly abort: AbortController;
  readonly work: Set<Promise<unknown>>;
  readonly value: AuthorizedProviderEncounter<DesktopProviderRecorder>;
  recorder?: { dispose(): Promise<void> };
  recorderOpening?: boolean;
  closing?: Promise<void>;
}

/** One trusted main owner for the complete provider application. Authentication
 * and Core policy remain in the existing native/backend host. This layer maps
 * fixed UI actions to it and owns cleanup; it does not issue identities/grants. */
export class DesktopProviderWorkspaceMain {
  private state: ProviderSessionState | null = null;
  private observations = 0;
  private connection: Connection | null = null;
  private listener: PluginListenerHandle | null = null;
  private readonly listeners = new Set<(event: DesktopProviderEvent) => void>();
  private readonly pending = new Map<string, AbortController>();
  private readonly cleanupRequests = new Set<"sign_out" | "disconnect">();
  private sessionBusy = false;
  private closed = false;
  private initializing: Promise<void> | null = null;
  private disposing: Promise<void> | null = null;
  constructor(private readonly host: DesktopProviderMainHost,
    private readonly attachRecorder: (recorder: DesktopProviderRecorder) => { dispose(): Promise<void> }) {
    if (typeof process === "undefined" || !process.versions.node || typeof window !== "undefined"
      || "type" in process && process.type === "renderer") throw unavailable();
  }
  initialize(): Promise<void> {
    return this.initializing ??= (async () => {
      const listener = await this.host.session.addListener("authStateChanged", value => this.accept(value));
      if (this.closed) { await listener.remove(); throw unavailable(); }
      this.listener = listener;
      try { await this.readSession(); }
      catch { this.accept({ phase: "unavailable", revision: crypto.randomUUID() }); }
    })().catch(error => { this.initializing = null; throw error; });
  }
  subscribe(listener: (event: DesktopProviderEvent) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  async request(input: unknown): Promise<unknown> {
    const request = parseDesktopProviderRequest(input);
    if (this.closed || !this.listener || this.pending.has(request.requestId)) throw unavailable();
    // Cancellation never waits for a content slot; logout and disconnect each
    // have one reserved slot so held backend requests cannot prevent cleanup.
    if (request.method === "cancel") {
      if (request.connectionId !== null || request.encounterId !== null) throw unavailable();
      exact(request.payload, ["requestId"]); this.pending.get(uuid(request.payload.requestId))?.abort();
      return { requestId: request.requestId, ok: true, result: null };
    }
    const cleanup = request.method === "sign_out" || request.method === "disconnect" ? request.method : null;
    if (cleanup ? this.cleanupRequests.has(cleanup) : this.pending.size - this.cleanupRequests.size >= 8) throw unavailable();
    if (cleanup) this.cleanupRequests.add(cleanup);
    const abort = new AbortController(); this.pending.set(request.requestId, abort);
    try {
      const result = await this.dispatch(request, abort.signal);
      if (this.closed || abort.signal.aborted) throw unavailable();
      return { requestId: request.requestId, ok: true, result: jsonCopy(result) };
    } catch { return { requestId: request.requestId, ok: false, result: null }; }
    finally { this.pending.delete(request.requestId); if (cleanup) this.cleanupRequests.delete(cleanup); }
  }
  private async dispatch(request: DesktopProviderRequest, signal: AbortSignal): Promise<unknown> {
    const payload = request.payload;
    if (["session_read", "sign_in", "sign_out", "connect"].includes(request.method)) {
      if (request.connectionId !== null || request.encounterId !== null) throw unavailable();
      exact(payload, []);
      if (request.method === "session_read") return this.readSession();
      if (request.method === "connect") return this.connect(signal);
      if (this.sessionBusy) throw unavailable();
      this.sessionBusy = true;
      try {
        const closing = this.closeConnection(); void closing.catch(() => undefined);
        const observation = this.observations;
        const value = await (request.method === "sign_in" ? this.host.session.signIn() : this.host.session.signOut());
        if (observation === this.observations) this.accept(value);
        if (request.method === "sign_in") {
          // Initial cessation can fail while signed out. Retry its retained
          // owner after authentication; a different account still cannot clear it.
          await closing.catch(() => undefined);
          await this.closeConnection();
        } else await closing;
        return this.state;
      } finally { this.sessionBusy = false; }
    }
    if (request.method === "disconnect") {
      exact(payload, []);
      if (request.encounterId !== null || this.connection && this.connection.id !== request.connectionId) throw unavailable();
      await this.closeConnection(); return null;
    }
    const connection = this.currentConnection(request.connectionId);
    if (["list", "create", "open"].includes(request.method)) {
      if (request.encounterId !== null || connection.transitioning) throw unavailable();
      connection.transitioning = true;
      return this.track(connection.work, async () => {
        try {
          await this.closeEncounter(connection); this.requireConnection(connection, signal);
          const linked = AbortSignal.any([connection.abort.signal, signal]);
          if (request.method === "list") {
            exact(payload, []); const values = await connection.value!.workspace.listEncounters(linked);
            this.requireConnection(connection, signal); return values;
          }
          if (request.method === "create") {
            exact(payload, []); await connection.value!.workspace.createEncounter(linked);
            this.requireConnection(connection, signal); return null;
          }
          exact(payload, ["appointmentRef"]);
          if (!reference(payload.appointmentRef, "appointment")) throw unavailable();
          const opening = new AbortController();
          try {
            const opened = await connection.value!.workspace.openEncounter(payload.appointmentRef, AbortSignal.any([linked, opening.signal]));
            this.requireConnection(connection, signal);
            if (opened.signal.aborted || opened.scope.appointmentRef !== payload.appointmentRef || opened.encounter.appointmentRef !== payload.appointmentRef) throw unavailable();
            const encounter: Encounter = { id: crypto.randomUUID(), abort: opening, value: opened, work: new Set() };
            connection.encounter = encounter;
            opened.signal.addEventListener("abort", () => { void this.closeEncounter(connection, encounter).catch(() => undefined); }, { once: true });
            return { encounterId: encounter.id, encounter: opened.encounter, scope: opened.scope };
          } catch (error) { opening.abort(); throw error; }
        } finally { connection.transitioning = false; }
      });
    }
    const encounter = connection.encounter;
    if (!encounter || encounter.id !== request.encounterId || encounter.abort.signal.aborted) throw unavailable();
    return this.track(encounter.work, async () => {
      this.requireEncounter(connection, encounter, signal);
      let result: unknown;
      switch (request.method) {
        case "core": result = await this.core(encounter, payload, AbortSignal.any([signal, encounter.abort.signal, connection.abort.signal])); break;
        case "journal_load": exact(payload, []); result = await encounter.value.journal.load(); break;
        case "journal_save": {
          exact(payload, ["previous", "progress"]); const previous = exact(payload.previous, ["revision", "progress"]);
          if (previous.revision !== null && (typeof previous.revision !== "string" || !/^[1-9][0-9]{0,15}$/u.test(previous.revision))) throw unavailable();
          if (previous.progress !== null) assertProgress(previous.progress); assertProgress(payload.progress);
          result = await encounter.value.journal.save(previous as unknown as JournalSnapshot, payload.progress); break;
        }
        case "review_load": case "review_save": case "review_clear": {
          exact(payload, request.method === "review_load" ? ["sessionId"] : request.method === "review_save" ? ["sessionId", "operation"] : ["sessionId", "key"]);
          await this.requireSession(encounter, payload.sessionId);
          this.requireEncounter(connection, encounter, signal);
          const journal = encounter.value.reviewJournal(uuid(payload.sessionId));
          if (request.method === "review_load") result = await journal.load();
          else if (request.method === "review_save") { await journal.save(parsePendingReviewDecision(payload.operation)); result = null; }
          else {
            if (typeof payload.key !== "string" || !/^[A-Za-z0-9._-]{8,255}$/u.test(payload.key)) throw unavailable();
            await journal.clear(payload.key); result = null;
          }
          break;
        }
        case "recorder": {
          exact(payload, ["sessionId"]); await this.requireSession(encounter, payload.sessionId);
          this.requireEncounter(connection, encounter, signal);
          if (encounter.recorder || encounter.recorderOpening) throw unavailable();
          encounter.recorderOpening = true;
          try {
            const recorder = await encounter.value.recorder(uuid(payload.sessionId), AbortSignal.any([signal, encounter.abort.signal, connection.abort.signal]));
            // Retain cleanup ownership even if IPC attachment fails or native
            // stop remains unconfirmed. Close waits for this handoff to settle.
            encounter.recorder = { dispose: () => recorder.deactivate() };
            encounter.recorder = this.attachRecorder(recorder);
          } catch (error) {
            void this.closeEncounter(connection, encounter).catch(() => undefined); throw error;
          } finally { delete encounter.recorderOpening; }
          result = null; break;
        }
        case "open_core": {
          exact(payload, ["noteRef"]);
          if (payload.noteRef !== null && !reference(payload.noteRef, "visit_note")) throw unavailable();
          await encounter.value.openInCore(payload.noteRef); result = null; break;
        }
        default: throw unavailable();
      }
      this.requireEncounter(connection, encounter, signal); return result;
    });
  }
  private async core(encounter: Encounter, payload: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
    exact(payload, ["path", "body", "key"]);
    const body = object(payload.body), scope = encounter.value.scope;
    if (typeof payload.key !== "string" || !/^[A-Za-z0-9._:-]{8,255}$/u.test(payload.key)
      || body.workspace_id !== scope.workspaceId || body.binding_ref !== scope.bindingRef) throw unavailable();
    uuid(body.request_nonce);
    const path = payload.path;
    if (path === "/service/v1/agent/scribe/capture-operations") {
      const operation = object(body.operation);
      if (typeof operation.kind !== "string" || !["creator_review", "decide_translation"].includes(operation.kind)) throw unavailable();
    } else if (path !== "/service/v1/agent/scribe/capture-admissions" && path !== "/service/v1/agent/scribe/capture-notes") throw unavailable();
    const response = await encounter.value.request(path, body, payload.key, signal);
    if (signal.aborted || ![200, 401, 403, 409, 422, 503].includes(response.status)) throw unavailable();
    if (response.status === 200) return { status: 200, body: await readBoundedJson(response,
      coreCaptureResponseLimit(path.slice(path.lastIndexOf("/") + 1))) };
    // Permit one native-sanitized recovery outcome, never arbitrary error content.
    if (path === "/service/v1/agent/scribe/capture-admissions" && response.status === 409
      && response.headers.get("content-type")?.split(";", 1)[0] === "application/json") {
      const failure = object(await readBoundedJson(response, 1024));
      if (signal.aborted) throw unavailable();
      if (Object.keys(failure).length === 1 && failure.detail === "provider_consent_required") {
        return { status: 409, body: { detail: "provider_consent_required" } };
      }
    }
    return { status: response.status, body: null };
  }
  private async requireSession(encounter: Encounter, value: unknown): Promise<void> {
    const sessionId = uuid(value), saved = await encounter.value.journal.load();
    if (saved.progress?.sessionId !== sessionId) throw unavailable();
  }
  private async readSession(): Promise<ProviderSessionState> {
    const observation = this.observations, value = sessionState(await this.host.session.getState());
    if (this.closed) throw unavailable();
    if (observation === this.observations) this.accept(value);
    if (!this.state) throw unavailable(); return this.state;
  }
  private accept(input: unknown): void {
    if (this.closed) return;
    let value: ProviderSessionState;
    try { value = sessionState(input); } catch { value = { phase: "unavailable", revision: crypto.randomUUID() }; }
    this.observations++; this.state = value;
    if (this.connection && (value.phase !== "ready" || value.revision !== this.connection.revision)) void this.closeConnection().catch(() => undefined);
    this.publish({ kind: "session", state: value });
  }
  private async connect(signal: AbortSignal): Promise<unknown> {
    await this.closeConnection(); const state = await this.readSession();
    if (state.phase !== "ready" || signal.aborted || this.closed || this.connection) throw unavailable();
    const connection: Connection = { id: crypto.randomUUID(), revision: state.revision, abort: new AbortController(), work: new Set(), transitioning: false };
    this.connection = connection;
    const cancel = (): void => { void this.closeConnection(connection).catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    connection.opening = (async () => {
      connection.value = await this.host.connect(connection.abort.signal);
      this.requireConnection(connection, signal);
      if (connection.value.workspace.signal.aborted) throw unavailable();
      connection.value.workspace.signal.addEventListener("abort", cancel, { once: true });
    })();
    try { await connection.opening; return { connectionId: connection.id, revision: connection.revision }; }
    catch (error) { await this.closeConnection(connection); throw error; }
    finally { signal.removeEventListener("abort", cancel); }
  }
  private currentConnection(id: string | null): Connection {
    const connection = this.connection;
    if (!connection || connection.id !== id) throw unavailable(); this.requireConnection(connection); return connection;
  }
  private requireConnection(connection: Connection, signal?: AbortSignal): void {
    if (this.closed || connection !== this.connection || connection.abort.signal.aborted || signal?.aborted
      || this.state?.phase !== "ready" || this.state.revision !== connection.revision) throw unavailable();
  }
  private requireEncounter(connection: Connection, encounter: Encounter, signal: AbortSignal): void {
    this.requireConnection(connection, signal);
    if (connection.encounter !== encounter || encounter.abort.signal.aborted || encounter.value.signal.aborted) throw unavailable();
  }
  private closeEncounter(connection: Connection, encounter = connection.encounter): Promise<void> {
    if (!encounter) return Promise.resolve();
    if (encounter.closing) return encounter.closing;
    encounter.closing = Promise.resolve().then(async () => {
      await Promise.allSettled(encounter.work); await encounter.recorder?.dispose();
      if (connection.encounter === encounter) delete connection.encounter;
    }).catch(error => { delete encounter.closing; throw error; });
    encounter.abort.abort(); this.publish({ kind: "encounter_closed", id: encounter.id });
    return encounter.closing;
  }
  private closeConnection(connection = this.connection): Promise<void> {
    if (!connection) return Promise.resolve();
    if (connection.closing) return connection.closing;
    connection.closing = Promise.resolve().then(async () => {
      await connection.opening?.catch(() => undefined);
      await Promise.allSettled(connection.work); await this.closeEncounter(connection);
      await connection.value?.dispose(); if (this.connection === connection) this.connection = null;
    }).catch(error => { delete connection.closing; throw error; });
    connection.abort.abort(); this.publish({ kind: "connection_closed", id: connection.id });
    return connection.closing;
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.closed = true; this.pending.forEach(abort => abort.abort());
    return this.disposing = (async () => {
      await this.initializing?.catch(() => undefined); await this.closeConnection();
      await this.listener?.remove(); this.listener = null; this.listeners.clear();
    })().catch(error => { this.disposing = null; throw error; });
  }
  private track<T>(set: Set<Promise<unknown>>, operation: () => Promise<T>): Promise<T> {
    const work = Promise.resolve().then(operation); set.add(work);
    void work.then(() => set.delete(work), () => set.delete(work)); return work;
  }
  private publish(event: DesktopProviderEvent): void { for (const listener of this.listeners) { try { listener(event); } catch { /* UI does not own cleanup. */ } } }
}
