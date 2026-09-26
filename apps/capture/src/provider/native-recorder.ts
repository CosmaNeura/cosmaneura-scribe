import type { CaptureBff, CiphertextUploadTarget } from "../bff/contracts";
import { BffCaptureQueueTransport } from "../bff/queue-transport";
import type { PreparedProviderRecorder, ProviderRecorderSnapshot } from "../provider-binding";
import { CaptureQueue, QueueInvariantError, type CaptureQueueStorage } from "../queue";
import { parseInputSignal } from "../native/ios-input-signal";
import { isMicrophoneInput, type MicrophoneInput } from "../native/microphone-input";

export type NativeRecordingCommand = "read" | "start" | "pause" | "seal" | "close" | "input";
export interface NativeRecordingPort {
  open: (sessionId: string, requestId: string) => Promise<unknown>;
  command(this: void, request: { requestId: string; recorderId: string; kind: NativeRecordingCommand; input?: MicrophoneInput }): Promise<unknown>;
}
export interface NativeRecordingState {
  readonly version: 1; readonly revision: number; readonly recorderId: string; readonly sessionId: string;
  readonly phase: "unopened" | "opening" | "ready" | "starting" | "recording" | "pausing" | "paused"
    | "stopPending" | "sealing" | "sealed" | "failed" | "closed";
  readonly failure: "preparationFailed" | "startFailed" | "stopPending" | "recoveryFailed" | null;
  readonly busy: boolean; readonly recordedChunks: number; readonly recordedPlaintextBytes: number;
  readonly maximumPlaintextBytes: number; readonly input: MicrophoneInput; readonly signal: unknown;
  readonly completion: { readonly idempotencyKey: string; readonly leaseId: string; readonly leaseGeneration: number;
    readonly finalSequence: number } | null;
}

/** Keys/PCM/renewal remain native. This controller reuses only the ciphertext
 * queue uploader and the existing Core completion/review interface. */
export async function connectNativeProviderRecorder(options: {
  sessionId: string; port: NativeRecordingPort; bff: CaptureBff; queueStorage: CaptureQueueStorage;
  uploadTarget: CiphertextUploadTarget; signal: AbortSignal;
}): Promise<PreparedProviderRecorder> {
  const { sessionId, port, signal } = options;
  uuid(sessionId);
  let state: NativeRecordingState | null = null, closed = false, accepted = false, starting = false;
  let status: string | null = null, reading: Promise<void> | null = null, closing: Promise<void> | null = null;
  let uploading: Promise<void> | null = null;
  const listeners = new Set<(value: ProviderRecorderSnapshot) => void>();
  const queue = new CaptureQueue(options.queueStorage);
  const transport = new BffCaptureQueueTransport(options.bff, options.uploadTarget);
  const current = (): void => { if (closed || signal.aborted) throw failure(); };
  const snapshot = (): ProviderRecorderSnapshot => {
    if (!state) throw failure();
    const phase = state.phase, awaitingStart = starting && phase === "ready" || phase === "starting", paused = phase === "paused" || phase === "stopPending" || phase === "pausing";
    return { sessionId, state: accepted ? "processing" : phase === "sealed" || phase === "sealing" ? "uploading"
      : paused ? "paused" : phase === "recording" ? "recording" : phase === "ready" || phase === "starting" ? "ready"
      : phase === "opening" || phase === "unopened" ? "preparing" : "error",
    statusCode: status ?? (accepted ? "capture_processing" : awaitingStart ? "capture_starting"
      : phase === "pausing" ? "capture_stopping" : phase === "stopPending" ? "audio_capture_native_stop_failed"
      : phase === "sealed" ? "capture_upload_pending" : phase === "sealing" ? "capture_sealing"
      : phase === "recording" ? "capture_recording"
      : state.failure === "startFailed" ? "capture_start_failed" : phase === "paused" ? "capture_paused"
      : phase === "failed" ? "capture_preparation_failed" : phase === "closed" ? "capture_reopen_required" : "capture_ready"),
    recordedChunks: state.recordedChunks, queuedChunks: accepted ? 0 : state.recordedChunks,
    elapsedSeconds: Math.floor(Math.max(0, state.recordedPlaintextBytes - state.recordedChunks * 44) / 32_000),
    remainingBudgetSeconds: Math.floor((state.maximumPlaintextBytes - state.recordedPlaintextBytes) / 32_000),
    remainingAuthoritySeconds: null, transcriptionStatus: null, transcript: null,
    native: { phase: awaitingStart ? "starting" : phase, busy: state.busy } };
  };
  const publish = (): void => {
    if (!state || closed || signal.aborted) return;
    for (const listener of listeners) { try { listener(snapshot()); } catch { /* Observer isolation. */ } }
  };
  const accept = (value: unknown, requestId: string, close = false): boolean => {
    const response = exact(value, ["requestId", "ok", "recording"]);
    if (response.requestId !== requestId || typeof response.ok !== "boolean") throw failure();
    if (close) { if (response.recording !== null) throw failure(); }
    else {
      const next = parseNativeRecordingState(response.recording);
      if (next.sessionId !== sessionId || state && next.recorderId !== state.recorderId) throw failure();
      if (!state || next.revision > state.revision) { state = next; publish(); }
    }
    return response.ok;
  };
  const invoke = async (kind: NativeRecordingCommand, input?: MicrophoneInput): Promise<void> => {
    if (kind !== "close") current();
    if (!state) throw failure();
    const requestId = crypto.randomUUID();
    const ok = accept(await port.command({ requestId, recorderId: state.recorderId, kind,
      ...(input === undefined ? {} : { input }) }), requestId, kind === "close");
    if (kind !== "close") current();
    if (!ok) throw failure();
  };
  const read = (): Promise<void> => reading ??= invoke("read").finally(() => { reading = null; });
  const upload = (): Promise<void> => uploading ??= (async () => {
    current();
    status = "capture_uploading"; publish();
    try {
      if (state?.phase !== "sealed") await invoke("seal");
      current();
      const sealed = state;
      if (sealed?.phase !== "sealed" || !sealed.completion) throw failure();
      const completion = sealed.completion;
      const drained = await queue.drainOnce(transport); current();
      const records = await queue.listMetadata(); current();
      if (drained.items.some(item => item.outcome !== "registered")) throw failure();
      const positions = new Set<number>();
      for (const record of records) {
        const reservation = record.reservation;
        if (reservation.sessionId !== sessionId || reservation.channel !== "microphone"
          || positions.has(reservation.sequenceNumber)) throw failure();
        positions.add(reservation.sequenceNumber);
        if (reservation.sequenceNumber > completion.finalSequence) {
          if (record.state !== "reserved") throw failure();
          continue;
        }
        if (!["registered", "purged"].includes(record.state)
          || record.retry.upload.terminalCode !== null || record.retry.registration.terminalCode !== null) throw failure();
        if (record.state === "registered") await queue.purge(reservation.objectId);
        current();
      }
      for (let index = 0; index <= completion.finalSequence; index += 1) if (!positions.has(index)) throw failure();
      await options.bff.completeCapture(sessionId, { protocol_version: "1.0", capture_lease_id: completion.leaseId,
        capture_lease_generation: completion.leaseGeneration,
        channels: [{ channel: "microphone", final_sequence_number: completion.finalSequence }] },
      { idempotencyKey: completion.idempotencyKey });
      current(); accepted = true; status = null; publish();
    } catch (error) {
      status = state?.phase === "sealed" || state?.phase === "sealing" ? "capture_upload_pending"
        : state?.recordedChunks === 0 && state.phase === "paused" ? "capture_no_saved_audio" : null;
      publish(); throw error;
    }
  })().finally(() => { uploading = null; });
  const start = async (): Promise<void> => {
    current(); starting = true; status = null; publish();
    try { await invoke("start"); }
    catch (error) { await read().catch(() => { status = "capture_start_unconfirmed"; }); throw error; }
    finally { starting = false; publish(); }
  };
  const openingId = crypto.randomUUID();
  // Even an unsuccessful open returns its retained handle for explicit recovery
  // and close. Do not drop that ownership by throwing before the UI receives it.
  accept(await port.open(sessionId, openingId), openingId);
  if (!state) throw failure();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopPolling = (): void => { clearInterval(timer); timer = undefined; document.removeEventListener("visibilitychange", visible); };
  const visible = (): void => { if (document.visibilityState === "visible") void read().catch(() => undefined); };
  const deactivate = (): Promise<void> => {
    closed = true; stopPolling(); listeners.clear(); signal.removeEventListener("abort", aborted);
    return closing ??= invoke("close").catch(error => { closing = null; throw error; });
  };
  const aborted = (): void => { void deactivate().catch(() => undefined); };
  signal.addEventListener("abort", aborted, { once: true });
  if (!signal.aborted) {
    document.addEventListener("visibilitychange", visible);
    timer = setInterval(() => { void read().catch(() => undefined); }, 1000);
  }
  return { sourceKind: "microphone", captureMode: "native_microphone", deactivate,
    resumePendingWork: upload, releaseUploadedCapture: () => accepted ? Promise.resolve() : Promise.reject(failure()),
    controller: { get snapshot() { return snapshot(); }, subscribe: listener => {
      current(); listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener);
    }, startRecording: start, resumeRecording: start, pauseRecording: async () => {
      status = null; await invoke("pause"); publish();
    }, stopRecording: async () => {
      if (starting && state?.phase === "ready" || state?.phase === "starting") { status = null; await invoke("pause"); return; }
      await upload();
    }, selectMicrophoneInput: async input => { current(); if (state?.input !== input) await invoke("input", input); }, getCaptureSignal: async () => {
      await read(); return state!.signal;
    }, refreshTranscriptionStatus: read } };
}

export function parseNativeRecordingState(value: unknown): NativeRecordingState {
  const data = exact(value, ["version", "revision", "recorderId", "sessionId", "phase", "failure", "busy", "recordedChunks",
    "recordedPlaintextBytes", "maximumPlaintextBytes", "input", "completion", "signal"]);
  if (data.version !== 1 || !integer(data.revision, 1, Number.MAX_SAFE_INTEGER)
    || typeof data.phase !== "string" || !["unopened", "opening", "ready", "starting", "recording", "pausing", "paused", "stopPending", "sealing", "sealed", "failed", "closed"].includes(data.phase)
    || data.failure !== null && (typeof data.failure !== "string" || !["preparationFailed", "startFailed", "stopPending", "recoveryFailed"].includes(data.failure))
    || typeof data.busy !== "boolean" || !isMicrophoneInput(data.input)
    || !integer(data.recordedChunks, 0, 2048) || data.maximumPlaintextBytes !== 402_653_184
    || !integer(data.recordedPlaintextBytes, Number(data.recordedChunks) * 46,
      Math.min(402_653_184, Number(data.recordedChunks) * 320_044))) throw failure();
  uuid(data.recorderId); uuid(data.sessionId); parseInputSignal(data.signal);
  if (data.completion !== null) {
    const completion = exact(data.completion, ["idempotencyKey", "leaseId", "leaseGeneration", "finalSequence"]);
    uuid(completion.idempotencyKey); uuid(completion.leaseId);
    if (!integer(completion.leaseGeneration, 1, Number.MAX_SAFE_INTEGER)
      || !integer(completion.finalSequence, 0, 2047) || completion.finalSequence !== Number(data.recordedChunks) - 1) throw failure();
  } else if (data.phase === "sealed") throw failure();
  return structuredClone(data) as unknown as NativeRecordingState;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw failure();
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}
function uuid(value: unknown): void {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) throw failure();
}
function failure(): QueueInvariantError { return new QueueInvariantError("provider_native_recording_unconfirmed"); }
