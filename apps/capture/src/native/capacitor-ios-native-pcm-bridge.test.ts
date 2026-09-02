import type {
  IOSPCMPlugin,
  IosPcmConfiguration,
  IosPcmEncodedPacket,
  IosPcmEvent,
  IosPcmStopOptions,
} from "@cosmaneura-scribe/capacitor-ios-pcm";
import type { PluginListenerHandle } from "@capacitor/core";
import { describe, expect, it, vi } from "vitest";

import type { CaptureCapabilities } from "../bff/contracts";
import type { IosNativePcmSink } from "./ios-native-pcm-bridge";
import { IosNativeMicrophoneCaptureSource } from "./ios-native-microphone-source";
import {
  CapacitorIosNativePcmBridge,
} from "./capacitor-ios-native-pcm-bridge";

const configuration: IosPcmConfiguration = {
  encoding: "pcm_s16le",
  channels: 1,
  sampleRateHz: 16_000,
  targetFramesPerChunk: 320,
  maximumChunks: 2,
};

const capabilities: CaptureCapabilities = {
  protocol_version: "1.0",
  media: {
    media_type: "audio/wav",
    encoding: "pcm_s16le",
    channels: 1,
    sample_rate_hz: 16_000,
  },
  target_chunk_duration_ms: 20,
  max_envelope_bytes: 684,
  max_chunks: 3,
  remaining_aggregate_plaintext_bytes: 1_368,
  capture_lease_ttl_seconds: 30,
  reservation_window_seconds: 30,
  max_reservations_per_batch: 2,
  upload_concurrency: 1,
};

describe("CapacitorIosNativePcmBridge", () => {
  it("awaits listener installation before starting native capture", async () => {
    const plugin = new FakeIosPcmPlugin();
    const listenerGate = deferred<void>();
    plugin.listenerGate = listenerGate.promise;
    const bridge = new CapacitorIosNativePcmBridge(plugin, 100_000);
    const session = bridge.start(configuration, sink());

    await vi.waitFor(() => expect(plugin.operations).toEqual(["addListener"]));
    expect(plugin.startCalls).toBe(0);
    listenerGate.resolve(undefined);
    await session.ready;

    expect(plugin.operations.slice(0, 3)).toEqual(["addListener", "start", "ready"]);
    await session.stop({ mode: "discard" });
  });

  it("cancels during listener installation without starting or double-removing", async () => {
    const plugin = new FakeIosPcmPlugin();
    const listenerGate = deferred<void>();
    plugin.listenerGate = listenerGate.promise;
    const bridge = new CapacitorIosNativePcmBridge(plugin, 100_000);
    const session = bridge.start(configuration, sink());
    await vi.waitFor(() => expect(plugin.addListenerCalls).toBe(1));

    const stopping = session.stop({ mode: "discard" });
    listenerGate.resolve(undefined);

    await expect(session.ready).rejects.toMatchObject({ code: "ios_capture_start_failed" });
    await expect(stopping).resolves.toEqual({ finalPcmPacket: null });
    expect(plugin.startCalls).toBe(0);
    expect(plugin.removedListeners).toBe(1);
  });

  it("prechecks foreground state before installing a listener or starting", async () => {
    const plugin = new FakeIosPcmPlugin();
    plugin.appState = "background";
    const source = new IosNativeMicrophoneCaptureSource(
      new CapacitorIosNativePcmBridge(plugin, 100_000),
    );

    await expect(source.start({
      capabilities,
      onChunk: async () => undefined,
    })).rejects.toMatchObject({ code: "audio_capture_unavailable" });
    expect(plugin.startCalls).toBe(0);
    expect(plugin.addListenerCalls).toBe(0);
  });

  it("holds one packet until downstream settles, clears it, and acknowledges in finally", async () => {
    const plugin = new FakeIosPcmPlugin();
    const bridge = new CapacitorIosNativePcmBridge(plugin, 100_000);
    const downstream = deferred<void>();
    let transferred: Uint8Array<ArrayBuffer> | undefined;
    const session = bridge.start(configuration, sink({
      onPcmPacket: async (packet) => {
        transferred = packet.pcmBytes;
        await downstream.promise;
        throw new Error("synthetic_downstream_failure");
      },
    }));
    await session.ready;

    plugin.emit(packetEvent(plugin.sessionToken, 0, [1, 2, 3, 4]));
    await vi.waitFor(() => expect(transferred).toBeDefined());
    expect(Array.from(transferred ?? [])).toEqual([1, 2, 3, 4]);
    expect(plugin.acknowledgements).toEqual([]);

    downstream.resolve(undefined);
    await vi.waitFor(() => expect(plugin.acknowledgements).toEqual([0]));
    expect(transferred?.every((value) => value === 0)).toBe(true);
    await session.stop({ mode: "discard" });
  });

  it("recovers a pending event through bounded replay and then acknowledges it", async () => {
    const plugin = new FakeIosPcmPlugin();
    const delivered: number[] = [];
    const bridge = new CapacitorIosNativePcmBridge(plugin, 5);
    const session = bridge.start(configuration, sink({
      onPcmPacket: async (packet) => {
        delivered.push(packet.sequenceNumber);
      },
    }));
    await session.ready;
    plugin.pendingPacket = packet(plugin.sessionToken, 0, [4, 3, 2, 1]);

    await vi.waitFor(() => expect(delivered).toEqual([0]));
    expect(plugin.replayCalls).toContain(0);
    expect(plugin.acknowledgements).toEqual([0]);
    expect(plugin.heartbeatCalls).toBeGreaterThan(0);
    await session.stop({ mode: "discard" });
  });

  it("waits for packet delivery and acknowledgement before a drain stop", async () => {
    const plugin = new FakeIosPcmPlugin();
    const downstream = deferred<void>();
    const bridge = new CapacitorIosNativePcmBridge(plugin, 100_000);
    const session = bridge.start(configuration, sink({
      onPcmPacket: async () => downstream.promise,
    }));
    await session.ready;
    plugin.emit(packetEvent(plugin.sessionToken, 0, [1, 2, 3, 4]));
    await vi.waitFor(() => expect(plugin.acknowledgements).toEqual([]));

    const stopping = session.stop({ mode: "drain" });
    await Promise.resolve();
    expect(plugin.stopOptions).toEqual([]);

    downstream.resolve(undefined);
    await expect(stopping).resolves.toEqual({ finalPcmPacket: null });
    expect(plugin.acknowledgements).toEqual([0]);
    expect(plugin.stopOptions).toHaveLength(1);
  });

  it("lets a coalesced discard upgrade bypass a blocked drain delivery", async () => {
    const plugin = new FakeIosPcmPlugin();
    const downstream = deferred<void>();
    const bridge = new CapacitorIosNativePcmBridge(plugin, 100_000);
    const session = bridge.start(configuration, sink({
      onPcmPacket: async () => downstream.promise,
    }));
    await session.ready;
    plugin.emit(packetEvent(plugin.sessionToken, 0, [1, 2, 3, 4]));

    const draining = session.stop({ mode: "drain" });
    const discarding = session.stop({ mode: "discard" });
    await vi.waitFor(() => expect(plugin.stopOptions).toHaveLength(1));
    expect(plugin.stopOptions[0]).toMatchObject({ mode: "discard" });
    await expect(Promise.all([draining, discarding])).resolves.toEqual([
      { finalPcmPacket: null },
      { finalPcmPacket: null },
    ]);

    downstream.resolve(undefined);
  });

  it("propagates exactly one discard when drain is already inside native stop", async () => {
    const plugin = new FakeIosPcmPlugin();
    const drainGate = deferred<void>();
    plugin.delayDrainStopUntil(drainGate.promise);
    const bridge = new CapacitorIosNativePcmBridge(plugin, 100_000);
    const session = bridge.start(configuration, sink());
    await session.ready;

    const draining = session.stop({ mode: "drain" });
    await vi.waitFor(() => expect(plugin.stopOptions.map(({ mode }) => mode)).toEqual(["drain"]));
    const firstDiscard = session.stop({ mode: "discard" });
    const secondDiscard = session.stop({ mode: "discard" });
    await vi.waitFor(() => expect(plugin.stopOptions.map(({ mode }) => mode)).toEqual([
      "drain",
      "discard",
    ]));

    drainGate.resolve(undefined);
    await expect(Promise.all([draining, firstDiscard, secondDiscard])).resolves.toEqual([
      { finalPcmPacket: null },
      { finalPcmPacket: null },
      { finalPcmPacket: null },
    ]);
    expect(plugin.removedListeners).toBe(1);
  });

  it("clears a retained drain final when discard arrives during listener removal", async () => {
    const plugin = new FakeIosPcmPlugin();
    const listenerRemovalGate = deferred<void>();
    plugin.delayListenerRemovalUntil(listenerRemovalGate.promise);
    plugin.stopPacket = packet("1.fragment_1", 0, [9, 8, 7, 6]);
    const fillSpy = vi.spyOn(Uint8Array.prototype, "fill");
    const bridge = new CapacitorIosNativePcmBridge(plugin, 100_000);
    const session = bridge.start(configuration, sink());
    await session.ready;

    const draining = session.stop({ mode: "drain" });
    await vi.waitFor(() => expect(plugin.listenerRemovalCalls).toBe(1));
    plugin.stopFailuresRemaining = 1;
    const discarding = session.stop({ mode: "discard" });
    await vi.waitFor(() => expect(plugin.stopOptions.map(({ mode }) => mode)).toEqual([
      "drain",
      "discard",
    ]));
    expect(fillSpy.mock.instances.some((bytes: unknown) => (
      bytes instanceof Uint8Array &&
      bytes.byteLength === 4 &&
      bytes.every((value) => value === 0)
    ))).toBe(true);

    listenerRemovalGate.resolve(undefined);
    await expect(Promise.all([draining, discarding])).rejects.toThrow("ios_capture_stop_failed");
    expect(() => bridge.start(configuration, sink())).toThrow("ios_capture_start_failed");
    await expect(session.stop({ mode: "discard" })).resolves.toEqual({ finalPcmPacket: null });
    expect(plugin.stopOptions.map(({ mode }) => mode)).toEqual(["drain", "discard", "discard"]);
    expect(plugin.removedListeners).toBe(1);
    fillSpy.mockRestore();
  });

  it("retains the token and listener after stop failure, then clears a discard final", async () => {
    const plugin = new FakeIosPcmPlugin();
    plugin.stopFailuresRemaining = 1;
    plugin.stopPacket = packet("1.fragment_1", 0, [9, 8, 7, 6]);
    const bridge = new CapacitorIosNativePcmBridge(plugin, 100_000);
    const session = bridge.start(configuration, sink());
    await session.ready;

    await expect(session.stop({ mode: "discard" })).rejects.toThrow("ios_capture_stop_failed");
    expect(plugin.removedListeners).toBe(0);
    await expect(session.stop({ mode: "discard" })).resolves.toEqual({ finalPcmPacket: null });
    expect(plugin.stopOptions.map(({ sessionToken, mode }) => ({ sessionToken, mode }))).toEqual([
      { sessionToken: "1.fragment_1", mode: "discard" },
      { sessionToken: "1.fragment_1", mode: "discard" },
    ]);
    expect(plugin.removedListeners).toBe(1);
  });

  it("retains a drain final across cleanup failure and lets discard clear it on retry", async () => {
    const plugin = new FakeIosPcmPlugin();
    plugin.removeFailuresRemaining = 1;
    plugin.stopPacket = packet("1.fragment_1", 0, [9, 8, 7, 6]);
    const bridge = new CapacitorIosNativePcmBridge(plugin, 100_000);
    const session = bridge.start(configuration, sink());
    await session.ready;

    await expect(session.stop({ mode: "drain" })).rejects.toThrow("ios_capture_stop_failed");
    await expect(session.stop({ mode: "discard" })).resolves.toEqual({ finalPcmPacket: null });
    expect(plugin.stopOptions.map(({ mode }) => mode)).toEqual(["drain", "discard"]);
    expect(plugin.removedListeners).toBe(1);
  });

  it("rejects stale-generation events without decoding, delivery, or acknowledgement", async () => {
    const plugin = new FakeIosPcmPlugin();
    const firstDelivery = vi.fn(async () => undefined);
    const bridge = new CapacitorIosNativePcmBridge(plugin, 100_000);
    const first = bridge.start(configuration, sink({ onPcmPacket: firstDelivery }));
    await first.ready;
    const oldToken = plugin.sessionToken;
    await first.stop({ mode: "discard" });

    const secondDelivery = vi.fn(async () => undefined);
    const second = bridge.start(configuration, sink({ onPcmPacket: secondDelivery }));
    await second.ready;
    plugin.emitRetained(0, packetEvent(oldToken, 0, [1, 2, 3, 4]));
    await Promise.resolve();

    expect(firstDelivery).not.toHaveBeenCalled();
    expect(secondDelivery).not.toHaveBeenCalled();
    expect(plugin.acknowledgements).toEqual([]);
    await second.stop({ mode: "discard" });
  });

  it("bounds malformed Base64 before delivery, acknowledges, and emits only a fixed code", async () => {
    const plugin = new FakeIosPcmPlugin();
    const onPcmPacket = vi.fn(async () => undefined);
    const onError = vi.fn();
    const bridge = new CapacitorIosNativePcmBridge(plugin, 100_000);
    const session = bridge.start(configuration, sink({ onPcmPacket, onError }));
    await session.ready;

    plugin.emit({
      kind: "packet",
      packet: {
        sessionToken: plugin.sessionToken,
        sequenceNumber: 0,
        pcmBase64: "A".repeat(2_560_004),
      },
    });

    await vi.waitFor(() => expect(plugin.acknowledgements).toEqual([0]));
    expect(onPcmPacket).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("ios_capture_failed");
    expect(JSON.stringify(onError.mock.calls)).not.toContain("pcmBase64");
    await session.stop({ mode: "discard" });
  });

  it("maps native details to exact bounded start codes", async () => {
    const plugin = new FakeIosPcmPlugin();
    plugin.readyError = Object.assign(new Error("native device detail"), {
      code: "ios_microphone_permission_denied",
    });
    const bridge = new CapacitorIosNativePcmBridge(plugin, 100_000);
    const session = bridge.start(configuration, sink());

    await expect(session.ready).rejects.toMatchObject({
      code: "ios_microphone_permission_denied",
      message: "ios_microphone_permission_denied",
    });
    await session.stop({ mode: "discard" });
  });

  it("auto-closes a terminal source and keeps a later stop idempotent", async () => {
    const plugin = new FakeIosPcmPlugin();
    const onError = vi.fn();
    const source = new IosNativeMicrophoneCaptureSource(
      new CapacitorIosNativePcmBridge(plugin, 100_000),
    );
    await source.start({
      capabilities,
      onChunk: async () => undefined,
      onError,
    });

    plugin.emit({
      kind: "terminal",
      sessionToken: plugin.sessionToken,
      code: "ios_capture_stalled",
    });

    await vi.waitFor(() => expect(plugin.stopOptions).toHaveLength(1));
    await vi.waitFor(() => expect(plugin.removedListeners).toBe(1));
    expect(plugin.stopOptions[0]).toMatchObject({ mode: "discard" });
    expect(onError).toHaveBeenCalledWith("capture_source_stalled");

    await source.stop();
    expect(plugin.stopOptions).toHaveLength(1);
  });
});

class FakeIosPcmPlugin implements IOSPCMPlugin {
  public appState: "foreground" | "background" = "foreground";
  public listenerGate: Promise<void> | undefined;
  public pendingPacket: IosPcmEncodedPacket | undefined;
  public readyError: unknown;
  public stopFailuresRemaining = 0;
  public removeFailuresRemaining = 0;
  public stopPacket: IosPcmEncodedPacket | null = null;
  public sessionToken = "0.unstarted";
  public startCalls = 0;
  public addListenerCalls = 0;
  public removedListeners = 0;
  public listenerRemovalCalls = 0;
  public heartbeatCalls = 0;
  public readonly operations: string[] = [];
  public readonly acknowledgements: number[] = [];
  public readonly replayCalls: number[] = [];
  public readonly stopOptions: IosPcmStopOptions[] = [];
  readonly #listeners: Array<(event: IosPcmEvent) => void> = [];
  #activeListener: ((event: IosPcmEvent) => void) | undefined;
  #drainStopGate: Promise<void> | undefined;
  #listenerRemovalGate: Promise<void> | undefined;
  #generation = 0;

  public async getAppState() {
    return { state: this.appState };
  }

  public async start(options: IosPcmConfiguration) {
    expect(options).toEqual(configuration);
    this.operations.push("start");
    this.startCalls += 1;
    this.#generation += 1;
    this.sessionToken = `${this.#generation}.fragment_${this.#generation}`;
    return { sessionToken: this.sessionToken };
  }

  public async ready() {
    this.operations.push("ready");
    if (this.readyError instanceof Error) throw this.readyError;
    return {};
  }

  public async heartbeat() {
    this.heartbeatCalls += 1;
    return {};
  }

  public async stop(options: IosPcmStopOptions) {
    this.stopOptions.push(options);
    if (options.mode === "drain" && this.#drainStopGate !== undefined) {
      const gate = this.#drainStopGate;
      this.#drainStopGate = undefined;
      await gate;
    }
    if (this.stopFailuresRemaining > 0) {
      this.stopFailuresRemaining -= 1;
      throw new Error("native stop detail");
    }
    const finalPcmPacket = this.stopPacket;
    this.stopPacket = null;
    return { finalPcmPacket };
  }

  public delayDrainStopUntil(gate: Promise<void>): void {
    this.#drainStopGate = gate;
  }

  public delayListenerRemovalUntil(gate: Promise<void>): void {
    this.#listenerRemovalGate = gate;
  }

  public async acknowledge(options: { sessionToken: string; sequenceNumber: number }) {
    this.acknowledgements.push(options.sequenceNumber);
    this.pendingPacket = undefined;
    return { result: "accepted" as const };
  }

  public async replayPendingPacket(options: { sessionToken: string; sequenceNumber: number }) {
    this.replayCalls.push(options.sequenceNumber);
    if (this.pendingPacket === undefined) return { result: "stale" as const };
    this.emit({ kind: "packet", packet: this.pendingPacket });
    return { result: "replayed" as const };
  }

  public async addListener(
    _eventName: "iosNativePcmEvent",
    listener: (event: IosPcmEvent) => void,
  ): Promise<PluginListenerHandle> {
    this.operations.push("addListener");
    this.addListenerCalls += 1;
    this.#listeners.push(listener);
    this.#activeListener = listener;
    if (this.listenerGate !== undefined) await this.listenerGate;
    return {
      remove: async () => {
        this.listenerRemovalCalls += 1;
        if (this.#listenerRemovalGate !== undefined) {
          const gate = this.#listenerRemovalGate;
          this.#listenerRemovalGate = undefined;
          await gate;
        }
        if (this.removeFailuresRemaining > 0) {
          this.removeFailuresRemaining -= 1;
          throw new Error("listener removal detail");
        }
        this.removedListeners += 1;
        if (this.#activeListener === listener) this.#activeListener = undefined;
      },
    };
  }

  public emit(event: IosPcmEvent): void {
    this.#activeListener?.(event);
  }

  public emitRetained(index: number, event: IosPcmEvent): void {
    this.#listeners[index]?.(event);
  }
}

function packetEvent(
  sessionToken: string,
  sequenceNumber: number,
  bytes: readonly number[],
): IosPcmEvent {
  return { kind: "packet", packet: packet(sessionToken, sequenceNumber, bytes) };
}

function packet(
  sessionToken: string,
  sequenceNumber: number,
  bytes: readonly number[],
): IosPcmEncodedPacket {
  return {
    sessionToken,
    sequenceNumber,
    pcmBase64: Buffer.from(bytes).toString("base64"),
  };
}

function sink(overrides: Partial<{
  onPcmPacket: IosNativePcmSink["onPcmPacket"];
  onInterruption: IosNativePcmSink["onInterruption"];
  onError: IosNativePcmSink["onError"];
}> = {}): IosNativePcmSink {
  return {
    onPcmPacket: overrides.onPcmPacket ?? (async () => undefined),
    onInterruption: overrides.onInterruption ?? (() => undefined),
    onError: overrides.onError ?? (() => undefined),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
