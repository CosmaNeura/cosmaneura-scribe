import type {
  IosNativeAppState,
  IosNativeMicrophoneBridge,
  IosNativeMicrophoneInterruptionCode,
  IosNativeMicrophoneSession,
  IosNativeMicrophoneStopMode,
  IosNativeMicrophoneStopOptions,
  IosNativeMicrophoneStopResult,
  IosNativeMicrophoneTerminalErrorCode,
  IosNativePcmConfiguration,
  IosNativePcmPacket,
  IosNativePcmSink,
} from "./ios-native-pcm-bridge";

/** Metadata-only fake used to exercise the dormant adapter without native audio. */
export class FakeIosNativePcmBridge implements IosNativeMicrophoneBridge {
  #activeSession: FakeIosNativeMicrophoneSession | undefined;
  #appState: IosNativeAppState = "foreground";
  #finalPcmPacket: IosNativePcmPacket | null = null;
  #retainedSinks: IosNativePcmSink[] = [];
  #startFailure: unknown;
  #stopBarrier: Promise<void> | undefined;
  #stopFailuresRemaining = 0;

  public lastConfiguration: IosNativePcmConfiguration | undefined;
  public startCalls = 0;
  public stopCalls = 0;
  public readonly stopModes: IosNativeMicrophoneStopMode[] = [];

  public getAppState(): Promise<IosNativeAppState> {
    return Promise.resolve(this.#appState);
  }

  public start(
    configuration: IosNativePcmConfiguration,
    sink: IosNativePcmSink,
  ): IosNativeMicrophoneSession {
    this.startCalls += 1;
    if (this.#activeSession !== undefined) {
      throw new Error("fake_ios_bridge_already_active");
    }
    this.lastConfiguration = { ...configuration };
    this.#retainedSinks.push(sink);
    const ready = this.#startFailure === undefined
      ? Promise.resolve()
      : Promise.reject(
        this.#startFailure instanceof Error
          ? this.#startFailure
          : new Error("fake_ios_bridge_start_failed"),
      );
    const session = new FakeIosNativeMicrophoneSession(this, sink, ready);
    this.#activeSession = session;
    return session;
  }

  public setAppState(state: IosNativeAppState): void {
    this.#appState = state;
  }

  public failStartWith(error: unknown): void {
    this.#startFailure = error;
  }

  public failNextStops(count = 1): void {
    this.#stopFailuresRemaining = count;
  }

  public delayNextStopUntil(barrier: Promise<void>): void {
    this.#stopBarrier = barrier;
  }

  public setFinalPcmPacket(packet: IosNativePcmPacket): void {
    this.#finalPcmPacket = packet;
  }

  public emitPcmPacket(packet: IosNativePcmPacket): Promise<void> {
    return this.#requireActiveSession().sink.onPcmPacket(packet);
  }

  public emitInterruption(code: IosNativeMicrophoneInterruptionCode): void {
    this.#requireActiveSession().sink.onInterruption(code);
  }

  public emitError(code: IosNativeMicrophoneTerminalErrorCode): void {
    this.#requireActiveSession().sink.onError(code);
  }

  public emitRetainedPcmPacket(index: number, packet: IosNativePcmPacket): Promise<void> {
    return this.#requireRetainedSink(index).onPcmPacket(packet);
  }

  public emitRetainedInterruption(
    index: number,
    code: IosNativeMicrophoneInterruptionCode,
  ): void {
    this.#requireRetainedSink(index).onInterruption(code);
  }

  public emitRetainedError(
    index: number,
    code: IosNativeMicrophoneTerminalErrorCode,
  ): void {
    this.#requireRetainedSink(index).onError(code);
  }

  public async stopSession(
    session: FakeIosNativeMicrophoneSession,
    options: IosNativeMicrophoneStopOptions,
  ): Promise<IosNativeMicrophoneStopResult> {
    this.stopCalls += 1;
    this.stopModes.push(options.mode);
    const barrier = this.#stopBarrier;
    this.#stopBarrier = undefined;
    if (barrier !== undefined) await barrier;
    if (session !== this.#activeSession) {
      throw new Error("fake_ios_bridge_stale_session");
    }
    if (this.#stopFailuresRemaining > 0) {
      this.#stopFailuresRemaining -= 1;
      throw new Error("fake_ios_bridge_stop_failed");
    }

    const finalPcmPacket = options.mode === "drain" ? this.#finalPcmPacket : null;
    if (options.mode === "discard" && this.#finalPcmPacket !== null) {
      zeroWholeBuffer(this.#finalPcmPacket.pcmBytes);
    }
    this.#finalPcmPacket = null;
    this.#activeSession = undefined;
    return { finalPcmPacket };
  }

  #requireActiveSession(): FakeIosNativeMicrophoneSession {
    if (this.#activeSession === undefined) throw new Error("fake_ios_bridge_not_active");
    return this.#activeSession;
  }

  #requireRetainedSink(index: number): IosNativePcmSink {
    const sink = this.#retainedSinks[index];
    if (sink === undefined) throw new Error("fake_ios_bridge_sink_not_found");
    return sink;
  }
}

class FakeIosNativeMicrophoneSession implements IosNativeMicrophoneSession {
  public constructor(
    private readonly bridge: FakeIosNativePcmBridge,
    public readonly sink: IosNativePcmSink,
    public readonly ready: Promise<void>,
  ) {}

  public stop(options: IosNativeMicrophoneStopOptions): Promise<IosNativeMicrophoneStopResult> {
    return this.bridge.stopSession(this, options);
  }
}

function zeroWholeBuffer(bytes: Uint8Array): void {
  try {
    new Uint8Array(bytes.buffer).fill(0);
  } catch {
    // The fake mirrors native best-effort cleanup for invalid/detached buffers.
  }
}
