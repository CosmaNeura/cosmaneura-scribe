import { AudioCaptureError } from "../../capture/src/audio/errors";
import type { CaptureSourceWindow } from "../../capture/src/capture/source";
import { captureSourceWindow } from "../../capture/src/native/capture-source-window";
import { Pcm16Chunker } from "../../capture/src/audio/pcm-chunker";
import { pcm16ToLittleEndianBytes } from "../../capture/src/audio/resampler";
import { NativePcmCaptureSource } from "../../capture/src/native/native-pcm-source";
import type { NativePcmBridge, NativePcmConfiguration, NativePcmPacket, NativePcmSession,
  NativePcmSink, NativePcmStopResult } from "../../capture/src/native/native-pcm-bridge";
import type { DesktopPCMCoverage, DesktopPCMDriver, DesktopPCMDriverSession,
  DesktopPCMFailure, DesktopPCMPacket, DesktopPCMStart, DesktopPCMCompletion, DesktopInputSignal } from "./native-pcm-driver.js";

/** Main-process source for the existing CaptureFlowController. The same WAV,
 * encryption, reservations and durable upload protocol handle the mixed audio.
 * The owner must durably retain coverage and present incomplete coverage; it is
 * not inferred from chunk counts. This constructor starts no source or service.
 */
export class DesktopPcmCaptureSource extends NativePcmCaptureSource {
  public constructor(driver: DesktopPCMDriver, persistCoverage: (coverage: DesktopPCMCoverage) => Promise<void>,
    inputSignal?: (value: DesktopInputSignal | null) => void, capturedFrames?: (frames: number) => void) {
    requireMainProcess();
    super(new DesktopChunkBridge(driver, persistCoverage, inputSignal, capturedFrames), "mixed");
  }
}

class DesktopChunkBridge implements NativePcmBridge {
  readonly deliversDuringDrain = true as const;
  readonly supportsRenewal = true as const;
  readonly checksAvailabilityOnStart?: true;
  constructor(private readonly driver: DesktopPCMDriver,
    private readonly persistCoverage: (coverage: DesktopPCMCoverage) => Promise<void>,
    private readonly inputSignal?: (value: DesktopInputSignal | null) => void,
    private readonly capturedFrames?: (frames: number) => void) {
    if (driver.checksAvailabilityOnStart === true) this.checksAvailabilityOnStart = true;
  }

  getAvailability(): Promise<boolean> { requireMainProcess(); return this.driver.getAvailability(); }

  start(configuration: NativePcmConfiguration, sink: NativePcmSink): NativePcmSession {
    requireMainProcess();
    this.inputSignal?.(null);
    let maximumFrames = configuration.maximumChunks * configuration.targetFramesPerChunk;
    let window = configuration.window ? captureSourceWindow(configuration.window, configuration.maximumChunks) : undefined;
    if (!Number.isSafeInteger(maximumFrames) || maximumFrames < 1 || maximumFrames > 1_382_400_000
      || configuration.targetFramesPerChunk > 960_000) throw failure();
    const chunker = new Pcm16Chunker({ targetFramesPerChunk: configuration.targetFramesPerChunk,
      maximumChunks: configuration.maximumChunks,
      ...(window ? { hardMaximumChunks: window.hardMaximumChunks } : {}) });
    let start: DesktopPCMStart | undefined;
    let active = false, closed = false, discard = false, notified = false, receiving = false, extending = false, stopping = false;
    let receivedFrames = 0, sequence = 0;
    let pendingPacket: Promise<void> = Promise.resolve();

    const terminal = (code: DesktopPCMFailure): void => {
      if (closed || notified) return;
      notified = true; discard = true; chunker.discard();
      if (code === "device_changed") sink.onInterruption("audio_device_disconnected");
      else if (code === "session_locked") sink.onInterruption("capture_backgrounded");
      else sink.onError(code === "permission_required" ? "permission_revoked"
        : code === "clock_discontinuity" || code === "overflow" ? "stalled" : "failed");
    };
    const send = async (samples: Int16Array<ArrayBuffer>): Promise<void> => {
      let bytes: Uint8Array<ArrayBuffer> | undefined;
      try {
        if (discard || closed) return;
        bytes = pcm16ToLittleEndianBytes(samples);
        await sink.onPcmPacket({ sequenceNumber: sequence++, pcmBytes: bytes });
      } finally { samples.fill(0); bytes?.fill(0); }
    };
    const receive = (packet: DesktopPCMPacket): Promise<void> => {
      if (closed || discard) { clearPacket(packet); return Promise.reject(failure()); }
      if (!active || receiving) {
        clearPacket(packet); terminal("failed"); return Promise.reject(failure());
      }
      receiving = true;
      const work = (async () => {
        let samples: Int16Array<ArrayBuffer> | undefined;
        let chunks: readonly Int16Array<ArrayBuffer>[] = [];
        try {
          const bytes = requirePacket(packet, receivedFrames, maximumFrames);
          samples = new Int16Array(bytes.byteLength / 2);
          const view = new DataView(bytes.buffer);
          for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
          chunks = chunker.push(samples);
          receivedFrames += samples.length;
          // Count the accepted mixed stream once, before ten-second WAV commits.
          // This is elapsed capture feedback, never persistence or upload proof.
          try { this.capturedFrames?.(receivedFrames); } catch { /* Observer isolation. */ }
          for (const chunk of chunks) await send(chunk);
        } catch {
          terminal("failed"); throw failure();
        } finally {
          samples?.fill(0); chunks.forEach(chunk => chunk.fill(0)); clearPacket(packet);
        }
      })().finally(() => { receiving = false; });
      pendingPacket = work.catch(() => undefined);
      return work;
    };
    const authorization = (value: CaptureSourceWindow) => ({ runId: value.runId, generation: value.generation,
      expiresAtMilliseconds: value.expiresAtMilliseconds, maximumOutputFrames: value.maximumChunks * configuration.targetFramesPerChunk,
      hardMaximumOutputFrames: value.hardMaximumChunks * configuration.targetFramesPerChunk });
    const native: DesktopPCMDriverSession = this.driver.start({ maximumOutputFrames: maximumFrames, sampleRateHz: 16_000,
      ...(window ? { authorization: authorization(window) } : {}) }, {
      onPcmPacket: receive, onFailure: terminal, onInputSignal: value => {
        if (active && !closed && !discard && !stopping) this.inputSignal?.(value);
      },
    });

    const ready = native.ready.then(async value => {
      if (discard || closed) throw failure();
      start = parseDesktopPCMStart(value);
      await this.persistCoverage({ phase: "started", value: start });
      if (discard || closed) throw failure();
    });
    // Cancellation can close the handle before the shared source starts awaiting
    // ready. Observe rejection now while preserving it for every actual awaiter.
    void ready.catch(() => undefined);
    const stop = (options: { readonly mode: "drain" | "discard" }): Promise<NativePcmStopResult> => {
      stopping = true; this.inputSignal?.(null);
      if (closed) return Promise.resolve({ finalPcmPacket: null });
      if (options.mode === "discard") { discard = true; chunker.discard(); }
      // The shared native lifecycle coalesces normal stop and owns the one
      // discard upgrade. Keep their separate native outcomes so a successful
      // discard can confirm closure even when the earlier drain rejects.
      return (async (): Promise<NativePcmStopResult> => {
        let final: NativePcmPacket | null = null;
        try {
          const requestedMode = discard ? "discard" : "drain";
          const completion = await native.stop({ mode: requestedMode });
          await pendingPacket;
          if (discard) {
            if (requestedMode === "discard" && completion !== null) throw failure();
            chunker.discard(); closed = true; active = false;
            return { finalPcmPacket: null };
          }
          if (!start || completion === null) throw failure();
          const verified = parseDesktopPCMCompletion(completion, start, receivedFrames);
          await this.persistCoverage({ phase: "stopped", value: verified });
          if (discard) {
            chunker.discard(); closed = true; active = false;
            return { finalPcmPacket: null };
          }
          const tail = chunker.finish();
          if (tail) {
            try { final = { sequenceNumber: sequence++, pcmBytes: pcm16ToLittleEndianBytes(tail) }; }
            finally { tail.fill(0); }
          }
          closed = true; active = false;
          return { finalPcmPacket: final };
        } catch {
          if (final) clearPacket(final);
          // Unconfirmed native closure retains the same driver session. Future
          // retries discard; an uncertain interval cannot become a normal tail.
          discard = true; active = false; chunker.discard();
          throw new AudioCaptureError("audio_capture_native_stop_failed");
        }
      })();
    };
    return { ready, extend: async (value: CaptureSourceWindow) => {
      if (!window || !native.extend || !active || closed || discard || stopping || extending) throw failure();
      const next = captureSourceWindow(value, value.maximumChunks, window);
      extending = true;
      try {
        chunker.extend(next.maximumChunks);
        maximumFrames = next.maximumChunks * configuration.targetFramesPerChunk;
        await native.extend(authorization(next));
        if (!active || closed || discard || stopping) throw failure();
        window = next;
      } catch (error) { if (!stopping) terminal("failed"); throw error; }
      finally { extending = false; }
    }, activate: () => {
      if (!start || discard || closed || active) throw failure();
      active = true; native.activate();
    }, stop };
  }
}

function requireMainProcess(): void {
  if (typeof process === "undefined" || !process.versions.node || typeof window !== "undefined"
    || "type" in process && process.type === "renderer") throw new AudioCaptureError("audio_capture_unavailable");
}
function failure(): AudioCaptureError { return new AudioCaptureError("audio_capture_native_protocol_error"); }
function requirePacket(packet: DesktopPCMPacket, next: number, maximum: number): Uint8Array<ArrayBuffer> {
  if (!packet || !Number.isSafeInteger(packet.firstFrame) || packet.firstFrame !== next) throw failure();
  const bytes = packet.pcmBytes;
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0
    || bytes.byteLength !== bytes.buffer.byteLength || bytes.byteLength < 2 || bytes.byteLength > 8192
    || bytes.byteLength % 2 || next + bytes.byteLength / 2 > maximum) throw failure();
  return bytes;
}
function clearPacket(packet: { readonly pcmBytes?: unknown }): void {
  if (packet?.pcmBytes instanceof Uint8Array) {
    try { new Uint8Array(packet.pcmBytes.buffer).fill(0); } catch { /* Already detached. */ }
  }
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw failure();
  return value as Record<string, unknown>;
}
function nanoseconds(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/u.test(value)
    || BigInt(value) > 18_446_744_073_709_551_615n) throw failure();
  return value;
}
export function parseDesktopPCMStart(value: unknown): DesktopPCMStart {
  const data = object(value, ["hostTimeNanoseconds", "microphonePrerollNanoseconds", "systemPrerollNanoseconds"]);
  const start = Object.freeze({ hostTimeNanoseconds: nanoseconds(data.hostTimeNanoseconds),
    microphonePrerollNanoseconds: nanoseconds(data.microphonePrerollNanoseconds),
    systemPrerollNanoseconds: nanoseconds(data.systemPrerollNanoseconds) });
  if (start.hostTimeNanoseconds === "0" || start.microphonePrerollNanoseconds !== "0"
    && start.systemPrerollNanoseconds !== "0") throw failure();
  return start;
}
export function parseDesktopPCMCompletion(value: unknown, start: DesktopPCMStart, frames: number): DesktopPCMCompletion {
  const data = object(value, ["start", "endHostTimeNanoseconds", "outputFrames",
    "microphoneTailNanoseconds", "systemTailNanoseconds"]);
  const receivedStart = parseDesktopPCMStart(data.start);
  if (JSON.stringify(receivedStart) !== JSON.stringify(start) || !Number.isSafeInteger(data.outputFrames)
    || data.outputFrames !== frames || frames < 1) throw failure();
  const end = nanoseconds(data.endHostTimeNanoseconds);
  const duration = BigInt(end) - BigInt(start.hostTimeNanoseconds);
  if (duration <= 0n || (duration + 62_499n) / 62_500n !== BigInt(frames)) throw failure();
  const microphoneTail = nanoseconds(data.microphoneTailNanoseconds), systemTail = nanoseconds(data.systemTailNanoseconds);
  if (microphoneTail !== "0" && systemTail !== "0") throw failure();
  return Object.freeze({ start: receivedStart, endHostTimeNanoseconds: end, outputFrames: frames,
    microphoneTailNanoseconds: microphoneTail, systemTailNanoseconds: systemTail });
}
