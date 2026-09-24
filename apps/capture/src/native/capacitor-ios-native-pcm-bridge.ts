import {
  clearIosPcmBytes,
  decodeIosPcmBase64,
  IOSPCM,
  IOS_PCM_EVENT_NAME,
  type IOSPCMPlugin,
  type IosPcmEncodedPacket,
  type IosPcmEvent,
  type IosPcmInterruptionCode,
  type IosPcmStopResult,
  type IosPcmTerminalCode,
} from "./capacitor-pcm";
import type { PluginListenerHandle } from "@capacitor/core";

import {
  IosNativeMicrophoneBridgeError,
  type IosNativeAppState,
  type IosNativeMicrophoneBridge,
  type IosNativeMicrophoneSession,
  type IosNativeMicrophoneStopMode,
  type IosNativeMicrophoneStopOptions,
  type IosNativeMicrophoneStopResult,
  type IosNativePcmConfiguration,
  type IosNativePcmPacket,
  type IosNativePcmSink,
} from "./ios-native-pcm-bridge";
import { IosNativeMicrophoneCaptureSource } from "./ios-native-microphone-source";

const MAINTENANCE_INTERVAL_MILLISECONDS = 5_000;
const MAXIMUM_SEQUENCE_NUMBER = 8_639;
const SESSION_TOKEN = /^[1-9][0-9]*\.[A-Za-z0-9_-]{1,64}$/u;

type RunPhase = "installing" | "starting" | "active" | "closing" | "close_failed" | "closed";

interface BridgeRun {
  readonly generation: number;
  readonly sink: IosNativePcmSink;
  readonly maximumChunks: number;
  readonly tokenPromise: Promise<string>;
  readonly resolveToken: (token: string) => void;
  readonly rejectToken: (error: Error) => void;
  phase: RunPhase;
  listener: PluginListenerHandle | undefined;
  token: string | undefined;
  pendingLifecycleEvent: IosPcmEvent | undefined;
  expectedSequenceNumber: number;
  packetInFlight: boolean;
  packetDelivery: Promise<void> | undefined;
  maintenanceInFlight: boolean;
  maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  terminalNotified: boolean;
  requestedStopMode: IosNativeMicrophoneStopMode | undefined;
  nativeStopMode: IosNativeMicrophoneStopMode | undefined;
  discardUpgradePromise: Promise<IosPcmStopResult> | undefined;
  closePromise: Promise<IosNativeMicrophoneStopResult> | undefined;
  readonly discardRequested: ReturnType<typeof deferred<void>>;
  retainedFinalPacket: IosNativeMicrophoneStopResult["finalPcmPacket"];
}

/**
 * App-owned Capacitor transport. It never logs plugin errors, session tokens,
 * encoded payloads, or decoded PCM.
 */
export class CapacitorIosNativePcmBridge implements IosNativeMicrophoneBridge {
  readonly #plugin: IOSPCMPlugin;
  readonly #maintenanceIntervalMilliseconds: number;
  #generation = 0;
  #run: BridgeRun | undefined;

  public constructor(
    plugin: IOSPCMPlugin = IOSPCM,
    maintenanceIntervalMilliseconds = MAINTENANCE_INTERVAL_MILLISECONDS,
  ) {
    this.#plugin = plugin;
    this.#maintenanceIntervalMilliseconds = maintenanceIntervalMilliseconds;
  }

  public async getAppState(): Promise<IosNativeAppState> {
    try {
      const result = await this.#plugin.getAppState();
      if (result.state === "foreground" || result.state === "background") return result.state;
    } catch (error) {
      throw startError(error);
    }
    throw new IosNativeMicrophoneBridgeError("ios_capture_start_failed");
  }

  public start(
    configuration: IosNativePcmConfiguration,
    sink: IosNativePcmSink,
  ): IosNativeMicrophoneSession {
    if (this.#run !== undefined) {
      throw new IosNativeMicrophoneBridgeError("ios_capture_start_failed");
    }
    const token = deferred<string>();
    void token.promise.catch(() => undefined);
    const run: BridgeRun = {
      generation: ++this.#generation,
      sink,
      maximumChunks: configuration.maximumChunks,
      tokenPromise: token.promise,
      resolveToken: token.resolve,
      rejectToken: token.reject,
      phase: "installing",
      listener: undefined,
      token: undefined,
      pendingLifecycleEvent: undefined,
      expectedSequenceNumber: 0,
      packetInFlight: false,
      packetDelivery: undefined,
      maintenanceInFlight: false,
      maintenanceTimer: undefined,
      terminalNotified: false,
      requestedStopMode: undefined,
      nativeStopMode: undefined,
      discardUpgradePromise: undefined,
      closePromise: undefined,
      discardRequested: deferred<void>(),
      retainedFinalPacket: null,
    };
    this.#run = run;
    const ready = this.#initialize(run, configuration);
    void ready.catch(() => undefined);
    return {
      ready,
      stop: (options) => this.#stop(run, options),
    };
  }

  async #initialize(
    run: BridgeRun,
    configuration: IosNativePcmConfiguration,
  ): Promise<void> {
    try {
      const listener = await this.#plugin.addListener(IOS_PCM_EVENT_NAME, (event) => {
        void this.#receiveEvent(run, event).catch(() => {
          this.#notifyCaptureFailure(run);
        });
      });
      run.listener = listener;
      this.#assertCurrent(run, "installing");
      run.phase = "starting";
      const started = await this.#plugin.start({ ...configuration });
      const sessionToken = requireSessionToken(started.sessionToken);
      run.token = sessionToken;
      run.resolveToken(sessionToken);
      this.#flushPendingLifecycleEvent(run);
      this.#assertCurrent(run, "starting");
      await this.#plugin.ready({ sessionToken });
      this.#assertCurrent(run, "starting");
      run.phase = "active";
      this.#startMaintenance(run);
    } catch (error) {
      const failure = startError(error);
      if (run.token === undefined) {
        run.rejectToken(failure);
        if (run.phase !== "closing") await this.#cleanupBeforeToken(run);
      }
      throw failure;
    }
  }

  async #cleanupBeforeToken(run: BridgeRun): Promise<void> {
    try {
      await this.#removeListener(run);
      this.#finishRun(run, true);
    } catch {
      if (this.#isCurrent(run)) run.phase = "close_failed";
    }
  }

  async #receiveEvent(run: BridgeRun, event: IosPcmEvent): Promise<void> {
    if (!this.#isCurrent(run) || run.phase === "closed") return;
    if (run.token === undefined) {
      if (event.kind !== "packet") run.pendingLifecycleEvent = event;
      return;
    }
    if (event.kind === "packet") {
      await this.#receivePacket(run, event.packet);
      return;
    }
    if (event.sessionToken !== run.token) return;
    if (!validLifecycleEvent(event)) {
      this.#notifyCaptureFailure(run);
      return;
    }
    if (event.kind === "interruption") run.sink.onInterruption(event.code);
    else run.sink.onError(event.code);
  }

  async #receivePacket(run: BridgeRun, packet: IosPcmEncodedPacket): Promise<void> {
    const token = run.token;
    if (
      token === undefined ||
      packet.sessionToken !== token
    ) {
      return;
    }
    if (!validSequence(packet.sequenceNumber, run.maximumChunks)) {
      this.#notifyCaptureFailure(run);
      return;
    }
    if (packet.sequenceNumber < run.expectedSequenceNumber || run.packetInFlight) return;
    if (packet.sequenceNumber > run.expectedSequenceNumber) {
      await this.#acknowledge(run, packet.sequenceNumber);
      this.#notifyCaptureFailure(run);
      return;
    }

    run.packetInFlight = true;
    const delivery = this.#deliverAndAcknowledge(run, packet);
    run.packetDelivery = delivery;
    try {
      await delivery;
    } finally {
      if (run.packetDelivery === delivery) run.packetDelivery = undefined;
      if (this.#isCurrent(run)) run.packetInFlight = false;
    }
  }

  async #deliverAndAcknowledge(
    run: BridgeRun,
    packet: IosPcmEncodedPacket,
  ): Promise<void> {
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    let sinkInvoked = false;
    try {
      bytes = decodeIosPcmBase64(packet.pcmBase64);
      sinkInvoked = true;
      await run.sink.onPcmPacket({ sequenceNumber: packet.sequenceNumber, pcmBytes: bytes });
    } catch {
      if (!sinkInvoked) this.#notifyCaptureFailure(run);
    } finally {
      if (bytes !== undefined) clearIosPcmBytes(bytes);
      try {
        await this.#acknowledge(run, packet.sequenceNumber);
      } catch {
        this.#notifyCaptureFailure(run);
      }
    }
  }

  async #acknowledge(run: BridgeRun, sequenceNumber: number): Promise<void> {
    const token = requireCurrentToken(run, this.#run);
    const response = await this.#plugin.acknowledge({
      sessionToken: token,
      sequenceNumber,
    });
    if (response.result !== "accepted" && response.result !== "replayed") {
      throw fixedError("ios_capture_failed");
    }
    if (sequenceNumber === run.expectedSequenceNumber) run.expectedSequenceNumber += 1;
  }

  #flushPendingLifecycleEvent(run: BridgeRun): void {
    const event = run.pendingLifecycleEvent;
    run.pendingLifecycleEvent = undefined;
    if (event !== undefined) {
      void this.#receiveEvent(run, event).catch(() => {
        this.#notifyCaptureFailure(run);
      });
    }
  }

  #startMaintenance(run: BridgeRun): void {
    run.maintenanceTimer = setInterval(() => {
      void this.#maintain(run);
    }, this.#maintenanceIntervalMilliseconds);
  }

  async #maintain(run: BridgeRun): Promise<void> {
    if (
      !this.#isCurrent(run) ||
      run.phase !== "active" ||
      run.maintenanceInFlight
    ) {
      return;
    }
    run.maintenanceInFlight = true;
    try {
      const token = requireCurrentToken(run, this.#run);
      await this.#plugin.heartbeat({ sessionToken: token });
      if (!run.packetInFlight && run.expectedSequenceNumber < run.maximumChunks) {
        const replay = await this.#plugin.replayPendingPacket({
          sessionToken: token,
          sequenceNumber: run.expectedSequenceNumber,
        });
        if (replay.result === "already_acknowledged") run.expectedSequenceNumber += 1;
        else if (replay.result !== "replayed" && replay.result !== "stale") {
          this.#notifyCaptureFailure(run);
        }
      }
    } catch {
      this.#notifyCaptureFailure(run);
    } finally {
      run.maintenanceInFlight = false;
    }
  }

  #notifyCaptureFailure(run: BridgeRun): void {
    if (!this.#isCurrent(run) || run.terminalNotified) return;
    run.terminalNotified = true;
    try {
      run.sink.onError("ios_capture_failed");
    } catch {
      // Notification is fixed-code and best effort; it cannot reopen capture.
    }
  }

  #stop(
    run: BridgeRun,
    options: IosNativeMicrophoneStopOptions,
  ): Promise<IosNativeMicrophoneStopResult> {
    if (run.phase === "closed") return Promise.resolve({ finalPcmPacket: null });
    if (!this.#isCurrent(run)) return Promise.reject(fixedError("ios_capture_stop_failed"));
    if (options.mode === "discard" || run.requestedStopMode === undefined) {
      run.requestedStopMode = options.mode;
    }
    if (options.mode === "discard") {
      run.discardRequested.resolve(undefined);
      this.#clearRetainedFinalPacket(run);
    }
    if (run.closePromise !== undefined) {
      this.#requestDiscardUpgrade(run);
      return run.closePromise;
    }
    run.phase = "closing";
    const close = this.#performStop(run);
    run.closePromise = close;
    void close.finally(() => {
      if (run.closePromise === close) {
        run.closePromise = undefined;
        run.nativeStopMode = undefined;
        run.discardUpgradePromise = undefined;
      }
    }).catch(() => undefined);
    return close;
  }

  async #performStop(run: BridgeRun): Promise<IosNativeMicrophoneStopResult> {
    let sessionToken: string;
    try {
      sessionToken = await run.tokenPromise;
    } catch {
      try {
        await this.#removeListener(run);
      } catch {
        if (this.#isCurrent(run)) run.phase = "close_failed";
        throw fixedError("ios_capture_stop_failed");
      }
      this.#finishRun(run, true);
      return { finalPcmPacket: null };
    }

    try {
      if (run.requestedStopMode === "drain" && run.packetDelivery !== undefined) {
        await Promise.race([run.packetDelivery, run.discardRequested.promise]);
      }
      const mode = run.requestedStopMode ?? "discard";
      run.nativeStopMode = mode;
      const primary = await settledStop(
        Promise.resolve().then(() => this.#plugin.stop({ sessionToken, mode })),
      );
      let discardUpgrade = run.discardUpgradePromise;
      let upgrade = discardUpgrade === undefined
        ? undefined
        : await settledStop(discardUpgrade);
      if (upgrade !== undefined ? !upgrade.succeeded : !primary.succeeded) {
        throw fixedError("ios_capture_stop_failed");
      }
      if (primary.succeeded) this.#consumeStopResult(run, primary.result, sessionToken);
      if (upgrade?.succeeded === true) {
        this.#consumeStopResult(run, upgrade.result, sessionToken);
      }

      let listenerRemovalFailed = false;
      try {
        await this.#removeListener(run);
      } catch {
        listenerRemovalFailed = true;
      }
      const laterDiscardUpgrade = run.discardUpgradePromise;
      if (laterDiscardUpgrade !== undefined && laterDiscardUpgrade !== discardUpgrade) {
        discardUpgrade = laterDiscardUpgrade;
        upgrade = await settledStop(laterDiscardUpgrade);
        if (!upgrade.succeeded) throw fixedError("ios_capture_stop_failed");
        this.#consumeStopResult(run, upgrade.result, sessionToken);
      }
      if (listenerRemovalFailed) throw fixedError("ios_capture_stop_failed");
      const finalPcmPacket = run.retainedFinalPacket;
      run.retainedFinalPacket = null;
      this.#finishRun(run, false);
      return { finalPcmPacket };
    } catch {
      if (this.#isCurrent(run)) run.phase = "close_failed";
      throw fixedError("ios_capture_stop_failed");
    }
  }

  #requestDiscardUpgrade(run: BridgeRun): void {
    if (
      run.requestedStopMode !== "discard" ||
      run.nativeStopMode !== "drain" ||
      run.discardUpgradePromise !== undefined ||
      run.token === undefined
    ) {
      return;
    }
    const sessionToken = run.token;
    const upgrade = Promise.resolve().then(() => this.#plugin.stop({
      sessionToken,
      mode: "discard",
    }));
    run.discardUpgradePromise = upgrade;
    void upgrade.catch(() => undefined);
  }

  #consumeStopResult(
    run: BridgeRun,
    result: IosPcmStopResult,
    sessionToken: string,
  ): void {
    if (result.finalPcmPacket !== null) {
      const finalPcmPacket = decodeFinalPacket(result.finalPcmPacket, sessionToken);
      if (run.retainedFinalPacket !== null) {
        clearIosPcmBytes(finalPcmPacket.pcmBytes);
        throw fixedError("ios_capture_stop_failed");
      }
      run.retainedFinalPacket = finalPcmPacket;
    }
    if (run.requestedStopMode === "discard") this.#clearRetainedFinalPacket(run);
  }

  #clearRetainedFinalPacket(run: BridgeRun): void {
    if (run.retainedFinalPacket === null) return;
    clearIosPcmBytes(run.retainedFinalPacket.pcmBytes);
    run.retainedFinalPacket = null;
  }

  async #removeListener(run: BridgeRun): Promise<void> {
    const listener = run.listener;
    if (listener === undefined) return;
    await listener.remove();
    run.listener = undefined;
  }

  #finishRun(run: BridgeRun, clearFinalPacket: boolean): void {
    if (run.maintenanceTimer !== undefined) clearInterval(run.maintenanceTimer);
    run.maintenanceTimer = undefined;
    run.pendingLifecycleEvent = undefined;
    if (clearFinalPacket && run.retainedFinalPacket !== null) {
      clearIosPcmBytes(run.retainedFinalPacket.pcmBytes);
      run.retainedFinalPacket = null;
    }
    run.phase = "closed";
    if (this.#run === run) this.#run = undefined;
  }

  #assertCurrent(run: BridgeRun, phase: RunPhase): void {
    if (!this.#isCurrent(run) || run.phase !== phase) {
      throw new IosNativeMicrophoneBridgeError("ios_capture_start_failed");
    }
  }

  #isCurrent(run: BridgeRun): boolean {
    return this.#run === run && this.#run.generation === run.generation;
  }
}

export function createCapacitorIosNativeMicrophoneCaptureSource(): IosNativeMicrophoneCaptureSource {
  return new IosNativeMicrophoneCaptureSource(new CapacitorIosNativePcmBridge());
}

function decodeFinalPacket(
  packet: IosPcmEncodedPacket,
  expectedToken: string,
): IosNativePcmPacket {
  if (
    packet.sessionToken !== expectedToken ||
    !validSequence(packet.sequenceNumber, MAXIMUM_SEQUENCE_NUMBER + 1)
  ) {
    throw fixedError("ios_capture_stop_failed");
  }
  return {
    sequenceNumber: packet.sequenceNumber,
    pcmBytes: decodeIosPcmBase64(packet.pcmBase64),
  };
}

function validSequence(value: number, maximumChunks: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < maximumChunks;
}

function validLifecycleEvent(
  event: Exclude<IosPcmEvent, { readonly kind: "packet" }>,
): event is
  | { readonly kind: "interruption"; readonly sessionToken: string; readonly code: IosPcmInterruptionCode }
  | { readonly kind: "terminal"; readonly sessionToken: string; readonly code: IosPcmTerminalCode } {
  if (!SESSION_TOKEN.test(event.sessionToken)) return false;
  if (event.kind === "interruption") {
    return INTERRUPTION_CODES.has(event.code);
  }
  return event.kind === "terminal" && TERMINAL_CODES.has(event.code);
}

const INTERRUPTION_CODES = new Set<IosPcmInterruptionCode>([
  "ios_audio_session_interrupted",
  "ios_audio_route_changed",
  "ios_capture_backgrounded",
]);
const TERMINAL_CODES = new Set<IosPcmTerminalCode>([
  "ios_microphone_permission_revoked",
  "ios_capture_stalled",
  "ios_capture_failed",
]);

function requireSessionToken(value: unknown): string {
  if (typeof value !== "string" || !SESSION_TOKEN.test(value) || value.length > 85) {
    throw new IosNativeMicrophoneBridgeError("ios_capture_start_failed");
  }
  return value;
}

function requireCurrentToken(run: BridgeRun, current: BridgeRun | undefined): string {
  if (current !== run || run.token === undefined) throw fixedError("ios_capture_failed");
  return run.token;
}

function startError(error: unknown): IosNativeMicrophoneBridgeError {
  if (error instanceof IosNativeMicrophoneBridgeError) return error;
  const code = fixedPluginCode(error);
  switch (code) {
    case "ios_microphone_permission_denied":
    case "ios_microphone_permission_restricted":
    case "ios_microphone_unavailable":
    case "ios_capture_not_foreground":
    case "ios_capture_start_failed":
      return new IosNativeMicrophoneBridgeError(code);
    default:
      return new IosNativeMicrophoneBridgeError("ios_capture_start_failed");
  }
}

function fixedPluginCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.message : undefined;
}

function fixedError(code: "ios_capture_failed" | "ios_capture_stop_failed"): Error {
  return new Error(code);
}

async function settledStop<T>(promise: Promise<T>): Promise<
  | { readonly succeeded: true; readonly result: T }
  | { readonly succeeded: false }
> {
  try {
    return { succeeded: true, result: await promise };
  } catch {
    return { succeeded: false };
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
