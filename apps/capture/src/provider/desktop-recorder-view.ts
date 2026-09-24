import type { PreparedProviderRecorder, ProviderRecorderController, ProviderRecorderSnapshot } from "../provider-binding";

export const DESKTOP_RECORDER_CHANNELS = Object.freeze({ request: "scribe:provider:recorder:v1", state: "scribe:provider:recorder-state:v1" });
export type DesktopRecorderCommand = "read" | "start" | "stop" | "pause" | "continue" | "permissions" | "resume" | "release" | "deactivate";
export interface DesktopRecorderState {
  readonly recorderId: string;
  readonly revision: number;
  readonly snapshot: ProviderRecorderSnapshot;
}
/** Fixed preload surface. No arbitrary IPC, requests, bytes, paths or credentials. */
export interface DesktopRecorderPort {
  request(command: { readonly kind: DesktopRecorderCommand; readonly requestId: string; readonly recorderId: string | null }): Promise<unknown>;
  subscribe(listener: (state: unknown) => void): () => void;
}
export interface DesktopRecorderRequest { readonly kind: DesktopRecorderCommand; readonly requestId: string; readonly recorderId: string | null }

/** Renderer-only view of the recorder selected and initialized by trusted main. */
export async function connectDesktopRecorderView(port: DesktopRecorderPort, sessionId: string,
  signal: AbortSignal): Promise<PreparedProviderRecorder> {
  uuid(sessionId); if (signal.aborted) throw failure();
  let state: DesktopRecorderState | null = null, ended = false, closing: Promise<void> | null = null;
  const listeners = new Set<(snapshot: ProviderRecorderSnapshot) => void>();
  const accept = (value: unknown): void => {
    const next = parseDesktopRecorderState(value);
    if (next.snapshot.sessionId !== sessionId || state && next.recorderId !== state.recorderId) throw failure();
    if (state && next.revision <= state.revision) return;
    state = next;
    if (ended || signal.aborted) return;
    for (const listener of listeners) { try { listener(structuredClone(next.snapshot)); } catch { /* Observer isolation. */ } }
  };
  const stopListening = port.subscribe(value => { try { accept(value); } catch { void deactivate().catch(() => undefined); } });
  const invoke = async (kind: DesktopRecorderCommand): Promise<void> => {
    if (kind !== "deactivate" && (ended || signal.aborted)) throw failure();
    const requestId = crypto.randomUUID();
    const response = exact(await port.request({ kind, requestId, recorderId: state?.recorderId ?? null }), ["requestId", "ok", "state"]);
    if (response.requestId !== requestId || typeof response.ok !== "boolean") throw failure();
    if (kind === "deactivate") { if (response.state !== null) throw failure(); }
    else accept(response.state);
    if (!response.ok || kind !== "deactivate" && (ended || signal.aborted)) throw failure();
  };
  function deactivate(): Promise<void> {
    ended = true; stopListening(); listeners.clear(); signal.removeEventListener("abort", onAbort);
    // A late initial read still supplies its owner ID; the acquisition catch
    // then closes that exact recorder. Never send an unbound Stop command.
    if (!state) return Promise.resolve();
    return closing ??= invoke("deactivate").catch(error => { closing = null; throw error; });
  }
  const onAbort = (): void => { void deactivate().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try { await invoke("read"); if (!state) throw failure(); }
  catch (error) { await deactivate().catch(() => undefined); throw error; }
  const controller: ProviderRecorderController = {
    get snapshot() { if (!state || ended || signal.aborted) throw failure(); return structuredClone(state.snapshot); },
    subscribe: listener => {
      if (ended || signal.aborted) throw failure();
      listeners.add(listener); listener(controller.snapshot); return () => listeners.delete(listener);
    },
    startRecording: () => invoke("start"), stopRecording: () => invoke("stop"), refreshPermissions: () => invoke("permissions"),
    pauseRecording: () => invoke("pause"), resumeRecording: () => invoke("continue"),
    refreshTranscriptionStatus: () => invoke("read"),
  };
  return { controller, sourceKind: "microphone", captureMode: "desktop_meeting", deactivate,
    resumePendingWork: () => invoke("resume"), releaseUploadedCapture: () => invoke("release") };
}

export function parseDesktopRecorderRequest(value: unknown): DesktopRecorderRequest {
  const data = exact(value, ["kind", "requestId", "recorderId"]);
  if (typeof data.kind !== "string" || !["read", "start", "stop", "pause", "continue", "permissions", "resume", "release", "deactivate"].includes(data.kind)
    || data.recorderId !== null && typeof data.recorderId !== "string") throw failure();
  return { kind: data.kind as DesktopRecorderCommand, requestId: uuid(data.requestId),
    recorderId: data.recorderId === null ? null : uuid(data.recorderId) };
}
/** Strict metadata allowlist. Legacy transcript fields must remain null here. */
export function parseDesktopRecorderState(value: unknown): DesktopRecorderState {
  const envelope = exact(value, ["recorderId", "revision", "snapshot"]);
  const snapshot = exact(envelope.snapshot, ["state", "statusCode", "sessionId", "recordedChunks", "queuedChunks", "elapsedSeconds",
    "remainingBudgetSeconds", "remainingAuthoritySeconds", "transcriptionStatus", "transcript", "desktop"]);
  const desktop = exact(snapshot.desktop, ["phase", "coverage", "trimmedStartMs", "trimmedEndMs"]);
  if (typeof snapshot.state !== "string" || !["idle", "preparing", "ready", "recording", "paused", "uploading", "processing", "complete", "error"].includes(snapshot.state)
    || typeof snapshot.statusCode !== "string" || !/^[a-z][a-z0-9_]{0,99}$/u.test(snapshot.statusCode)
    || snapshot.transcript !== null || snapshot.transcriptionStatus !== null
    || typeof desktop.phase !== "string" || !["ready", "permission_required", "starting", "recording", "stopping", "interrupted", "stop_unconfirmed", "stopped"].includes(desktop.phase)
    || typeof desktop.coverage !== "string" || !["not_started", "aligned", "complete", "incomplete"].includes(desktop.coverage)) throw failure();
  uuid(snapshot.sessionId); uuid(envelope.recorderId); number(envelope.revision);
  for (const key of ["recordedChunks", "queuedChunks", "elapsedSeconds"] as const) number(snapshot[key]);
  for (const key of ["remainingBudgetSeconds", "remainingAuthoritySeconds"] as const) if (snapshot[key] !== null) number(snapshot[key]);
  number(desktop.trimmedStartMs); if (desktop.trimmedEndMs !== null) number(desktop.trimmedEndMs);
  return structuredClone(value) as DesktopRecorderState;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw failure();
  return value as Record<string, unknown>;
}
function number(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 0) throw failure(); }
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) throw failure(); return value;
}
function failure(): Error { return new Error("Desktop recording command could not be confirmed."); }
