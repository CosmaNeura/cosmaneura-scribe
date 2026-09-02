import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { CaptureCapabilities } from "../bff/contracts";
import { FakeIosNativePcmBridge } from "./fake-ios-native-pcm-bridge";
import { IosNativeMicrophoneCaptureSource } from "./ios-native-microphone-source";
import {
  IosNativeMicrophoneBridgeError,
  type IosNativeAppState,
  type IosNativeMicrophoneBridge,
  type IosNativeMicrophoneSession,
} from "./ios-native-pcm-bridge";

const SYNTHETIC_WAV = Uint8Array.from(Buffer.from(
  readFileSync(
    new URL("../../e2e/fixtures/synthetic-pcm16-mono-16khz.wav.b64", import.meta.url),
    "utf8",
  ).trim(),
  "base64",
));

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

describe("IosNativeMicrophoneCaptureSource", () => {
  it("adapts the existing synthetic PCM fixture to canonical mono 16-kHz WAV", async () => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const pcmBytes = syntheticPcmBytes();
    let deliveredReference: Uint8Array | undefined;
    let deliveredCopy: Uint8Array | undefined;

    await source.start({
      capabilities,
      onChunk: async (chunk) => {
        expect(chunk.sequenceNumber).toBe(0);
        expect(chunk.durationMs).toBe(20);
        deliveredReference = chunk.wavBytes;
        deliveredCopy = chunk.wavBytes.slice();
      },
    });
    await bridge.emitPcmPacket({ sequenceNumber: 0, pcmBytes });
    await source.stop();

    expect(bridge.lastConfiguration).toEqual({
      encoding: "pcm_s16le",
      channels: 1,
      sampleRateHz: 16_000,
      targetFramesPerChunk: 320,
      maximumChunks: 2,
    });
    expect(deliveredCopy).toEqual(SYNTHETIC_WAV);
    expect(pcmBytes.every((value) => value === 0)).toBe(true);
    expect(deliveredReference?.every((value) => value === 0)).toBe(true);
    expect(bridge.stopModes).toEqual(["drain"]);
  });

  it("awaits and delivers a current-generation final partial packet during normal stop", async () => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const delivered: Array<{
      readonly sequenceNumber: number;
      readonly durationMs: number;
      readonly wavBytes: Uint8Array;
    }> = [];
    const finalPcmBytes = Uint8Array.from([52, 18, 120, 86]);
    bridge.setFinalPcmPacket({ sequenceNumber: 1, pcmBytes: finalPcmBytes });
    await source.start({
      capabilities,
      onChunk: async (chunk) => {
        delivered.push({ ...chunk, wavBytes: chunk.wavBytes.slice() });
      },
    });
    await bridge.emitPcmPacket({ sequenceNumber: 0, pcmBytes: syntheticPcmBytes() });

    await source.stop();

    expect(bridge.stopModes).toEqual(["drain"]);
    expect(delivered.map(({ sequenceNumber, durationMs }) => ({
      sequenceNumber,
      durationMs,
    }))).toEqual([
      { sequenceNumber: 0, durationMs: 20 },
      { sequenceNumber: 1, durationMs: 0.125 },
    ]);
    expect(readPcm16(delivered[1]?.wavBytes)).toEqual([4_660, 22_136]);
    expect(finalPcmBytes.every((value) => value === 0)).toBe(true);
  });

  it("holds native acknowledgement until downstream persistence releases backpressure", async () => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const gate = deferred<void>();
    let callbackEntered = false;
    let acknowledged = false;

    await source.start({
      capabilities,
      onChunk: async () => {
        callbackEntered = true;
        await gate.promise;
      },
    });
    const acknowledgement = bridge.emitPcmPacket({
      sequenceNumber: 0,
      pcmBytes: syntheticPcmBytes(),
    }).then(() => {
      acknowledged = true;
    });
    await vi.waitFor(() => expect(callbackEntered).toBe(true));
    expect(acknowledged).toBe(false);

    gate.resolve(undefined);
    await acknowledgement;
    expect(acknowledged).toBe(true);
    await source.stop();
  });

  it("fails closed when a native producer violates single-packet backpressure", async () => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const gate = deferred<void>();
    const onError = vi.fn();
    let callbackEntered = false;
    await source.start({
      capabilities,
      onChunk: async () => {
        callbackEntered = true;
        await gate.promise;
      },
      onError,
    });
    const first = bridge.emitPcmPacket({
      sequenceNumber: 0,
      pcmBytes: syntheticPcmBytes(),
    });
    await vi.waitFor(() => expect(callbackEntered).toBe(true));
    const concurrentBytes = nonzeroSyntheticPcmBytes();

    await expect(bridge.emitPcmPacket({
      sequenceNumber: 1,
      pcmBytes: concurrentBytes,
    })).rejects.toMatchObject({ code: "audio_capture_native_protocol_error" });
    expect(concurrentBytes.every((value) => value === 0)).toBe(true);
    expect(onError).toHaveBeenCalledWith("capture_source_stalled");

    gate.resolve(undefined);
    await first;
    await vi.waitFor(() => expect(bridge.stopModes).toEqual(["discard"]));
  });

  it.each([
    {
      name: "a skipped sequence",
      firstSequence: 1,
      pcmBytes: () => nonzeroSyntheticPcmBytes(),
      errorCode: "audio_capture_native_protocol_error",
    },
    {
      name: "an oversized packet",
      firstSequence: 0,
      pcmBytes: () => new Uint8Array(642).fill(7),
      errorCode: "audio_capture_output_limit_exceeded",
    },
  ])("rejects $name with a fixed code and clears transferred PCM", async ({
    firstSequence,
    pcmBytes: createPcmBytes,
    errorCode,
  }) => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const onError = vi.fn();
    const pcmBytes = createPcmBytes();
    await source.start({ capabilities, onChunk: async () => undefined, onError });

    await expect(bridge.emitPcmPacket({
      sequenceNumber: firstSequence,
      pcmBytes,
    })).rejects.toMatchObject({ code: errorCode });
    expect(pcmBytes.every((value) => value === 0)).toBe(true);
    expect(onError).toHaveBeenCalledWith("capture_source_stalled");
    await vi.waitFor(() => expect(bridge.stopModes).toEqual(["discard"]));
  });

  it("rejects an aliased subview and clears its entire backing buffer", async () => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const onError = vi.fn();
    const fullBuffer = new Uint8Array(12).fill(91);
    const aliasedSubview = fullBuffer.subarray(2, 10);
    await source.start({ capabilities, onChunk: async () => undefined, onError });

    await expect(bridge.emitPcmPacket({
      sequenceNumber: 0,
      pcmBytes: aliasedSubview,
    })).rejects.toMatchObject({ code: "audio_capture_native_protocol_error" });
    expect(fullBuffer.every((value) => value === 0)).toBe(true);
    expect(onError).toHaveBeenCalledWith("capture_source_stalled");
  });

  it("enforces the capability-derived packet count ceiling", async () => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const onError = vi.fn();
    await source.start({ capabilities, onChunk: async () => undefined, onError });
    await bridge.emitPcmPacket({ sequenceNumber: 0, pcmBytes: syntheticPcmBytes() });
    await bridge.emitPcmPacket({ sequenceNumber: 1, pcmBytes: syntheticPcmBytes() });
    const excess = nonzeroSyntheticPcmBytes();

    await expect(bridge.emitPcmPacket({
      sequenceNumber: 2,
      pcmBytes: excess,
    })).rejects.toMatchObject({ code: "audio_capture_output_limit_exceeded" });
    expect(excess.every((value) => value === 0)).toBe(true);
    expect(onError).toHaveBeenCalledWith("capture_source_stalled");
  });

  it.each([
    "ios_microphone_permission_denied",
    "ios_microphone_permission_restricted",
  ] as const)("maps %s to a bounded permission failure", async (code) => {
    const bridge = new FakeIosNativePcmBridge();
    bridge.failStartWith(new IosNativeMicrophoneBridgeError(code));
    const source = new IosNativeMicrophoneCaptureSource(bridge);

    await expect(source.start({
      capabilities,
      onChunk: async () => undefined,
    })).rejects.toMatchObject({
      code: "audio_capture_permission_denied",
      message: "audio_capture_permission_denied",
    });
    expect(bridge.startCalls).toBe(1);
    expect(bridge.stopCalls).toBe(1);
    expect(bridge.stopModes).toEqual(["discard"]);
  });

  it("refuses capture while iOS is backgrounded without starting native capture", async () => {
    const bridge = new FakeIosNativePcmBridge();
    bridge.setAppState("background");
    const source = new IosNativeMicrophoneCaptureSource(bridge);

    await expect(source.start({
      capabilities,
      onChunk: async () => undefined,
    })).rejects.toMatchObject({ code: "audio_capture_unavailable" });
    expect(bridge.startCalls).toBe(0);
    expect(bridge.stopCalls).toBe(0);
  });

  it("stops a never-settling foreground check without starting native capture", async () => {
    const neverForeground = new Promise<IosNativeAppState>(() => undefined);
    const getAppState = vi.fn<IosNativeMicrophoneBridge["getAppState"]>()
      .mockReturnValueOnce(neverForeground)
      .mockResolvedValueOnce("foreground");
    const stopNative = vi.fn<IosNativeMicrophoneSession["stop"]>(
      async () => ({ finalPcmPacket: null }),
    );
    const startNative = vi.fn<IosNativeMicrophoneBridge["start"]>(
      () => ({ ready: Promise.resolve(), stop: stopNative }),
    );
    const source = new IosNativeMicrophoneCaptureSource({ getAppState, start: startNative });
    const firstStart = source.start({ capabilities, onChunk: async () => undefined });
    await vi.waitFor(() => expect(getAppState).toHaveBeenCalledOnce());

    await source.stop();
    await expect(firstStart).rejects.toMatchObject({ name: "AbortError" });
    await source.start({ capabilities, onChunk: async () => undefined });
    expect(startNative).toHaveBeenCalledOnce();
    expect(stopNative).not.toHaveBeenCalled();
    await source.stop();
    expect(stopNative).toHaveBeenCalledOnce();
  });

  it("aborts a never-settling foreground check without starting native capture", async () => {
    const neverForeground = new Promise<IosNativeAppState>(() => undefined);
    const getAppState = vi.fn<IosNativeMicrophoneBridge["getAppState"]>(
      () => neverForeground,
    );
    const startNative = vi.fn<IosNativeMicrophoneBridge["start"]>();
    const source = new IosNativeMicrophoneCaptureSource({ getAppState, start: startNative });
    const authority = new AbortController();
    const starting = source.start({
      capabilities,
      onChunk: async () => undefined,
      signal: authority.signal,
    });
    await vi.waitFor(() => expect(getAppState).toHaveBeenCalledOnce());

    authority.abort();

    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(startNative).not.toHaveBeenCalled();
    await expect(source.stop()).resolves.toBeUndefined();
  });

  it("aborts a never-ready native start with one discard shutdown", async () => {
    const neverReady = new Promise<void>(() => undefined);
    const stopNative = vi.fn<IosNativeMicrophoneSession["stop"]>(
      async () => ({ finalPcmPacket: null }),
    );
    const getAppState = vi.fn<IosNativeMicrophoneBridge["getAppState"]>(
      async () => "foreground",
    );
    const startNative = vi.fn<IosNativeMicrophoneBridge["start"]>(
      () => ({ ready: neverReady, stop: stopNative }),
    );
    const bridge: IosNativeMicrophoneBridge = {
      getAppState,
      start: startNative,
    };
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const authority = new AbortController();
    const starting = source.start({
      capabilities,
      onChunk: async () => undefined,
      signal: authority.signal,
    });
    await vi.waitFor(() => expect(startNative).toHaveBeenCalledOnce());

    authority.abort();
    const concurrentStop = source.stop();

    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await concurrentStop;
    expect(stopNative).toHaveBeenCalledOnce();
    expect(stopNative).toHaveBeenCalledWith({ mode: "discard" });
  });

  it("stops a never-ready native start with one discard shutdown", async () => {
    const neverReady = new Promise<void>(() => undefined);
    let activeSessions = 0;
    const firstStop = vi.fn<IosNativeMicrophoneSession["stop"]>(
      async () => {
        activeSessions -= 1;
        return { finalPcmPacket: null };
      },
    );
    const secondStop = vi.fn<IosNativeMicrophoneSession["stop"]>(
      async () => {
        activeSessions -= 1;
        return { finalPcmPacket: null };
      },
    );
    const startNative = vi.fn<IosNativeMicrophoneBridge["start"]>()
      .mockImplementationOnce(() => {
        activeSessions += 1;
        return { ready: neverReady, stop: firstStop };
      })
      .mockImplementationOnce(() => {
        if (activeSessions !== 0) throw new Error("leaked_native_session");
        activeSessions += 1;
        return { ready: Promise.resolve(), stop: secondStop };
      });
    const bridge: IosNativeMicrophoneBridge = {
      getAppState: vi.fn(async () => "foreground" as const),
      start: startNative,
    };
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const starting = source.start({ capabilities, onChunk: async () => undefined });
    await vi.waitFor(() => expect(startNative).toHaveBeenCalledOnce());

    const stopping = source.stop();

    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await stopping;
    expect(firstStop).toHaveBeenCalledOnce();
    expect(firstStop).toHaveBeenCalledWith({ mode: "discard" });
    expect(activeSessions).toBe(0);

    await source.start({ capabilities, onChunk: async () => undefined });
    await source.stop();
    expect(secondStop).toHaveBeenCalledOnce();
    expect(secondStop).toHaveBeenCalledWith({ mode: "drain" });
    expect(activeSessions).toBe(0);
  });

  it("owns and discards a session returned after an early packet violation", async () => {
    const pcmBytes = nonzeroSyntheticPcmBytes();
    const stopNative = vi.fn<IosNativeMicrophoneSession["stop"]>(
      async () => ({ finalPcmPacket: null }),
    );
    let earlyDelivery: Promise<void> | undefined;
    const startNative = vi.fn<IosNativeMicrophoneBridge["start"]>(
      (_configuration, sink) => {
        earlyDelivery = sink.onPcmPacket({ sequenceNumber: 0, pcmBytes });
        void earlyDelivery.catch(() => undefined);
        return { ready: Promise.resolve(), stop: stopNative };
      },
    );
    const bridge: IosNativeMicrophoneBridge = {
      getAppState: vi.fn(async () => "foreground" as const),
      start: startNative,
    };
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const onError = vi.fn();

    await expect(source.start({
      capabilities,
      onChunk: async () => undefined,
      onError,
    })).rejects.toMatchObject({ code: "audio_capture_native_protocol_error" });
    await expect(earlyDelivery).rejects.toMatchObject({
      code: "audio_capture_native_protocol_error",
    });
    expect(pcmBytes.every((value) => value === 0)).toBe(true);
    expect(stopNative).toHaveBeenCalledOnce();
    expect(stopNative).toHaveBeenCalledWith({ mode: "discard" });
  });

  it("rejects stale generation callbacks without affecting a new capture", async () => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const firstInterruption = vi.fn();
    const firstError = vi.fn();
    await source.start({
      capabilities,
      onChunk: async () => undefined,
      onInterruption: firstInterruption,
      onError: firstError,
    });
    await source.stop();

    const secondInterruption = vi.fn();
    const secondError = vi.fn();
    await source.start({
      capabilities,
      onChunk: async () => undefined,
      onInterruption: secondInterruption,
      onError: secondError,
    });
    const staleBytes = nonzeroSyntheticPcmBytes();
    await expect(bridge.emitRetainedPcmPacket(0, {
      sequenceNumber: 0,
      pcmBytes: staleBytes,
    })).rejects.toMatchObject({ code: "audio_capture_stale_generation" });
    bridge.emitRetainedInterruption(0, "ios_capture_backgrounded");
    bridge.emitRetainedError(0, "ios_capture_failed");

    expect(staleBytes.every((value) => value === 0)).toBe(true);
    expect(firstInterruption).not.toHaveBeenCalled();
    expect(firstError).not.toHaveBeenCalled();
    expect(secondInterruption).not.toHaveBeenCalled();
    expect(secondError).not.toHaveBeenCalled();
    expect(bridge.stopCalls).toBe(1);
    await source.stop();
    expect(bridge.stopCalls).toBe(2);
  });

  it("retains a failed native handle, blocks restart, and retries explicit stop", async () => {
    const bridge = new FakeIosNativePcmBridge();
    bridge.failNextStops();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const onError = vi.fn();
    const delivered: number[] = [];
    const finalPcmBytes = Uint8Array.from([52, 18]);
    bridge.setFinalPcmPacket({ sequenceNumber: 0, pcmBytes: finalPcmBytes });
    await source.start({
      capabilities,
      onChunk: async (chunk) => {
        delivered.push(chunk.sequenceNumber);
      },
      onError,
    });

    await expect(source.stop()).rejects.toMatchObject({
      code: "audio_capture_native_stop_failed",
      message: "audio_capture_native_stop_failed",
    });
    expect(onError).toHaveBeenCalledWith("capture_source_failed");
    await expect(source.start({
      capabilities,
      onChunk: async () => undefined,
    })).rejects.toMatchObject({ code: "audio_capture_native_stop_failed" });

    await expect(source.stop()).resolves.toBeUndefined();
    expect(bridge.stopModes).toEqual(["drain", "drain"]);
    expect(delivered).toEqual([0]);
    expect(finalPcmBytes.every((value) => value === 0)).toBe(true);
    await expect(source.start({
      capabilities,
      onChunk: async () => undefined,
    })).resolves.toBeUndefined();
    await source.stop();
  });

  it("retains a failed abort shutdown until an explicit discard retry succeeds", async () => {
    const bridge = new FakeIosNativePcmBridge();
    bridge.failNextStops();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const authority = new AbortController();
    const onError = vi.fn();
    await source.start({
      capabilities,
      onChunk: async () => undefined,
      onError,
      signal: authority.signal,
    });

    authority.abort();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("capture_source_failed"));
    await expect(source.start({
      capabilities,
      onChunk: async () => undefined,
    })).rejects.toMatchObject({ code: "audio_capture_native_stop_failed" });
    await source.stop();

    expect(bridge.stopModes).toEqual(["discard", "discard"]);
  });

  it("retains a failed terminal shutdown until an explicit discard retry succeeds", async () => {
    const bridge = new FakeIosNativePcmBridge();
    bridge.failNextStops();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const onError = vi.fn();
    await source.start({ capabilities, onChunk: async () => undefined, onError });

    bridge.emitError("ios_capture_failed");
    await vi.waitFor(() => expect(bridge.stopCalls).toBe(1));
    await expect(source.start({
      capabilities,
      onChunk: async () => undefined,
    })).rejects.toMatchObject({ code: "audio_capture_native_stop_failed" });
    await source.stop();

    expect(bridge.stopModes).toEqual(["discard", "discard"]);
    expect(onError).toHaveBeenCalledWith("capture_source_failed");
  });

  it.each([
    ["ios_audio_session_interrupted", "audio_session_interrupted"],
    ["ios_audio_route_changed", "audio_route_changed"],
    ["ios_capture_backgrounded", "capture_backgrounded"],
  ] as const)("maps %s to %s and discards", async (nativeCode, sourceCode) => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const onInterruption = vi.fn();
    await source.start({
      capabilities,
      onChunk: async () => undefined,
      onInterruption,
    });

    bridge.emitInterruption(nativeCode);
    expect(onInterruption).toHaveBeenCalledWith(sourceCode);
    await vi.waitFor(() => expect(bridge.stopModes).toEqual(["discard"]));
  });

  it.each([
    ["ios_microphone_permission_revoked", "capture_source_failed"],
    ["ios_capture_stalled", "capture_source_stalled"],
    ["ios_capture_failed", "capture_source_failed"],
  ] as const)("maps terminal %s to %s and discards", async (nativeCode, sourceCode) => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const onError = vi.fn();
    await source.start({ capabilities, onChunk: async () => undefined, onError });

    bridge.emitError(nativeCode);
    expect(onError).toHaveBeenCalledWith(sourceCode);
    await vi.waitFor(() => expect(bridge.stopModes).toEqual(["discard"]));
  });

  it("waits for an acknowledged packet before normal stop finishes", async () => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const gate = deferred<void>();
    let deliveredReference: Uint8Array | undefined;
    let stopFinished = false;
    await source.start({
      capabilities,
      onChunk: async (chunk) => {
        deliveredReference = chunk.wavBytes;
        await gate.promise;
      },
    });
    const pcmBytes = nonzeroSyntheticPcmBytes();
    const delivery = bridge.emitPcmPacket({ sequenceNumber: 0, pcmBytes });
    await vi.waitFor(() => expect(deliveredReference).toBeDefined());

    const stop = source.stop().then(() => {
      stopFinished = true;
    });
    await vi.waitFor(() => expect(bridge.stopCalls).toBe(1));
    expect(stopFinished).toBe(false);
    gate.resolve(undefined);
    await delivery;
    await stop;

    expect(pcmBytes.every((value) => value === 0)).toBe(true);
    expect(deliveredReference?.every((value) => value === 0)).toBe(true);
  });

  it("propagates one late discard after a native drain has begun", async () => {
    const bridge = new FakeIosNativePcmBridge();
    const drainGate = deferred<void>();
    bridge.delayNextStopUntil(drainGate.promise);
    const authority = new AbortController();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    await source.start({
      capabilities,
      onChunk: async () => undefined,
      signal: authority.signal,
    });

    const draining = source.stop();
    await vi.waitFor(() => expect(bridge.stopModes).toEqual(["drain"]));
    authority.abort();
    await vi.waitFor(() => expect(bridge.stopModes).toEqual(["drain", "discard"]));

    drainGate.resolve(undefined);
    await expect(draining).resolves.toBeUndefined();
    await source.stop();
    expect(bridge.stopModes).toEqual(["drain", "discard"]);
  });

  it("awaits a discard requested during final delivery and retains a failed upgrade for retry", async () => {
    const stopModes: string[] = [];
    const finalPcmBytes = Uint8Array.from([52, 18]);
    let stopCall = 0;
    const bridge: IosNativeMicrophoneBridge = {
      getAppState: async () => "foreground",
      start: () => ({
        ready: Promise.resolve(),
        stop: async ({ mode }) => {
          stopModes.push(mode);
          stopCall += 1;
          if (stopCall === 1) {
            return { finalPcmPacket: { sequenceNumber: 0, pcmBytes: finalPcmBytes } };
          }
          if (stopCall === 2) throw new Error("synthetic late discard failure");
          return { finalPcmPacket: null };
        },
      }),
    };
    const deliveryEntered = deferred<void>();
    const deliveryGate = deferred<void>();
    const authority = new AbortController();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    await source.start({
      capabilities,
      onChunk: async () => {
        deliveryEntered.resolve(undefined);
        await deliveryGate.promise;
      },
      signal: authority.signal,
    });

    const draining = source.stop();
    await deliveryEntered.promise;
    expect(stopModes).toEqual(["drain"]);
    authority.abort();
    await vi.waitFor(() => expect(stopModes).toEqual(["drain", "discard"]));
    deliveryGate.resolve(undefined);

    await expect(draining).rejects.toMatchObject({ code: "audio_capture_native_stop_failed" });
    expect(finalPcmBytes.every((value) => value === 0)).toBe(true);
    await expect(source.start({
      capabilities,
      onChunk: async () => undefined,
    })).rejects.toMatchObject({ code: "audio_capture_native_stop_failed" });
    await expect(source.stop()).resolves.toBeUndefined();
    expect(stopModes).toEqual(["drain", "discard", "discard"]);
  });

  it("clears buffers and emits only a fixed code when the consumer rejects", async () => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const onError = vi.fn();
    let deliveredReference: Uint8Array | undefined;
    await source.start({
      capabilities,
      onChunk: async (chunk) => {
        deliveredReference = chunk.wavBytes;
        throw new Error("synthetic downstream detail must not escape");
      },
      onError,
    });
    const pcmBytes = nonzeroSyntheticPcmBytes();

    await expect(bridge.emitPcmPacket({
      sequenceNumber: 0,
      pcmBytes,
    })).rejects.toMatchObject({
      code: "audio_capture_callback_failed",
      message: "audio_capture_callback_failed",
    });
    expect(onError).toHaveBeenCalledWith("capture_source_failed");
    expect(pcmBytes.every((value) => value === 0)).toBe(true);
    expect(deliveredReference?.every((value) => value === 0)).toBe(true);
  });

  it("rejects noncanonical media capabilities before invoking native code", async () => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);

    await expect(source.start({
      capabilities: {
        ...capabilities,
        media: {
          ...capabilities.media,
          sample_rate_hz: 48_000 as CaptureCapabilities["media"]["sample_rate_hz"],
        },
      },
      onChunk: async () => undefined,
    })).rejects.toMatchObject({ code: "audio_capture_invalid_configuration" });
    expect(bridge.startCalls).toBe(0);
  });
});

function syntheticPcmBytes(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(SYNTHETIC_WAV.subarray(44));
}

function nonzeroSyntheticPcmBytes(): Uint8Array<ArrayBuffer> {
  const pcmBytes = syntheticPcmBytes();
  pcmBytes[0] = 52;
  pcmBytes[1] = 18;
  return pcmBytes;
}

function readPcm16(wav: Uint8Array | undefined): readonly number[] {
  if (wav === undefined) return [];
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const samples: number[] = [];
  for (let offset = 44; offset < wav.byteLength; offset += 2) {
    samples.push(view.getInt16(offset, true));
  }
  return samples;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
