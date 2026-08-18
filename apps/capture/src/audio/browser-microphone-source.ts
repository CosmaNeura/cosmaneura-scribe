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
import { AudioCaptureError } from "./errors";
import { Pcm16Chunker } from "./pcm-chunker";
import { AreaWeightedPcm16Resampler } from "./resampler";
import {
  PCM_CAPTURE_WORKLET_NAME,
  PcmCaptureWorkletDecoder,
} from "./worklet-protocol";
import pcmCaptureWorkletModuleUrl from "./pcm-capture-worklet.ts?worker&url";

export interface BrowserMicrophoneDependencies {
  readonly mediaDevices: Pick<MediaDevices, "getUserMedia">;
  readonly createAudioContext: (options: AudioContextOptions) => AudioContext;
  readonly createAudioWorkletNode: (
    context: AudioContext,
    name: string,
    options: AudioWorkletNodeOptions,
  ) => AudioWorkletNode;
  readonly workletModuleUrl: URL;
  readonly visibilityDocument:
    | Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">
    | undefined;
  readonly pageLifecycleWindow:
    | Pick<Window, "addEventListener" | "removeEventListener">
    | undefined;
}

/** Foreground PWA microphone source: getUserMedia -> AudioWorklet -> PCM16 WAV. */
export class BrowserMicrophoneCaptureSource implements CaptureSource {
  public readonly kind = "microphone" as const;

  readonly #dependencies: BrowserMicrophoneDependencies;
  #state: "idle" | "starting" | "active" | "stopping" = "idle";
  #acceptMessages = false;
  #abortHandler: (() => void) | undefined;
  #abortSignal: AbortSignal | undefined;
  #audioContext: AudioContext | undefined;
  #chunker: Pcm16Chunker | undefined;
  #decoder: PcmCaptureWorkletDecoder | undefined;
  #mediaSource: MediaStreamAudioSourceNode | undefined;
  #onChunk: ((chunk: CapturedWavChunk) => Promise<void>) | undefined;
  #onError: ((code: CaptureSourceErrorCode) => void) | undefined;
  #onInterruption: ((code: CaptureSourceInterruptionCode) => void) | undefined;
  #pendingChunkDelivery: Promise<void> = Promise.resolve();
  #profile: Pcm16WavProfile | undefined;
  #resampler: AreaWeightedPcm16Resampler | undefined;
  #sequenceNumber = 0;
  #shutdownPromise: Promise<void> | undefined;
  #silentGain: GainNode | undefined;
  #stream: MediaStream | undefined;
  #terminalError: AudioCaptureError | undefined;
  #workletNode: AudioWorkletNode | undefined;

  public constructor(dependencies: Partial<BrowserMicrophoneDependencies> = {}) {
    this.#dependencies = {
      mediaDevices: dependencies.mediaDevices ?? navigator.mediaDevices,
      createAudioContext:
        dependencies.createAudioContext ?? ((options) => new AudioContext(options)),
      createAudioWorkletNode:
        dependencies.createAudioWorkletNode ??
        ((context, name, options) => new AudioWorkletNode(context, name, options)),
      workletModuleUrl:
        dependencies.workletModuleUrl ??
        new URL(pcmCaptureWorkletModuleUrl, import.meta.url),
      visibilityDocument:
        dependencies.visibilityDocument ?? globalThis.document,
      pageLifecycleWindow:
        dependencies.pageLifecycleWindow ?? globalThis.window,
    };
  }

  public async start(options: CaptureSourceStartOptions): Promise<void> {
    if (this.#state !== "idle") {
      throw new AudioCaptureError("audio_capture_already_active");
    }
    if (isAborted(options.signal)) throw abortError();
    this.#resetForStart();
    this.#state = "starting";

    try {
      const profile = pcm16WavProfile(options.capabilities);
      const framesPerChunk = targetFrameCount(profile);
      const maximumChunks = capabilityChunkLimit(options.capabilities);
      const maximumOutputFrames = safeProduct(framesPerChunk, maximumChunks);
      if (maximumOutputFrames < 1) {
        throw new AudioCaptureError("audio_capture_invalid_configuration");
      }
      if (
        this.#dependencies.visibilityDocument !== undefined &&
        this.#dependencies.visibilityDocument.visibilityState !== "visible"
      ) {
        throw new AudioCaptureError("audio_capture_unavailable");
      }

      const stream = await this.#requestMicrophone(profile);
      this.#stream = stream;
      if (isAborted(options.signal)) throw abortError();
      if (
        this.#dependencies.visibilityDocument !== undefined &&
        this.#dependencies.visibilityDocument.visibilityState !== "visible"
      ) {
        throw new AudioCaptureError("audio_capture_unavailable");
      }
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length !== 1) {
        throw new AudioCaptureError("audio_capture_device_unavailable");
      }

      this.#onError = options.onError;
      this.#onInterruption = options.onInterruption;
      audioTracks[0]?.addEventListener("ended", this.#handleTrackEnded, { once: true });
      audioTracks[0]?.addEventListener("mute", this.#handleTrackMuted, { once: true });
      this.#dependencies.visibilityDocument?.addEventListener(
        "visibilitychange",
        this.#handleVisibilityChange,
      );
      this.#dependencies.pageLifecycleWindow?.addEventListener(
        "pagehide",
        this.#handlePageHide,
      );
      if (options.signal !== undefined) {
        this.#abortSignal = options.signal;
        this.#abortHandler = () => {
          void this.#shutdown(false).catch(() => undefined);
        };
        options.signal.addEventListener("abort", this.#abortHandler, { once: true });
      }
      if (isAborted(options.signal)) throw abortError();
      if (
        this.#dependencies.visibilityDocument !== undefined &&
        this.#dependencies.visibilityDocument.visibilityState !== "visible"
      ) {
        throw new AudioCaptureError("audio_capture_unavailable");
      }

      const context = this.#dependencies.createAudioContext({
        latencyHint: "interactive",
        sampleRate: profile.sampleRateHz,
      });
      this.#audioContext = context;
      if (!Number.isSafeInteger(context.sampleRate) || context.sampleRate < 1) {
        throw new AudioCaptureError("audio_capture_unavailable");
      }
      const maximumInputFrames = rationalFloor(
        maximumOutputFrames,
        context.sampleRate,
        profile.sampleRateHz,
      );
      if (maximumInputFrames < 1) {
        throw new AudioCaptureError("audio_capture_invalid_configuration");
      }

      await context.audioWorklet.addModule(this.#dependencies.workletModuleUrl.toString());
      if (isAborted(options.signal)) throw abortError();
      if (this.#terminalError !== undefined) throw this.#terminalError;
      if (this.#state !== "starting") {
        throw new AudioCaptureError("audio_capture_unavailable");
      }
      if (
        this.#dependencies.visibilityDocument !== undefined &&
        this.#dependencies.visibilityDocument.visibilityState !== "visible"
      ) {
        throw new AudioCaptureError("audio_capture_unavailable");
      }

      this.#profile = profile;
      this.#onChunk = options.onChunk;
      this.#decoder = new PcmCaptureWorkletDecoder(framesPerChunk);
      this.#resampler = new AreaWeightedPcm16Resampler({
        sourceSampleRateHz: context.sampleRate,
        targetSampleRateHz: profile.sampleRateHz,
        maximumInputFrames,
        maximumOutputFrames,
      });
      this.#chunker = new Pcm16Chunker({
        targetFramesPerChunk: framesPerChunk,
        maximumChunks,
      });

      const mediaSource = context.createMediaStreamSource(stream);
      const workletNode = this.#dependencies.createAudioWorkletNode(
        context,
        PCM_CAPTURE_WORKLET_NAME,
        {
          channelCount: 1,
          channelCountMode: "explicit",
          channelInterpretation: "speakers",
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        },
      );
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      this.#mediaSource = mediaSource;
      this.#workletNode = workletNode;
      this.#silentGain = silentGain;
      workletNode.port.onmessage = (event: MessageEvent<unknown>) => {
        this.#handleWorkletMessage(event.data);
      };
      workletNode.onprocessorerror = () => {
        this.#failWithError(
          new AudioCaptureError("audio_capture_worklet_protocol_error"),
          "capture_source_failed",
        );
      };
      context.addEventListener("statechange", this.#handleContextStateChange);
      mediaSource.connect(workletNode);
      workletNode.connect(silentGain);
      silentGain.connect(context.destination);

      this.#acceptMessages = true;
      this.#state = "active";
      await context.resume();
      if (context.state !== "running") {
        throw new AudioCaptureError("audio_capture_unavailable");
      }
    } catch (error) {
      const failure = sanitizeStartFailure(error);
      this.#terminalError = failure;
      await this.#shutdown(false).catch(() => undefined);
      if (isAbortError(error)) throw error;
      throw failure;
    }
  }

  public async stop(): Promise<void> {
    await this.#shutdown(this.#state === "active");
  }

  readonly #handleTrackEnded = (): void => {
    if (this.#state === "starting" || this.#state === "active") {
      this.#failWithInterruption(
        new AudioCaptureError("audio_capture_unavailable"),
        "audio_device_disconnected",
      );
    }
  };

  readonly #handleTrackMuted = (): void => {
    if (this.#state === "starting" || this.#state === "active") {
      this.#failWithInterruption(
        new AudioCaptureError("audio_capture_unavailable"),
        "audio_route_changed",
      );
    }
  };

  readonly #handleContextStateChange = (): void => {
    if (this.#state === "active" && this.#audioContext?.state !== "running") {
      const state = this.#audioContext?.state as string | undefined;
      if (state === "suspended" || state === "interrupted") {
        this.#failWithInterruption(
          new AudioCaptureError("audio_capture_unavailable"),
          "audio_context_suspended",
        );
      } else {
        this.#failWithError(
          new AudioCaptureError("audio_capture_unavailable"),
          "capture_source_failed",
        );
      }
    }
  };

  readonly #handleVisibilityChange = (): void => {
    if (
      (this.#state === "starting" || this.#state === "active") &&
      this.#dependencies.visibilityDocument?.visibilityState !== "visible"
    ) {
      this.#failWithInterruption(
        new AudioCaptureError("audio_capture_unavailable"),
        "capture_backgrounded",
      );
    }
  };

  readonly #handlePageHide = (): void => {
    if (this.#state === "starting" || this.#state === "active") {
      this.#failWithInterruption(
        new AudioCaptureError("audio_capture_unavailable"),
        "capture_backgrounded",
      );
    }
  };

  async #requestMicrophone(profile: Pcm16WavProfile): Promise<MediaStream> {
    try {
      return await this.#dependencies.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: false,
          channelCount: { ideal: profile.channels },
          echoCancellation: false,
          noiseSuppression: false,
          sampleRate: { ideal: profile.sampleRateHz },
        },
        video: false,
      });
    } catch (error) {
      if (isNamedDomError(error, "NotAllowedError")) {
        throw new AudioCaptureError("audio_capture_permission_denied");
      }
      if (isNamedDomError(error, "NotFoundError")) {
        throw new AudioCaptureError("audio_capture_device_unavailable");
      }
      throw new AudioCaptureError("audio_capture_unavailable");
    }
  }

  #handleWorkletMessage(value: unknown): void {
    if (!this.#acceptMessages) return;
    try {
      const frames = this.#requireDecoder().decode(value);
      let samples: Int16Array;
      try {
        samples = this.#requireResampler().push(frames);
      } finally {
        frames.fill(0);
      }
      try {
        this.#queueCompletedChunks(this.#requireChunker().push(samples));
      } finally {
        samples.fill(0);
      }
    } catch (error) {
      const failure =
        error instanceof AudioCaptureError
          ? error
          : new AudioCaptureError("audio_capture_worklet_protocol_error");
      this.#failWithError(
        failure,
        failure.code === "audio_capture_worklet_protocol_error"
          ? "capture_source_stalled"
          : "capture_source_failed",
      );
    }
  }

  #queueCompletedChunks(chunks: readonly Int16Array<ArrayBuffer>[]): void {
    for (const samples of chunks) this.#queueChunk(samples);
  }

  #queueChunk(samples: Int16Array<ArrayBuffer>): void {
    const profile = this.#requireProfile();
    const onChunk = this.#requireOnChunk();
    let wavBytes: Uint8Array<ArrayBuffer>;
    try {
      wavBytes = encodePcm16MonoWav(samples, profile);
    } finally {
      samples.fill(0);
    }
    const chunk: CapturedWavChunk = {
      sequenceNumber: this.#sequenceNumber,
      durationMs: samples.length * 1_000 / profile.sampleRateHz,
      wavBytes,
    };
    this.#sequenceNumber += 1;
    this.#pendingChunkDelivery = this.#pendingChunkDelivery.then(async () => {
      try {
        if (this.#terminalError !== undefined) return;
        await onChunk(chunk);
      } catch {
        this.#failWithError(
          new AudioCaptureError("audio_capture_callback_failed"),
          "capture_source_failed",
        );
      } finally {
        chunk.wavBytes.fill(0);
      }
    });
  }

  #failWithInterruption(
    error: AudioCaptureError,
    code: CaptureSourceInterruptionCode,
  ): void {
    this.#fail(error, () => this.#onInterruption?.(code));
  }

  #failWithError(error: AudioCaptureError, code: CaptureSourceErrorCode): void {
    this.#fail(error, () => this.#onError?.(code));
  }

  #fail(error: AudioCaptureError, notify: () => void): void {
    if (this.#terminalError !== undefined) return;
    this.#terminalError = error;
    try {
      notify();
    } catch {
      // The source is already terminal; notification code cannot reopen audio input.
    }
    void this.#shutdown(false).catch(() => undefined);
  }

  #shutdown(flush: boolean): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    if (this.#state === "idle") return Promise.resolve();
    this.#shutdownPromise = this.#performShutdown(flush).finally(() => {
      this.#state = "idle";
      this.#shutdownPromise = undefined;
    });
    return this.#shutdownPromise;
  }

  async #performShutdown(flush: boolean): Promise<void> {
    this.#state = "stopping";
    const context = this.#audioContext;
    if (context?.state === "running") {
      await context.suspend().catch(() => undefined);
    }
    this.#acceptMessages = false;
    if (this.#workletNode !== undefined) {
      this.#workletNode.port.onmessage = null;
      this.#workletNode.onprocessorerror = null;
    }
    this.#mediaSource?.disconnect();
    this.#workletNode?.disconnect();
    this.#silentGain?.disconnect();
    const audioTrack = this.#stream?.getAudioTracks()[0];
    audioTrack?.removeEventListener("ended", this.#handleTrackEnded);
    audioTrack?.removeEventListener("mute", this.#handleTrackMuted);
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    context?.removeEventListener("statechange", this.#handleContextStateChange);
    this.#dependencies.visibilityDocument?.removeEventListener(
      "visibilitychange",
      this.#handleVisibilityChange,
    );
    this.#dependencies.pageLifecycleWindow?.removeEventListener(
      "pagehide",
      this.#handlePageHide,
    );
    if (context !== undefined && context.state !== "closed") {
      await context.close().catch(() => undefined);
    }

    if (flush && this.#terminalError === undefined) {
      const finalSamples = this.#requireResampler().finish();
      try {
        this.#queueCompletedChunks(this.#requireChunker().push(finalSamples));
      } finally {
        finalSamples.fill(0);
      }
      const finalChunk = this.#requireChunker().finish();
      if (finalChunk !== null) this.#queueChunk(finalChunk);
    } else {
      this.#chunker?.discard();
    }
    await this.#pendingChunkDelivery;
    this.#removeAbortHandler();
    this.#audioContext = undefined;
    this.#chunker = undefined;
    this.#decoder = undefined;
    this.#mediaSource = undefined;
    this.#onChunk = undefined;
    this.#onError = undefined;
    this.#onInterruption = undefined;
    this.#profile = undefined;
    this.#resampler = undefined;
    this.#silentGain = undefined;
    this.#stream = undefined;
    this.#workletNode = undefined;
  }

  #resetForStart(): void {
    this.#acceptMessages = false;
    this.#pendingChunkDelivery = Promise.resolve();
    this.#sequenceNumber = 0;
    this.#shutdownPromise = undefined;
    this.#terminalError = undefined;
  }

  #removeAbortHandler(): void {
    if (this.#abortSignal !== undefined && this.#abortHandler !== undefined) {
      this.#abortSignal.removeEventListener("abort", this.#abortHandler);
    }
    this.#abortHandler = undefined;
    this.#abortSignal = undefined;
  }

  #requireChunker(): Pcm16Chunker {
    if (this.#chunker === undefined) {
      throw new AudioCaptureError("audio_capture_unavailable");
    }
    return this.#chunker;
  }

  #requireDecoder(): PcmCaptureWorkletDecoder {
    if (this.#decoder === undefined) {
      throw new AudioCaptureError("audio_capture_unavailable");
    }
    return this.#decoder;
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

  #requireResampler(): AreaWeightedPcm16Resampler {
    if (this.#resampler === undefined) {
      throw new AudioCaptureError("audio_capture_unavailable");
    }
    return this.#resampler;
  }
}

function capabilityChunkLimit(
  capabilities: CaptureSourceStartOptions["capabilities"],
): number {
  if (
    !Number.isSafeInteger(capabilities.max_chunks) ||
    capabilities.max_chunks < 1 ||
    !Number.isSafeInteger(capabilities.remaining_aggregate_plaintext_bytes) ||
    capabilities.remaining_aggregate_plaintext_bytes < 0 ||
    !Number.isSafeInteger(capabilities.max_envelope_bytes) ||
    capabilities.max_envelope_bytes < 1
  ) {
    throw new AudioCaptureError("audio_capture_invalid_configuration");
  }
  return Math.min(
    capabilities.max_chunks,
    Math.floor(
      capabilities.remaining_aggregate_plaintext_bytes /
        capabilities.max_envelope_bytes,
    ),
  );
}

function safeProduct(left: number, right: number): number {
  const value = left * right;
  if (!Number.isSafeInteger(value)) {
    throw new AudioCaptureError("audio_capture_invalid_configuration");
  }
  return value;
}

function rationalFloor(value: number, numerator: number, denominator: number): number {
  return Number((BigInt(value) * BigInt(numerator)) / BigInt(denominator));
}

function sanitizeStartFailure(error: unknown): AudioCaptureError {
  if (error instanceof AudioCaptureError) return error;
  return new AudioCaptureError("audio_capture_unavailable");
}

function isNamedDomError(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}

function isAbortError(error: unknown): boolean {
  return isNamedDomError(error, "AbortError");
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortError(): DOMException {
  return new DOMException("capture start was cancelled", "AbortError");
}
