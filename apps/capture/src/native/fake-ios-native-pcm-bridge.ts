import type {
  IosNativeAppState,
  IosNativeMicrophoneBridge,
  IosNativeMicrophoneInterruptionCode,
  IosNativeMicrophoneTerminalErrorCode,
  IosNativePcmConfiguration,
  IosNativePcmPacket,
  IosNativePcmSink,
} from "./ios-native-pcm-bridge";

/** Metadata-only fake used to exercise the dormant adapter without native audio. */
export class FakeIosNativePcmBridge implements IosNativeMicrophoneBridge {
  #activeSink: IosNativePcmSink | undefined;
  #appState: IosNativeAppState = "foreground";
  #startFailure: unknown;

  public lastConfiguration: IosNativePcmConfiguration | undefined;
  public startCalls = 0;
  public stopCalls = 0;

  public getAppState(): Promise<IosNativeAppState> {
    return Promise.resolve(this.#appState);
  }

  public start(
    configuration: IosNativePcmConfiguration,
    sink: IosNativePcmSink,
  ): Promise<void> {
    this.startCalls += 1;
    if (this.#startFailure !== undefined) {
      return Promise.reject(
        this.#startFailure instanceof Error
          ? this.#startFailure
          : new Error("fake_ios_bridge_start_failed"),
      );
    }
    if (this.#activeSink !== undefined) {
      return Promise.reject(new Error("fake_ios_bridge_already_active"));
    }
    this.lastConfiguration = { ...configuration };
    this.#activeSink = sink;
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    this.stopCalls += 1;
    this.#activeSink = undefined;
    return Promise.resolve();
  }

  public setAppState(state: IosNativeAppState): void {
    this.#appState = state;
  }

  public failStartWith(error: unknown): void {
    this.#startFailure = error;
  }

  public emitPcmPacket(packet: IosNativePcmPacket): Promise<void> {
    return this.#requireSink().onPcmPacket(packet);
  }

  public emitInterruption(code: IosNativeMicrophoneInterruptionCode): void {
    this.#requireSink().onInterruption(code);
  }

  public emitError(code: IosNativeMicrophoneTerminalErrorCode): void {
    this.#requireSink().onError(code);
  }

  #requireSink(): IosNativePcmSink {
    if (this.#activeSink === undefined) throw new Error("fake_ios_bridge_not_active");
    return this.#activeSink;
  }
}
