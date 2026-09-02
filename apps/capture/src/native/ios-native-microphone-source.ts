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
  type IosNativeMicrophoneSession,
  type IosNativeMicrophoneStopMode,
  type IosNativeMicrophoneStopResult,
  type IosNativeMicrophoneTerminalErrorCode,
  type IosNativePcmConfiguration,
  type IosNativePcmPacket,
} from "./ios-native-pcm-bridge";

interface CaptureBounds {
  readonly maximumChunks: number;
  readonly profile: Pcm16WavProfile;
  readonly targetFramesPerChunk: number;
}

type CaptureRunPhase =
  | "checking_foreground"
  | "starting_native"
  | "active"
  | "closing"
  | "close_failed"
  | "closed";

interface CaptureRun {
  readonly generation: number;
  phase: CaptureRunPhase;
  cancelReason: "abort" | "stop" | "terminal" | undefined;
  stopMode: IosNativeMicrophoneStopMode | undefined;
  terminalFailure: AudioCaptureError | undefined;
  stopFailureNotified: boolean;
  abortHandler: (() => void) | undefined;
  abortSignal: AbortSignal | undefined;
  readonly startupCancellation: ReturnType<typeof deferred<void>>;
  nativeHandlePromise: Promise<IosNativeMicrophoneSession> | undefined;
  nativeSession: IosNativeMicrophoneSession | undefined;
  closePromise: Promise<void> | undefined;
  deliveryInFlight: boolean;
  pendingDelivery: Promise<void>;
  deliveredChunks: number;
  expectedSequenceNumber: number;
  readonly maximumChunks: number;
  readonly targetFramesPerChunk: number;
  readonly profile: Pcm16WavProfile;
  onChunk: ((chunk: CapturedWavChunk) => Promise<void>) | undefined;
  onError: ((code: CaptureSourceErrorCode) => void) | undefined;
  onInterruption: ((code: CaptureSourceInterruptionCode) => void) | undefined;
}

/**
 * Dormant adapter from an injected iOS PCM bridge to the existing WAV source.
 * No runtime factory imports or selects this class.
 */
export class IosNativeMicrophoneCaptureSource implements CaptureSource {
  public readonly kind = "microphone" as const;

  readonly #bridge: IosNativeMicrophoneBridge;
  #generation = 0;
  #run: CaptureRun | undefined;

  public constructor(bridge: IosNativeMicrophoneBridge) {
    this.#bridge = bridge;
  }

  public async start(options: CaptureSourceStartOptions): Promise<void> {
    if (this.#run !== undefined) {
      throw new AudioCaptureError(
        this.#run.phase === "close_failed"
          ? "audio_capture_native_stop_failed"
          : "audio_capture_already_active",
      );
    }
    if (isAborted(options.signal)) throw abortError();

    const bounds = captureBounds(options);
    const run = this.#createRun(options, bounds);
    this.#run = run;
    this.#addAbortHandler(run, options.signal);

    let appState: unknown;
    try {
      this.#assertStartingRun(run, "checking_foreground");
      appState = await this.#bridge.getAppState();
      this.#assertStartingRun(run, "checking_foreground");
    } catch (error) {
      if (this.#isCurrentRun(run) && run.phase === "checking_foreground") {
        this.#finalizeRun(run);
      }
      throw startFailureFor(run, error);
    }
    if (appState !== "foreground") {
      this.#finalizeRun(run);
      throw new AudioCaptureError("audio_capture_unavailable");
    }

    this.#assertStartingRun(run, "checking_foreground");
    run.phase = "starting_native";
    const configuration: IosNativePcmConfiguration = {
      ...IOS_NATIVE_PCM_FORMAT,
      targetFramesPerChunk: bounds.targetFramesPerChunk,
      maximumChunks: bounds.maximumChunks,
    };
    const generation = run.generation;
    this.#assertStartingRun(run, "starting_native");
    const nativeHandle = deferred<IosNativeMicrophoneSession>();
    run.nativeHandlePromise = nativeHandle.promise;
    try {
      nativeHandle.resolve(this.#bridge.start(configuration, {
        onPcmPacket: (packet) => this.#receivePcmPacket(run, generation, packet),
        onInterruption: (code) => this.#receiveInterruption(run, generation, code),
        onError: (code) => this.#receiveTerminalError(run, generation, code),
      }));
    } catch (error) {
      nativeHandle.reject(error);
    }

    let nativeSession: IosNativeMicrophoneSession;
    try {
      nativeSession = await nativeHandle.promise;
    } catch (error) {
      if (this.#isCurrentRun(run) && run.phase === "starting_native") {
        run.nativeHandlePromise = undefined;
        this.#finalizeRun(run);
      } else if (run.closePromise !== undefined) {
        await run.closePromise;
      }
      throw startFailureFor(run, error);
    }

    if (!this.#isCurrentRun(run) || run.phase !== "starting_native") {
      if (run.closePromise !== undefined) await run.closePromise;
      throw startFailureFor(run, abortError());
    }
    run.nativeHandlePromise = undefined;
    run.nativeSession = nativeSession;
    try {
      await Promise.race([nativeSession.ready, run.startupCancellation.promise]);
      this.#assertStartingRun(run, "starting_native");
    } catch (error) {
      if (!this.#isCurrentRun(run) || run.phase !== "starting_native") {
        if (run.closePromise !== undefined) await run.closePromise;
        throw startFailureFor(run, error);
      }
      this.#assertStartingRun(run, "starting_native");
      const failure = sanitizeStartFailure(error);
      run.terminalFailure = failure;
      run.cancelReason = "terminal";
      await this.#requestClose(run, "discard");
      throw failure;
    }
    run.phase = "active";
  }

  public async stop(): Promise<void> {
    const run = this.#run;
    if (run === undefined) return;
    const mode = run.stopMode ??
      (run.phase === "active" && run.terminalFailure === undefined ? "drain" : "discard");
    if (run.cancelReason === undefined) run.cancelReason = "stop";
    await this.#requestClose(run, mode);
  }

  #createRun(options: CaptureSourceStartOptions, bounds: CaptureBounds): CaptureRun {
    this.#generation += 1;
    return {
      generation: this.#generation,
      phase: "checking_foreground",
      cancelReason: undefined,
      stopMode: undefined,
      terminalFailure: undefined,
      stopFailureNotified: false,
      abortHandler: undefined,
      abortSignal: undefined,
      startupCancellation: deferred<void>(),
      nativeHandlePromise: undefined,
      nativeSession: undefined,
      closePromise: undefined,
      deliveryInFlight: false,
      pendingDelivery: Promise.resolve(),
      deliveredChunks: 0,
      expectedSequenceNumber: 0,
      maximumChunks: bounds.maximumChunks,
      targetFramesPerChunk: bounds.targetFramesPerChunk,
      profile: bounds.profile,
      onChunk: options.onChunk,
      onError: options.onError,
      onInterruption: options.onInterruption,
    };
  }

  #addAbortHandler(run: CaptureRun, signal: AbortSignal | undefined): void {
    if (signal === undefined) return;
    run.abortSignal = signal;
    run.abortHandler = () => {
      if (!this.#isCurrentRun(run)) return;
      run.cancelReason = "abort";
      void this.#requestClose(run, "discard").catch(() => undefined);
    };
    signal.addEventListener("abort", run.abortHandler, { once: true });
  }

  #receivePcmPacket(
    run: CaptureRun,
    generation: number,
    packet: IosNativePcmPacket,
  ): Promise<void> {
    if (!this.#isCurrentGeneration(run, generation)) {
      zeroPacket(packet);
      return Promise.reject(new AudioCaptureError("audio_capture_stale_generation"));
    }
    if (run.phase !== "active" || run.terminalFailure !== undefined) {
      zeroPacket(packet);
      const failure = new AudioCaptureError("audio_capture_native_protocol_error");
      this.#markTerminal(run, failure, "capture_source_stalled");
      return Promise.reject(failure);
    }
    if (run.deliveryInFlight) {
      zeroPacket(packet);
      const failure = new AudioCaptureError("audio_capture_native_protocol_error");
      this.#markTerminal(run, failure, "capture_source_stalled");
      return Promise.reject(failure);
    }

    run.deliveryInFlight = true;
    const delivery = this.#deliverPcmPacket(run, packet, false).finally(() => {
      if (this.#isCurrentGeneration(run, generation)) run.deliveryInFlight = false;
    });
    run.pendingDelivery = delivery.catch(() => undefined);
    void delivery.catch((error: unknown) => {
      const failure = sanitizePacketFailure(error);
      this.#markTerminal(run, failure, packetFailureSignal(failure));
    });
    return delivery;
  }

  async #deliverPcmPacket(
    run: CaptureRun,
    packet: IosNativePcmPacket,
    finalPartial: boolean,
  ): Promise<void> {
    try {
      const pcmBytes = requirePcmBytes(packet);
      const sequenceNumber = requireSequenceNumber(packet);
      if (sequenceNumber !== run.expectedSequenceNumber) {
        throw new AudioCaptureError("audio_capture_native_protocol_error");
      }
      if (run.deliveredChunks >= run.maximumChunks) {
        throw new AudioCaptureError("audio_capture_output_limit_exceeded");
      }
      if (
        pcmBytes.byteLength < Int16Array.BYTES_PER_ELEMENT ||
        pcmBytes.byteLength % Int16Array.BYTES_PER_ELEMENT !== 0
      ) {
        throw new AudioCaptureError("audio_capture_native_protocol_error");
      }
      const frameCount = pcmBytes.byteLength / Int16Array.BYTES_PER_ELEMENT;
      if (
        frameCount > run.targetFramesPerChunk ||
        (finalPartial && frameCount >= run.targetFramesPerChunk)
      ) {
        throw new AudioCaptureError("audio_capture_output_limit_exceeded");
      }

      const samples = decodeLittleEndianPcm16(pcmBytes);
      let wavBytes: Uint8Array<ArrayBuffer>;
      try {
        wavBytes = encodePcm16MonoWav(samples, run.profile);
      } finally {
        samples.fill(0);
      }

      run.expectedSequenceNumber += 1;
      run.deliveredChunks += 1;
      const chunk: CapturedWavChunk = {
        sequenceNumber,
        durationMs: frameCount * 1_000 / IOS_NATIVE_PCM_FORMAT.sampleRateHz,
        wavBytes,
      };
      try {
        const onChunk = run.onChunk;
        if (onChunk === undefined) {
          throw new AudioCaptureError("audio_capture_unavailable");
        }
        await onChunk(chunk);
      } catch {
        throw new AudioCaptureError("audio_capture_callback_failed");
      } finally {
        wavBytes.fill(0);
      }
    } finally {
      zeroPacket(packet);
    }
  }

  #receiveInterruption(
    run: CaptureRun,
    generation: number,
    code: IosNativeMicrophoneInterruptionCode,
  ): void {
    if (!this.#isCurrentGeneration(run, generation)) return;
    const mapped = mapInterruption(code);
    if (mapped === undefined) {
      this.#markTerminal(
        run,
        new AudioCaptureError("audio_capture_native_protocol_error"),
        "capture_source_failed",
      );
      return;
    }
    this.#markTerminal(
      run,
      new AudioCaptureError("audio_capture_unavailable"),
      undefined,
      () => run.onInterruption?.(mapped),
    );
  }

  #receiveTerminalError(
    run: CaptureRun,
    generation: number,
    code: IosNativeMicrophoneTerminalErrorCode,
  ): void {
    if (!this.#isCurrentGeneration(run, generation)) return;
    const mapped = mapTerminalError(code);
    if (mapped === undefined) {
      this.#markTerminal(
        run,
        new AudioCaptureError("audio_capture_native_protocol_error"),
        "capture_source_failed",
      );
      return;
    }
    this.#markTerminal(run, new AudioCaptureError(mapped.failure), mapped.signal);
  }

  #markTerminal(
    run: CaptureRun,
    failure: AudioCaptureError,
    errorCode: CaptureSourceErrorCode | undefined,
    interruptionNotification?: () => void,
  ): void {
    if (!this.#isCurrentRun(run) || run.phase === "closed") return;
    if (run.terminalFailure === undefined) {
      run.terminalFailure = failure;
      run.cancelReason = "terminal";
      run.stopMode = "discard";
      try {
        if (interruptionNotification !== undefined) interruptionNotification();
        else if (errorCode !== undefined) run.onError?.(errorCode);
      } catch {
        // The run is terminal; notification code cannot reopen native capture.
      }
    }
    void this.#requestClose(run, "discard").catch(() => undefined);
  }

  #requestClose(run: CaptureRun, mode: IosNativeMicrophoneStopMode): Promise<void> {
    if (!this.#isCurrentRun(run)) return Promise.resolve();
    run.startupCancellation.resolve(undefined);
    if (mode === "discard" || run.stopMode === undefined) run.stopMode = mode;
    if (run.closePromise !== undefined) return run.closePromise;

    run.phase = "closing";
    const attempt = this.#performClose(run);
    run.closePromise = attempt;
    void attempt.then(
      () => this.#clearClosePromise(run, attempt),
      () => this.#clearClosePromise(run, attempt),
    );
    return attempt;
  }

  async #performClose(run: CaptureRun): Promise<void> {
    let nativeSession = run.nativeSession;
    if (nativeSession === undefined && run.nativeHandlePromise !== undefined) {
      try {
        nativeSession = await run.nativeHandlePromise;
      } catch {
        if (this.#isClosingRun(run)) {
          run.nativeHandlePromise = undefined;
          this.#finalizeRun(run);
        }
        return;
      }
      this.#assertClosingRun(run);
      run.nativeHandlePromise = undefined;
      run.nativeSession = nativeSession;
    }

    if (nativeSession === undefined) {
      this.#assertClosingRun(run);
      this.#finalizeRun(run);
      return;
    }

    this.#assertClosingRun(run);
    const requestedMode = run.stopMode ?? "discard";
    let stopResult: IosNativeMicrophoneStopResult;
    try {
      stopResult = await nativeSession.stop({ mode: requestedMode });
    } catch {
      if (this.#isClosingRun(run)) {
        run.phase = "close_failed";
        run.nativeSession = nativeSession;
        this.#notifyStopFailure(run);
      }
      throw new AudioCaptureError("audio_capture_native_stop_failed");
    }
    this.#assertClosingRun(run);

    await run.pendingDelivery;
    this.#assertClosingRun(run);
    let postStopFailure: AudioCaptureError | undefined;
    try {
      const finalPcmPacket = requireStopResult(stopResult);
      if (requestedMode === "discard") {
        if (finalPcmPacket !== null) {
          zeroPacket(finalPcmPacket);
          throw new AudioCaptureError("audio_capture_native_protocol_error");
        }
      } else if (run.stopMode === "discard") {
        if (finalPcmPacket !== null) zeroPacket(finalPcmPacket);
      } else if (finalPcmPacket !== null) {
        run.deliveryInFlight = true;
        try {
          await this.#deliverPcmPacket(run, finalPcmPacket, true);
        } finally {
          if (this.#isClosingRun(run)) run.deliveryInFlight = false;
        }
        this.#assertClosingRun(run);
      }
    } catch (error) {
      postStopFailure = sanitizePacketFailure(error);
    }
    this.#assertClosingRun(run);
    this.#finalizeRun(run);
    if (postStopFailure !== undefined) throw postStopFailure;
  }

  #notifyStopFailure(run: CaptureRun): void {
    if (run.stopFailureNotified) return;
    run.stopFailureNotified = true;
    try {
      run.onError?.("capture_source_failed");
    } catch {
      // The close remains failed and retryable even if notification code fails.
    }
  }

  #clearClosePromise(run: CaptureRun, attempt: Promise<void>): void {
    if (this.#isCurrentRun(run) && run.closePromise === attempt) {
      run.closePromise = undefined;
    }
  }

  #finalizeRun(run: CaptureRun): void {
    if (!this.#isCurrentRun(run)) return;
    if (run.abortSignal !== undefined && run.abortHandler !== undefined) {
      run.abortSignal.removeEventListener("abort", run.abortHandler);
    }
    run.abortHandler = undefined;
    run.abortSignal = undefined;
    run.nativeHandlePromise = undefined;
    run.nativeSession = undefined;
    run.onChunk = undefined;
    run.onError = undefined;
    run.onInterruption = undefined;
    run.phase = "closed";
    this.#run = undefined;
  }

  #assertStartingRun(run: CaptureRun, phase: CaptureRunPhase): void {
    if (!this.#isCurrentRun(run) || run.phase !== phase || run.cancelReason !== undefined) {
      throw run.terminalFailure ?? abortError();
    }
  }

  #assertClosingRun(run: CaptureRun): void {
    if (!this.#isClosingRun(run)) {
      throw new AudioCaptureError("audio_capture_stale_generation");
    }
  }

  #isClosingRun(run: CaptureRun): boolean {
    return this.#isCurrentRun(run) && run.phase === "closing";
  }

  #isCurrentGeneration(run: CaptureRun, generation: number): boolean {
    return run.generation === generation && this.#isCurrentRun(run);
  }

  #isCurrentRun(run: CaptureRun): boolean {
    return this.#run === run && this.#run.generation === run.generation;
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
  if (
    !(pcmBytes instanceof Uint8Array) ||
    !(pcmBytes.buffer instanceof ArrayBuffer) ||
    pcmBytes.byteOffset !== 0 ||
    pcmBytes.byteLength !== pcmBytes.buffer.byteLength
  ) {
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

function requireStopResult(result: unknown): IosNativePcmPacket | null {
  if (typeof result !== "object" || result === null || !("finalPcmPacket" in result)) {
    throw new AudioCaptureError("audio_capture_native_protocol_error");
  }
  const packet: unknown = result.finalPcmPacket;
  if (packet !== null && (typeof packet !== "object" || packet === null)) {
    throw new AudioCaptureError("audio_capture_native_protocol_error");
  }
  return packet as IosNativePcmPacket | null;
}

function decodeLittleEndianPcm16(
  pcmBytes: Uint8Array<ArrayBuffer>,
): Int16Array<ArrayBuffer> {
  const samples = new Int16Array(new ArrayBuffer(pcmBytes.byteLength));
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
    new Uint8Array(pcmBytes.buffer).fill(0);
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

function startFailureFor(run: CaptureRun, error: unknown): AudioCaptureError | DOMException {
  if (run.cancelReason === "abort" || run.cancelReason === "stop") return abortError();
  return run.terminalFailure ?? (isAbortError(error) ? abortError() : sanitizeStartFailure(error));
}

function sanitizePacketFailure(error: unknown): AudioCaptureError {
  return error instanceof AudioCaptureError
    ? error
    : new AudioCaptureError("audio_capture_native_protocol_error");
}

function packetFailureSignal(error: AudioCaptureError): CaptureSourceErrorCode {
  return error.code === "audio_capture_native_protocol_error" ||
    error.code === "audio_capture_output_limit_exceeded" ||
    error.code === "audio_capture_stale_generation"
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}
