import { describe, expect, it, vi } from "vitest";

import type { CaptureCapabilities } from "../bff/contracts";
import {
  BrowserMicrophoneCaptureSource,
  type BrowserMicrophoneDependencies,
} from "./browser-microphone-source";

const capabilities: CaptureCapabilities = {
  protocol_version: "1.0",
  media: {
    media_type: "audio/wav",
    encoding: "pcm_s16le",
    channels: 1,
    sample_rate_hz: 16_000,
  },
  target_chunk_duration_ms: 1,
  max_envelope_bytes: 80,
  max_chunks: 2,
  remaining_aggregate_plaintext_bytes: 160,
  capture_lease_ttl_seconds: 30,
  reservation_window_seconds: 30,
  max_reservations_per_batch: 2,
  upload_concurrency: 1,
};

describe("BrowserMicrophoneCaptureSource", () => {
  it("runs getUserMedia through AudioWorklet and emits capability-shaped PCM16 WAV", async () => {
    const harness = createHarness();
    const chunks: Array<{
      readonly sequenceNumber: number;
      readonly durationMs: number;
      readonly wavBytes: Uint8Array;
    }> = [];
    let deliveredBytes: Uint8Array | undefined;
    const source = new BrowserMicrophoneCaptureSource(harness.dependencies);

    await source.start({
      capabilities,
      onChunk: async (chunk) => {
        deliveredBytes = chunk.wavBytes;
        chunks.push({ ...chunk, wavBytes: chunk.wavBytes.slice() });
      },
    });
    harness.worklet.dispatch(
      0,
      [0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75],
    );
    harness.worklet.dispatch(
      1,
      [1, 1, 0.75, 0.75, 0.5, 0.5, 0.25, 0.25, 1, 1, 0.75, 0.75, 0.5, 0.5, 0.25, 0.25],
    );
    await source.stop();

    expect(harness.getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: false,
        channelCount: { ideal: capabilities.media.channels },
        echoCancellation: false,
        noiseSuppression: false,
        sampleRate: { ideal: capabilities.media.sample_rate_hz },
      },
      video: false,
    });
    expect(harness.addModule).toHaveBeenCalledWith(
      expect.stringContaining("pcm-capture-worklet.ts"),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ sequenceNumber: 0, durationMs: 1 });
    const wav = chunks[0]?.wavBytes;
    expect(new TextDecoder().decode(wav?.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav?.subarray(8, 12))).toBe("WAVE");
    const view = new DataView(wav?.buffer ?? new ArrayBuffer(0));
    expect(view.getUint32(24, true)).toBe(capabilities.media.sample_rate_hz);
    expect(wav?.byteLength).toBe(76);
    expect(readPcm16(wav)).toEqual([
      0, 8_192, 16_384, 24_575, 0, 8_192, 16_384, 24_575,
      32_767, 24_575, 16_384, 8_192, 32_767, 24_575, 16_384, 8_192,
    ]);
    expect(deliveredBytes?.every((value) => value === 0)).toBe(true);
    expect(harness.track.stopped).toBe(true);
    expect(harness.context.state).toBe("closed");
  });

  it("flushes a final short WAV without silence padding", async () => {
    const harness = createHarness();
    const chunks: Array<{ readonly durationMs: number; readonly wavBytes: Uint8Array }> = [];
    const source = new BrowserMicrophoneCaptureSource(harness.dependencies);
    await source.start({
      capabilities,
      onChunk: async (chunk) => {
        chunks.push({ ...chunk, wavBytes: chunk.wavBytes.slice() });
      },
    });
    harness.worklet.dispatch(0, [0.5, 0.5]);
    await source.stop();

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.durationMs).toBe(0.0625);
    expect(chunks[0]?.wavBytes.byteLength).toBe(46);
    expect(readPcm16(chunks[0]?.wavBytes)).toEqual([16_384]);
  });

  it("fails closed when AudioWorklet continuity is broken", async () => {
    const harness = createHarness();
    const onError = vi.fn();
    const source = new BrowserMicrophoneCaptureSource(harness.dependencies);
    await source.start({
      capabilities,
      onChunk: async () => undefined,
      onError,
    });
    harness.worklet.dispatch(1, [0, 0]);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith("capture_source_stalled");
    await Promise.resolve();
    await expect(source.stop()).resolves.toBeUndefined();
  });

  it("reports device and route interruptions immediately with fixed codes", async () => {
    const disconnected = createHarness();
    const disconnectedCallback = vi.fn();
    const disconnectedSource = new BrowserMicrophoneCaptureSource(disconnected.dependencies);
    await disconnectedSource.start({
      capabilities,
      onChunk: async () => undefined,
      onInterruption: disconnectedCallback,
    });
    disconnected.track.dispatchEvent(new Event("ended"));
    expect(disconnectedCallback).toHaveBeenCalledWith("audio_device_disconnected");
    await expect(disconnectedSource.stop()).resolves.toBeUndefined();

    const routeChanged = createHarness();
    const routeChangedCallback = vi.fn();
    const routeChangedSource = new BrowserMicrophoneCaptureSource(routeChanged.dependencies);
    await routeChangedSource.start({
      capabilities,
      onChunk: async () => undefined,
      onInterruption: routeChangedCallback,
    });
    routeChanged.track.dispatchEvent(new Event("mute"));
    expect(routeChangedCallback).toHaveBeenCalledWith("audio_route_changed");
    await expect(routeChangedSource.stop()).resolves.toBeUndefined();
  });

  it("reports an unexpected AudioContext suspension before cleanup", async () => {
    const harness = createHarness();
    const onInterruption = vi.fn();
    const source = new BrowserMicrophoneCaptureSource(harness.dependencies);
    await source.start({
      capabilities,
      onChunk: async () => undefined,
      onInterruption,
    });
    harness.context.interrupt();
    expect(onInterruption).toHaveBeenCalledWith("audio_context_suspended");
    await expect(source.stop()).resolves.toBeUndefined();
  });

  it("stops foreground capture on visibility loss or page hide", async () => {
    const hidden = createHarness();
    const hiddenCallback = vi.fn();
    const hiddenSource = new BrowserMicrophoneCaptureSource(hidden.dependencies);
    await hiddenSource.start({
      capabilities,
      onChunk: async () => undefined,
      onInterruption: hiddenCallback,
    });
    hidden.visibilityDocument.hide();
    expect(hiddenCallback).toHaveBeenCalledWith("capture_backgrounded");
    await expect(hiddenSource.stop()).resolves.toBeUndefined();
    expect(hidden.track.stopped).toBe(true);

    const pageHidden = createHarness();
    const pageHiddenCallback = vi.fn();
    const pageHiddenSource = new BrowserMicrophoneCaptureSource(pageHidden.dependencies);
    await pageHiddenSource.start({
      capabilities,
      onChunk: async () => undefined,
      onInterruption: pageHiddenCallback,
    });
    pageHidden.pageLifecycleWindow.dispatchEvent(new Event("pagehide"));
    expect(pageHiddenCallback).toHaveBeenCalledWith("capture_backgrounded");
    await expect(pageHiddenSource.stop()).resolves.toBeUndefined();
    expect(pageHidden.track.stopped).toBe(true);
  });

  it("refuses microphone access when the page is already hidden", async () => {
    const harness = createHarness();
    harness.visibilityDocument.hide();
    const source = new BrowserMicrophoneCaptureSource(harness.dependencies);
    await expect(
      source.start({ capabilities, onChunk: async () => undefined }),
    ).rejects.toThrow(
      expect.objectContaining({ code: "audio_capture_unavailable" }),
    );
    expect(harness.getUserMedia).not.toHaveBeenCalled();
  });

  it("closes a stream if the page is hidden while permission is pending", async () => {
    const harness = createHarness();
    let resolveStream: ((stream: MediaStream) => void) | undefined;
    harness.getUserMedia.mockReturnValueOnce(new Promise((resolve) => {
      resolveStream = resolve;
    }));
    const source = new BrowserMicrophoneCaptureSource(harness.dependencies);
    const start = source.start({ capabilities, onChunk: async () => undefined });
    harness.visibilityDocument.hide();
    resolveStream?.(harness.stream);

    await expect(start).rejects.toThrow(
      expect.objectContaining({ code: "audio_capture_unavailable" }),
    );
    expect(harness.track.stopped).toBe(true);
    await expect(source.stop()).resolves.toBeUndefined();
  });

  it("closes a stream when authority is aborted while the worklet module is pending", async () => {
    const harness = createHarness();
    const workletModule = deferred();
    harness.addModule.mockReturnValueOnce(workletModule.promise);
    const controller = new AbortController();
    const source = new BrowserMicrophoneCaptureSource(harness.dependencies);
    const start = source.start({
      capabilities,
      onChunk: async () => undefined,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(harness.addModule).toHaveBeenCalledOnce());
    const rejected = expect(start).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    await vi.waitFor(() => expect(harness.track.stopped).toBe(true));
    expect(harness.context.state).toBe("closed");
    workletModule.resolve();
    await rejected;
  });

  it("closes a stream when the page hides while the worklet module is pending", async () => {
    const harness = createHarness();
    const workletModule = deferred();
    harness.addModule.mockReturnValueOnce(workletModule.promise);
    const onInterruption = vi.fn();
    const source = new BrowserMicrophoneCaptureSource(harness.dependencies);
    const start = source.start({
      capabilities,
      onChunk: async () => undefined,
      onInterruption,
    });
    await vi.waitFor(() => expect(harness.addModule).toHaveBeenCalledOnce());
    const rejected = expect(start).rejects.toThrow(
      expect.objectContaining({ code: "audio_capture_unavailable" }),
    );

    harness.visibilityDocument.hide();
    expect(onInterruption).toHaveBeenCalledWith("capture_backgrounded");
    await vi.waitFor(() => expect(harness.track.stopped).toBe(true));
    expect(harness.context.state).toBe("closed");
    workletModule.resolve();
    await rejected;
  });

  it("maps microphone denial to a fixed error without exposing browser details", async () => {
    const harness = createHarness();
    harness.getUserMedia.mockRejectedValueOnce(
      Object.assign(new Error("device-specific detail"), { name: "NotAllowedError" }),
    );
    const source = new BrowserMicrophoneCaptureSource(harness.dependencies);
    await expect(
      source.start({ capabilities, onChunk: async () => undefined }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: "audio_capture_permission_denied",
        message: "audio_capture_permission_denied",
      }),
    );
    expect(harness.track.stopped).toBe(false);
  });
});

function createHarness(): {
  readonly dependencies: BrowserMicrophoneDependencies;
  readonly getUserMedia: ReturnType<typeof vi.fn<() => Promise<MediaStream>>>;
  readonly addModule: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;
  readonly context: FakeAudioContext;
  readonly visibilityDocument: FakeVisibilityDocument;
  readonly pageLifecycleWindow: EventTarget;
  readonly stream: MediaStream;
  readonly track: FakeTrack;
  readonly worklet: FakeWorkletNode;
} {
  const track = new FakeTrack();
  const stream = {
    getAudioTracks: () => [track as unknown as MediaStreamTrack],
    getTracks: () => [track as unknown as MediaStreamTrack],
  } as MediaStream;
  const getUserMedia = vi.fn<() => Promise<MediaStream>>().mockResolvedValue(stream);
  const addModule = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
  const context = new FakeAudioContext(addModule);
  const worklet = new FakeWorkletNode();
  const visibilityDocument = new FakeVisibilityDocument();
  const pageLifecycleWindow = new EventTarget();
  return {
    dependencies: {
      mediaDevices: { getUserMedia },
      createAudioContext: () => context as unknown as AudioContext,
      createAudioWorkletNode: () => worklet as unknown as AudioWorkletNode,
      workletModuleUrl: new URL("./pcm-capture-worklet.ts", import.meta.url),
      visibilityDocument,
      pageLifecycleWindow,
    },
    getUserMedia,
    addModule,
    context,
    visibilityDocument,
    pageLifecycleWindow,
    stream,
    track,
    worklet,
  };
}

class FakeVisibilityDocument extends EventTarget {
  public visibilityState: DocumentVisibilityState = "visible";

  public hide(): void {
    this.visibilityState = "hidden";
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

class FakeTrack extends EventTarget {
  public stopped = false;

  public stop(): void {
    this.stopped = true;
  }
}

class FakeAudioNode {
  public readonly connect = vi.fn((_destination: unknown) => _destination);
  public readonly disconnect = vi.fn();
}

class FakeWorkletNode extends FakeAudioNode {
  public onprocessorerror: ((event: Event) => void) | null = null;
  public readonly port = { onmessage: null } as unknown as MessagePort;

  public dispatch(sequence: number, samples: readonly number[]): void {
    this.port.onmessage?.({
      data: {
        type: "pcm",
        version: 1,
        sequence,
        frames: Float32Array.from(samples).buffer,
      },
    } as MessageEvent);
  }
}

class FakeAudioContext extends EventTarget {
  public readonly sampleRate = 32_000;
  public state: AudioContextState = "suspended";
  public readonly destination = new FakeAudioNode() as unknown as AudioDestinationNode;
  public readonly audioWorklet: AudioWorklet;
  readonly #mediaSource = new FakeAudioNode();
  readonly #gain = Object.assign(new FakeAudioNode(), { gain: { value: 1 } });

  public constructor(addModule: (url: string) => Promise<void>) {
    super();
    this.audioWorklet = { addModule };
  }

  public createMediaStreamSource(): MediaStreamAudioSourceNode {
    return this.#mediaSource as unknown as MediaStreamAudioSourceNode;
  }

  public createGain(): GainNode {
    return this.#gain as unknown as GainNode;
  }

  public async resume(): Promise<void> {
    this.state = "running";
    this.dispatchEvent(new Event("statechange"));
  }

  public async suspend(): Promise<void> {
    this.state = "suspended";
    this.dispatchEvent(new Event("statechange"));
  }

  public async close(): Promise<void> {
    this.state = "closed";
    this.dispatchEvent(new Event("statechange"));
  }

  public interrupt(): void {
    this.state = "suspended";
    this.dispatchEvent(new Event("statechange"));
  }
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

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
