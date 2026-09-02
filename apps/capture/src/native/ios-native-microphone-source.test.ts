import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { CaptureCapabilities } from "../bff/contracts";
import { FakeIosNativePcmBridge } from "./fake-ios-native-pcm-bridge";
import { IosNativeMicrophoneCaptureSource } from "./ios-native-microphone-source";
import {
  IosNativeMicrophoneBridgeError,
  type IosNativeMicrophoneBridge,
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
    expect(bridge.stopCalls).toBe(1);
  });

  it("holds native acknowledgement until downstream persistence releases backpressure", async () => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const gate = deferred();
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

    gate.resolve();
    await acknowledgement;
    expect(acknowledged).toBe(true);
    await source.stop();
  });

  it("fails closed when a native producer violates single-packet backpressure", async () => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const gate = deferred();
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
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith("capture_source_stalled");

    gate.resolve();
    await first;
    await vi.waitFor(() => expect(bridge.stopCalls).toBe(1));
  });

  it("rejects and clears a packet emitted before native start resolves", async () => {
    const pcmBytes = nonzeroSyntheticPcmBytes();
    const getAppState = vi.fn<IosNativeMicrophoneBridge["getAppState"]>(
      async () => "foreground",
    );
    const startNative = vi.fn<IosNativeMicrophoneBridge["start"]>(
      async (_configuration, sink) => {
        await sink.onPcmPacket({ sequenceNumber: 0, pcmBytes });
      },
    );
    const stopNative = vi.fn<IosNativeMicrophoneBridge["stop"]>(async () => undefined);
    const bridge: IosNativeMicrophoneBridge = {
      getAppState,
      start: startNative,
      stop: stopNative,
    };
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const onError = vi.fn();

    await expect(source.start({
      capabilities,
      onChunk: async () => undefined,
      onError,
    })).rejects.toMatchObject({ code: "audio_capture_native_protocol_error" });
    expect(pcmBytes.every((value) => value === 0)).toBe(true);
    expect(onError).toHaveBeenCalledWith("capture_source_stalled");
    expect(stopNative).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "a skipped sequence",
      firstSequence: 1,
      pcmBytes: () => syntheticPcmBytes(),
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
    await vi.waitFor(() => expect(bridge.stopCalls).toBe(1));
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
  });

  it("refuses capture while iOS is backgrounded without starting the bridge", async () => {
    const bridge = new FakeIosNativePcmBridge();
    bridge.setAppState("background");
    const source = new IosNativeMicrophoneCaptureSource(bridge);

    await expect(source.start({
      capabilities,
      onChunk: async () => undefined,
    })).rejects.toMatchObject({
      code: "audio_capture_unavailable",
      message: "audio_capture_unavailable",
    });
    expect(bridge.startCalls).toBe(0);
    expect(bridge.stopCalls).toBe(0);
  });

  it("fails closed if the app backgrounds while native start is completing", async () => {
    const getAppState = vi.fn()
      .mockResolvedValueOnce("foreground")
      .mockResolvedValueOnce("background");
    const startNative = vi.fn(async () => undefined);
    const stopNative = vi.fn(async () => undefined);
    const bridge: IosNativeMicrophoneBridge = {
      getAppState,
      start: startNative,
      stop: stopNative,
    };
    const source = new IosNativeMicrophoneCaptureSource(bridge);

    await expect(source.start({
      capabilities,
      onChunk: async () => undefined,
    })).rejects.toMatchObject({ code: "audio_capture_unavailable" });
    expect(startNative).toHaveBeenCalledOnce();
    expect(stopNative).toHaveBeenCalledOnce();
  });

  it.each([
    ["ios_audio_session_interrupted", "audio_session_interrupted"],
    ["ios_audio_route_changed", "audio_route_changed"],
    ["ios_capture_backgrounded", "capture_backgrounded"],
  ] as const)("maps %s to %s and stops", async (nativeCode, sourceCode) => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const onInterruption = vi.fn();
    await source.start({
      capabilities,
      onChunk: async () => undefined,
      onInterruption,
    });

    bridge.emitInterruption(nativeCode);
    expect(onInterruption).toHaveBeenCalledOnce();
    expect(onInterruption).toHaveBeenCalledWith(sourceCode);
    await vi.waitFor(() => expect(bridge.stopCalls).toBe(1));
  });

  it.each([
    ["ios_microphone_permission_revoked", "capture_source_failed"],
    ["ios_capture_stalled", "capture_source_stalled"],
    ["ios_capture_failed", "capture_source_failed"],
  ] as const)("maps terminal %s to %s and stops", async (nativeCode, sourceCode) => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const onError = vi.fn();
    await source.start({ capabilities, onChunk: async () => undefined, onError });

    bridge.emitError(nativeCode);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(sourceCode);
    await vi.waitFor(() => expect(bridge.stopCalls).toBe(1));
  });

  it("stops on abort and makes repeated stop calls safe", async () => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const authority = new AbortController();
    await source.start({
      capabilities,
      onChunk: async () => undefined,
      signal: authority.signal,
    });

    authority.abort();
    await vi.waitFor(() => expect(bridge.stopCalls).toBe(1));
    await expect(source.stop()).resolves.toBeUndefined();
    expect(bridge.stopCalls).toBe(1);
  });

  it("waits for an acknowledged packet before stop finishes and clears both buffers", async () => {
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const gate = deferred();
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
    gate.resolve();
    await delivery;
    await stop;

    expect(pcmBytes.every((value) => value === 0)).toBe(true);
    expect(deliveredReference?.every((value) => value === 0)).toBe(true);
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

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
