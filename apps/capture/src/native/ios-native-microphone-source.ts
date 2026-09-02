import { AudioCaptureError } from "../audio/errors";
import type {
  CapturedWavChunk,
  CaptureSource,
  CaptureSourceErrorCode,
  CaptureSourceInterruptionCode,
  CaptureSourceStartOptions,
  Pcm16WavProfile,
} from "../capture";
import {
  encodePcm16MonoWav,
  pcm16WavProfile,
  targetFrameCount,
} from "../capture";
import {
  IOS_NATIVE_PCM_FORMAT,
  IosNativeMicrophoneBridgeError,
  type IosNativeMicrophoneBridge,
  type IosNativeMicrophoneInterruptionCode,
  type IosNativeMicrophoneTerminalErrorCode,
  type IosNativePcmConfiguration,
  type IosNativePcmPacket,
} from "./ios-native-pcm-bridge";

interface CaptureBounds {
  readonly maximumChunks: number;
  readonly profile: Pcm16WavProfile;
  readonly targetFramesPerChunk: number;
}

/**
 * Dormant adapter from an injected iOS PCM bridge to the existing WAV source.
 * No runtime factory imports or selects this class.
 */
export class IosNativeMicrophoneCaptureSource implements CaptureSource {
  public readonly kind = "microphone" as const;

  readonly #bridge: IosNativeMicrophoneBridge;
  #abortHandler: (() => void) | undefined;
  #abortSignal: AbortSignal | undefined;
  #bridgeStartAttempted = false;
  #deliveryInFlight = false;
  #deliveredChunks = 0;
  #expectedSequenceNumber = 0;
  #maximumChunks = 0;
  #onChunk: ((chunk: CapturedWavChunk) => Promise<void>) | undefined;
  #onError: ((code: CaptureSourceErrorCode) => void) | undefined;
  #onInterruption: ((code: CaptureSourceInterruptionCode) => void) | undefined;
  #pendingDelivery: Promise<void> = Promise.resolve();
  #profile: Pcm16WavProfile | undefined;
  #shutdownPromise: Promise<void> | undefined;
  #state: "idle" | "starting" | "active" | "stopping" = "idle";
  #targetFramesPerChunk = 0;
  #terminal = false;
  #terminalFailure: AudioCaptureError | undefined;

  public constructor(bridge: IosNativeMicrophoneBridge) {
    this.#bridge = bridge;
  }

  public async start(options: CaptureSourceStartOptions): Promise<void> {
    if (this.#state !== "idle") {
      throw new AudioCaptureError("audio_capture_already_active");
    }
    if (isAborted(options.signal)) throw abortError();

    this.#resetForStart();
    this.#state = "starting";
    try {
      const bounds = captureBounds(options);
      await this.#requireForeground();
      if (isAborted(options.signal)) throw abortError();

      this.#maximumChunks = bounds.maximumChunks;
      this.#onChunk = options.onChunk;
      this.#onError = options.onError;
      this.#onInterruption = options.onInterruption;
      this.#profile = bounds.profile;
      this.#targetFramesPerChunk = bounds.targetFramesPerChunk;
      this.#addAbortHandler(options.signal);

      const configuration: IosNativePcmConfiguration = {
        ...IOS_NATIVE_PCM_FORMAT,
        targetFramesPerChunk: bounds.targetFramesPerChunk,
        maximumChunks: bounds.maximumChunks,
      };
      this.#bridgeStartAttempted = true;
      await this.#bridge.start(configuration, {
        onPcmPacket: (packet) => this.#receivePcmPacket(packet),
        onInterruption: (code) => this.#receiveInterruption(code),
        onError: (code) => this.#receiveTerminalError(code),
      });
      if (isAborted(options.signal)) throw abortError();
      if (this.#state !== "starting" || this.#terminal) {
        throw this.#terminalFailure ?? new AudioCaptureError("audio_capture_unavailable");
      }
      this.#state = "active";
      await this.#requireForeground();
      if (isAborted(options.signal)) throw abortError();
      if (this.#state !== "active" || this.#terminal) {
        throw this.#terminalFailure ?? new AudioCaptureError("audio_capture_unavailable");
      }
    } catch (error) {
      const failure = isAbortError(error) ? error : sanitizeStartFailure(error);
      await this.#shutdown().catch(() => undefined);
      throw failure;
    }
  }

  public async stop(): Promise<void> {
    await this.#shutdown();
  }

  async #requireForeground(): Promise<void> {
    let state: unknown;
    try {
      state = await this.#bridge.getAppState();
    } catch {
      throw new AudioCaptureError("audio_capture_unavailable");
    }
    if (state !== "foreground") {
      throw new AudioCaptureError("audio_capture_unavailable");
    }
  }

  #addAbortHandler(signal: AbortSignal | undefined): void {
    if (signal === undefined) return;
    this.#abortSignal = signal;
    this.#abortHandler = () => {
      void this.#shutdown().catch(() => undefined);
    };
    signal.addEventListener("abort", this.#abortHandler, { once: true });
  }

  #receivePcmPacket(packet: IosNativePcmPacket): Promise<void> {
    if (this.#terminal || this.#state === "idle" || this.#state === "stopping") {
      zeroPacket(packet);
      return Promise.resolve();
    }
    if (this.#state !== "active") {
      zeroPacket(packet);
      const failure = new AudioCaptureError("audio_capture_native_protocol_error");
      this.#failWithError(failure, "capture_source_stalled");
      return Promise.reject(failure);
    }
    if (this.#deliveryInFlight) {
      zeroPacket(packet);
      const failure = new AudioCaptureError("audio_capture_native_protocol_error");
      this.#failWithError(failure, "capture_source_stalled");
      return Promise.reject(failure);
    }

    this.#deliveryInFlight = true;
    const delivery = this.#deliverPcmPacket(packet).finally(() => {
      this.#deliveryInFlight = false;
    });
    this.#pendingDelivery = delivery.catch(() => undefined);
    void delivery.catch((error: unknown) => {
      const failure = sanitizePacketFailure(error);
      this.#failWithError(failure, packetFailureSignal(failure));
    });
    return delivery;
  }

  async #deliverPcmPacket(packet: IosNativePcmPacket): Promise<void> {
    try {
      const pcmBytes = requirePcmBytes(packet);
      const sequenceNumber = requireSequenceNumber(packet);
      if (sequenceNumber !== this.#expectedSequenceNumber) {
        throw new AudioCaptureError("audio_capture_native_protocol_error");
      }
      if (this.#deliveredChunks >= this.#maximumChunks) {
        throw new AudioCaptureError("audio_capture_output_limit_exceeded");
      }
      if (
        pcmBytes.byteLength < Int16Array.BYTES_PER_ELEMENT ||
        pcmBytes.byteLength % Int16Array.BYTES_PER_ELEMENT !== 0
      ) {
        throw new AudioCaptureError("audio_capture_native_protocol_error");
      }
      const frameCount = pcmBytes.byteLength / Int16Array.BYTES_PER_ELEMENT;
      if (frameCount > this.#targetFramesPerChunk) {
        throw new AudioCaptureError("audio_capture_output_limit_exceeded");
      }

      const samples = decodeLittleEndianPcm16(pcmBytes);
      let wavBytes: Uint8Array<ArrayBuffer>;
      try {
        wavBytes = encodePcm16MonoWav(samples, this.#requireProfile());
      } finally {
        samples.fill(0);
      }

      this.#expectedSequenceNumber += 1;
      this.#deliveredChunks += 1;
      const chunk: CapturedWavChunk = {
        sequenceNumber,
        durationMs: frameCount * 1_000 / IOS_NATIVE_PCM_FORMAT.sampleRateHz,
        wavBytes,
      };
      try {
        await this.#requireOnChunk()(chunk);
      } catch {
        throw new AudioCaptureError("audio_capture_callback_failed");
      } finally {
        wavBytes.fill(0);
      }
    } finally {
      zeroPacket(packet);
    }
  }

  #receiveInterruption(code: IosNativeMicrophoneInterruptionCode): void {
    const mapped = mapInterruption(code);
    if (mapped === undefined) {
      this.#failWithError(
        new AudioCaptureError("audio_capture_native_protocol_error"),
        "capture_source_failed",
      );
      return;
    }
    this.#fail(
      () => this.#onInterruption?.(mapped),
      new AudioCaptureError("audio_capture_unavailable"),
    );
  }

  #receiveTerminalError(code: IosNativeMicrophoneTerminalErrorCode): void {
    const mapped = mapTerminalError(code);
    if (mapped === undefined) {
      this.#failWithError(
        new AudioCaptureError("audio_capture_native_protocol_error"),
        "capture_source_failed",
      );
      return;
    }
    this.#failWithError(new AudioCaptureError(mapped.failure), mapped.signal);
  }

  #failWithError(error: AudioCaptureError, code: CaptureSourceErrorCode): void {
    this.#fail(() => this.#onError?.(code), error);
  }

  #fail(notify: () => void, error: AudioCaptureError): void {
    if (this.#terminal || (this.#state !== "starting" && this.#state !== "active")) return;
    this.#terminal = true;
    this.#terminalFailure = error;
    try {
      notify();
    } catch {
      // The source is terminal; notification code cannot reopen native capture.
    }
    void this.#shutdown().catch(() => undefined);
  }

  #shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    if (this.#state === "idle") return Promise.resolve();
    this.#state = "stopping";
    this.#shutdownPromise = this.#performShutdown().finally(() => {
      this.#state = "idle";
      this.#shutdownPromise = undefined;
    });
    return this.#shutdownPromise;
  }

  async #performShutdown(): Promise<void> {
    let stopFailed = false;
    if (this.#bridgeStartAttempted) {
      try {
        await this.#bridge.stop();
      } catch {
        stopFailed = true;
      }
    }
    await this.#pendingDelivery;
    this.#removeAbortHandler();
    this.#bridgeStartAttempted = false;
    this.#deliveryInFlight = false;
    this.#maximumChunks = 0;
    this.#onChunk = undefined;
    this.#onError = undefined;
    this.#onInterruption = undefined;
    this.#profile = undefined;
    this.#targetFramesPerChunk = 0;
    if (stopFailed) throw new AudioCaptureError("audio_capture_unavailable");
  }

  #removeAbortHandler(): void {
    if (this.#abortSignal !== undefined && this.#abortHandler !== undefined) {
      this.#abortSignal.removeEventListener("abort", this.#abortHandler);
    }
    this.#abortHandler = undefined;
    this.#abortSignal = undefined;
  }

  #requireOnChunk(): (chunk: CapturedWavChunk) => Promise<void> {
    if (this.#onChunk === undefined) {
      throw new AudioCaptureError("audio_capture_unavailable");
    }
    return this.#onChunk;
  }

  #requireProfile(): Pcm16WavProfile {
    if (this.#profile === undefined) {
      throw new AudioCaptureError("audio_capture_unavailable");
    }
    return this.#profile;
  }

  #resetForStart(): void {
    this.#bridgeStartAttempted = false;
    this.#deliveryInFlight = false;
    this.#deliveredChunks = 0;
    this.#expectedSequenceNumber = 0;
    this.#maximumChunks = 0;
    this.#pendingDelivery = Promise.resolve();
    this.#shutdownPromise = undefined;
    this.#targetFramesPerChunk = 0;
    this.#terminal = false;
    this.#terminalFailure = undefined;
  }
}

function captureBounds(options: CaptureSourceStartOptions): CaptureBounds {
  let profile: Pcm16WavProfile;
  let targetFramesPerChunk: number;
  try {
    profile = pcm16WavProfile(options.capabilities);
    targetFramesPerChunk = targetFrameCount(profile);
  } catch {
    throw new AudioCaptureError("audio_capture_invalid_configuration");
  }
  if (
    profile.sampleRateHz !== IOS_NATIVE_PCM_FORMAT.sampleRateHz ||
    profile.channels !== IOS_NATIVE_PCM_FORMAT.channels ||
    !Number.isSafeInteger(options.capabilities.max_chunks) ||
    options.capabilities.max_chunks < 1 ||
    !Number.isSafeInteger(options.capabilities.remaining_aggregate_plaintext_bytes) ||
    options.capabilities.remaining_aggregate_plaintext_bytes < 0
  ) {
    throw new AudioCaptureError("audio_capture_invalid_configuration");
  }
  const maximumChunks = Math.min(
    options.capabilities.max_chunks,
    Math.floor(
      options.capabilities.remaining_aggregate_plaintext_bytes /
        profile.maxEnvelopeBytes,
    ),
  );
  if (maximumChunks < 1) {
    throw new AudioCaptureError("audio_capture_invalid_configuration");
  }
  return { maximumChunks, profile, targetFramesPerChunk };
}

function requirePcmBytes(packet: unknown): Uint8Array<ArrayBuffer> {
  if (typeof packet !== "object" || packet === null || !("pcmBytes" in packet)) {
    throw new AudioCaptureError("audio_capture_native_protocol_error");
  }
  const pcmBytes: unknown = packet.pcmBytes;
  if (!(pcmBytes instanceof Uint8Array) || !(pcmBytes.buffer instanceof ArrayBuffer)) {
    throw new AudioCaptureError("audio_capture_native_protocol_error");
  }
  return pcmBytes as Uint8Array<ArrayBuffer>;
}

function requireSequenceNumber(packet: unknown): number {
  if (typeof packet !== "object" || packet === null || !("sequenceNumber" in packet)) {
    throw new AudioCaptureError("audio_capture_native_protocol_error");
  }
  const sequenceNumber: unknown = packet.sequenceNumber;
  if (!Number.isSafeInteger(sequenceNumber) || (sequenceNumber as number) < 0) {
    throw new AudioCaptureError("audio_capture_native_protocol_error");
  }
  return sequenceNumber as number;
}

function decodeLittleEndianPcm16(
  pcmBytes: Uint8Array<ArrayBuffer>,
): Int16Array<ArrayBuffer> {
  const samples = new Int16Array(
    new ArrayBuffer(pcmBytes.byteLength),
  );
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * Int16Array.BYTES_PER_ELEMENT, true);
  }
  return samples;
}

function zeroPacket(packet: unknown): void {
  if (typeof packet !== "object" || packet === null || !("pcmBytes" in packet)) return;
  const pcmBytes: unknown = packet.pcmBytes;
  if (!(pcmBytes instanceof Uint8Array)) return;
  try {
    pcmBytes.fill(0);
  } catch {
    // Detached or otherwise invalid native buffers cannot be recovered here.
  }
}

function mapInterruption(
  code: IosNativeMicrophoneInterruptionCode,
): CaptureSourceInterruptionCode | undefined {
  switch (code) {
    case "ios_audio_session_interrupted":
      return "audio_session_interrupted";
    case "ios_audio_route_changed":
      return "audio_route_changed";
    case "ios_capture_backgrounded":
      return "capture_backgrounded";
    default:
      return undefined;
  }
}

function mapTerminalError(code: IosNativeMicrophoneTerminalErrorCode):
  | {
      readonly failure: "audio_capture_permission_denied" | "audio_capture_unavailable";
      readonly signal: CaptureSourceErrorCode;
    }
  | undefined {
  switch (code) {
    case "ios_microphone_permission_revoked":
      return {
        failure: "audio_capture_permission_denied",
        signal: "capture_source_failed",
      };
    case "ios_capture_stalled":
      return {
        failure: "audio_capture_unavailable",
        signal: "capture_source_stalled",
      };
    case "ios_capture_failed":
      return {
        failure: "audio_capture_unavailable",
        signal: "capture_source_failed",
      };
    default:
      return undefined;
  }
}

function sanitizeStartFailure(error: unknown): AudioCaptureError {
  if (error instanceof AudioCaptureError) return error;
  if (!(error instanceof IosNativeMicrophoneBridgeError)) {
    return new AudioCaptureError("audio_capture_unavailable");
  }
  switch (error.code) {
    case "ios_microphone_permission_denied":
    case "ios_microphone_permission_restricted":
      return new AudioCaptureError("audio_capture_permission_denied");
    case "ios_microphone_unavailable":
      return new AudioCaptureError("audio_capture_device_unavailable");
    case "ios_capture_not_foreground":
    case "ios_capture_start_failed":
      return new AudioCaptureError("audio_capture_unavailable");
    default:
      return new AudioCaptureError("audio_capture_unavailable");
  }
}

function sanitizePacketFailure(error: unknown): AudioCaptureError {
  return error instanceof AudioCaptureError
    ? error
    : new AudioCaptureError("audio_capture_native_protocol_error");
}

function packetFailureSignal(error: AudioCaptureError): CaptureSourceErrorCode {
  return error.code === "audio_capture_native_protocol_error" ||
    error.code === "audio_capture_output_limit_exceeded"
    ? "capture_source_stalled"
    : "capture_source_failed";
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error &&
    error.name === "AbortError";
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortError(): DOMException {
  return new DOMException("capture start was cancelled", "AbortError");
}
