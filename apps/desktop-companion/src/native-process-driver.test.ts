import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { CaptureCapabilities } from "../../capture/src/bff/contracts";
import { DesktopPcmCaptureSource } from "./pcm-capture-source.js";
import type { DesktopPCMCoverage, DesktopPCMFailure } from "./native-pcm-driver.js";
import { NativeProcessPCMDriver } from "./native-process-driver.js";
import { NativeProcessDecoder, nativeCommand, nativeMetadata } from "./native-process-wire.js";
import { nativePipeFixtureFence } from "./native-pipe-fixture.js";
import type { NativeProcessFence } from "./native-process-fence.js";

const fixturePath = process.env.SCRIBE_DESKTOP_PIPE_FIXTURE;
const consent = Object.freeze({ id: "desktop-pipe-invented-all-parties-consent", allPartiesAgreed: true });

describe("private native pipe framing", () => {
  it("consumes split/coalesced frames with owned-input clearing", () => {
    const decoder = new NativeProcessDecoder();
    const wire = Buffer.concat([nativeCommand({ type: "heartbeat" }), nativeCommand({ type: "activate" })]);
    const messages: string[] = [], references: Buffer[] = [];
    for (let offset = 0; offset < wire.length; offset += 3) {
      const part = Buffer.from(wire.subarray(offset, offset + 3));
      decoder.push(part, (kind, payload) => { expect(kind).toBe(1); messages.push(payload.toString()); references.push(payload); });
      expect(part.every(value => value === 0)).toBe(true);
    }
    decoder.finish();
    expect(messages).toEqual(['{"type":"heartbeat"}', '{"type":"activate"}']);
    expect(references.every(bytes => bytes.every(value => value === 0))).toBe(true);
  });
  it("rejects oversized and truncated frames without buffering their declared payload", () => {
    const huge = Buffer.alloc(4); huge.writeUInt32BE(0xffffffff);
    expect(() => new NativeProcessDecoder().push(huge, () => undefined)).toThrow();
    expect(huge.every(value => value === 0)).toBe(true);
    const decoder = new NativeProcessDecoder();
    decoder.push(Buffer.from([0, 0, 0, 10, 1]), () => undefined);
    expect(() => decoder.finish()).toThrow("truncated");
  });
  it("never runs disabled helpers or accepts renderer construction", async () => {
    const driver = new NativeProcessPCMDriver({ helperPath: "/does-not-exist", helperSha256: "0".repeat(64),
      isSessionActive: () => true, authorizeSelectedWindow: async () => { throw new Error("must not run"); } });
    expect(await driver.getAvailability()).toBe(false);
    expect(() => driver.start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 },
      { onPcmPacket: async () => undefined, onFailure: () => undefined })).toThrow();
    vi.stubGlobal("window", {});
    try { expect(() => new NativeProcessPCMDriver({ helperPath: "", helperSha256: "", isSessionActive: () => true,
      authorizeSelectedWindow: async () => { throw new Error("must not run"); } })).toThrow(); }
    finally { vi.unstubAllGlobals(); }
  });
  it("bounds authority startup and prevents late authorization from spawning a source", async () => {
    vi.useFakeTimers();
    const authorized = deferred<void>(), failures: DesktopPCMFailure[] = [], events: string[] = [];
    try {
      const driver = new NativeProcessPCMDriver({ enabled: true, helperPath: "/must-not-run", helperSha256: "0".repeat(64),
        diagnostics: event => { events.push(event); throw new Error("unavailable diagnostic sink"); },
        isSessionActive: () => true, authorizeSelectedWindow: async () => {
          await authorized.promise;
          return { application: "com.google.Chrome", processID: 1, windowID: 1, captureAuthorizedUntil: Date.now() + 60_000 };
        } });
      const session = driver.start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
        onPcmPacket: async () => { throw new Error("must not deliver"); }, onFailure: code => { failures.push(code); },
      });
      const rejected = expect(session.ready).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(15_000); await rejected;
      expect(failures).toEqual(["failed"]);
      expect(events).toEqual(["audio_start_pending", "audio_start_timeout", "audio_failed"]);
      expect(await session.stop({ mode: "discard" })).toBeNull();
      authorized.resolve(); await vi.advanceTimersByTimeAsync(1);
      expect(failures).toEqual(["failed"]);
      expect(events).toEqual(["audio_start_pending", "audio_start_timeout", "audio_failed"]);
    } finally { authorized.resolve(); vi.useRealTimers(); }
  });
});

describe.skipIf(!fixturePath)("actual Swift process with explicit invented source", () => {
  async function driver(pid = 1, authorize?: () => Promise<void>, hash?: string,
    fence: () => NativeProcessFence = nativePipeFixtureFence, expiresAt?: number): Promise<NativeProcessPCMDriver> {
    expect(consent.allPartiesAgreed).toBe(true);
    if (!fixturePath) throw new Error("compiled fixture required");
    return new NativeProcessPCMDriver({ enabled: true, helperPath: fixturePath,
      helperSha256: hash ?? createHash("sha256").update(await readFile(fixturePath)).digest("hex"),
      getProcessFence: fence,
      isSessionActive: () => true, authorizeSelectedWindow: async () => {
        await authorize?.();
        return { application: "com.google.Chrome", processID: pid, windowID: 1, captureAuthorizedUntil: expiresAt ?? Date.now() + 60_000 };
      } });
  }
  it("carries a renewable window through every adapter and preserves partial WAV boundaries", async () => {
    const expiresAt = Date.now() + 60_000, waves: Uint8Array[] = [], sequences: number[] = [], coverage: DesktopPCMCoverage[] = [];
    const source = new DesktopPcmCaptureSource(await driver(1, undefined, undefined, nativePipeFixtureFence, expiresAt),
      async value => { coverage.push(value); });
    const initial = { runId: randomUUID(), generation: 1, expiresAtMilliseconds: expiresAt, maximumChunks: 2, hardMaximumChunks: 4 };
    const next = { ...initial, generation: 2, expiresAtMilliseconds: expiresAt + 30_000, maximumChunks: 4 };
    try {
      await source.start({ capabilities: renewableCapabilities(), window: initial,
        onChunk: async chunk => { waves.push(chunk.wavBytes.slice()); sequences.push(chunk.sequenceNumber); } });
      await vi.waitFor(() => expect(waves).toHaveLength(1));
      await source.extend(next); await source.extend(next);
      await source.stop();
      expect(sequences).toEqual([0, 1, 2]);
      expect(waves.map(wave => wave.length)).toEqual([6444, 6444, 6444]);
      expect(coverage.map(value => value.phase)).toEqual(["started", "stopped"]);
      expect(coverage[1]).toMatchObject({ value: { outputFrames: 9600, endHostTimeNanoseconds: "1600000000" } });
      for (const wave of waves) {
        const view = new DataView(wave.buffer, wave.byteOffset, wave.length);
        for (let offset = 44; offset < wave.length; offset += 2) expect(view.getInt16(offset, true)).toBe(12288);
        wave.fill(0);
      }
      await expect(source.extend(next)).rejects.toThrow();
    } finally { await source.stop(); }
  });
  it("fences an in-flight extension with Stop without restarting the helper", async () => {
    const expiresAt = Date.now() + 60_000, waves: number[] = [], coverage: DesktopPCMCoverage[] = [];
    const source = new DesktopPcmCaptureSource(await driver(5, undefined, undefined, nativePipeFixtureFence, expiresAt),
      async value => { coverage.push(value); });
    const initial = { runId: randomUUID(), generation: 1, expiresAtMilliseconds: expiresAt, maximumChunks: 2, hardMaximumChunks: 4 };
    try {
      await source.start({ capabilities: renewableCapabilities(), window: initial,
        onChunk: async chunk => { waves.push(chunk.sequenceNumber); } });
      await vi.waitFor(() => expect(waves).toHaveLength(1));
      const extension = expect(source.extend({ ...initial, generation: 2,
        expiresAtMilliseconds: expiresAt + 30_000, maximumChunks: 4 })).rejects.toThrow();
      await source.stop(); await extension;
      expect(waves).toEqual([0, 1]);
      expect(coverage.map(value => value.phase)).toEqual(["started", "stopped"]);
      expect(coverage[1]).toMatchObject({ value: { outputFrames: 4800 } });
    } finally { await source.stop(); }
  });
  it("waits for activation and packet acknowledgement, drains mixer tail, then confirms process exit", async () => {
    const native = await driver(); expect(await native.getAvailability()).toBe(true);
    const received: Uint8Array[] = [], references: Uint8Array[] = [], failures: DesktopPCMFailure[] = [];
    const gate = deferred<void>();
    const session = native.start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
      onPcmPacket: async packet => {
        received.push(packet.pcmBytes.slice()); references.push(packet.pcmBytes);
        if (received.length === 1) await gate.promise;
      }, onFailure: code => { failures.push(code); },
    });
    try {
      expect(await session.ready).toEqual({ hostTimeNanoseconds: "1000000000", microphonePrerollNanoseconds: "0", systemPrerollNanoseconds: "0" });
      await new Promise(resolve => setTimeout(resolve, 30)); expect(received).toHaveLength(0);
      session.activate(); await vi.waitFor(() => expect(received).toHaveLength(1));
      const closing = session.stop({ mode: "drain" }); let closed = false;
      void closing.then(() => { closed = true; });
      await new Promise(resolve => setTimeout(resolve, 30)); expect(received).toHaveLength(1); expect(closed).toBe(false);
      gate.resolve();
      const completed = await closing;
      expect(completed?.outputFrames).toBe(4800); expect(completed?.endHostTimeNanoseconds).toBe("1300000000");
      expect(received).toHaveLength(3); expect(failures).toEqual([]);
      const pcm = Buffer.concat(received);
      for (let offset = 0; offset < pcm.length; offset += 2) expect(pcm.readInt16LE(offset)).toBe(4096);
      expect(references.every(bytes => bytes.every(value => value === 0))).toBe(true);
      expect(await session.stop({ mode: "discard" })).toBeNull();
    } finally { gate.resolve(); await session.stop({ mode: "discard" }); }
  });
  it("rejects an incorrect real coordinator epoch before delivering invented audio", async () => {
    const ticket = nativePipeFixtureFence();
    const native = await driver(1, undefined, undefined, () => ({ ...ticket, epoch: crypto.randomUUID() }));
    const packets = vi.fn(async () => undefined);
    const session = native.start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
      onPcmPacket: packets, onFailure: () => undefined,
    });
    try {
      await expect(session.ready).rejects.toThrow("desktop_native_process_failed");
      expect(packets).not.toHaveBeenCalled();
    } finally { await session.stop({ mode: "discard" }).catch(() => undefined); }
  });
  it("confirms discard after an owned child exits before ready without a stop receipt", async () => {
    const packets = vi.fn(async () => undefined), failures: DesktopPCMFailure[] = [];
    const session = (await driver(7)).start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
      onPcmPacket: packets, onFailure: code => { failures.push(code); },
    });
    try {
      await expect(session.ready).rejects.toThrow("desktop_native_process_failed");
      expect(await session.stop({ mode: "discard" })).toBeNull();
      expect(await session.stop({ mode: "discard" })).toBeNull();
      expect(packets).not.toHaveBeenCalled();
      expect(failures).toEqual(["failed"]);
    } finally { await session.stop({ mode: "discard" }); }
  });
  it("confirms a pending discard when the owned child exits without replying", async () => {
    const packets = vi.fn(async () => undefined);
    const session = (await driver(8)).start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
      onPcmPacket: packets, onFailure: () => undefined,
    });
    try {
      await session.ready; // Source exists, but activation has never been granted.
      expect(await session.stop({ mode: "discard" })).toBeNull();
      expect(packets).not.toHaveBeenCalled();
      expect(() => session.activate()).toThrow();
      expect(await session.stop({ mode: "discard" })).toBeNull();
    } finally { await session.stop({ mode: "discard" }); }
  });
  it("rejects a pending drain when the owned child exits without confirming completion", async () => {
    const packets = vi.fn(async () => undefined), failures: DesktopPCMFailure[] = [];
    const session = (await driver(8)).start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
      onPcmPacket: packets, onFailure: code => { failures.push(code); },
    });
    try {
      await session.ready; session.activate();
      await vi.waitFor(() => expect(packets).toHaveBeenCalled());
      await expect(session.stop({ mode: "drain" })).rejects.toThrow("desktop_native_process_failed");
      expect(failures).toEqual(["failed"]);
      expect(await session.stop({ mode: "discard" })).toBeNull();
    } finally { await session.stop({ mode: "discard" }); }
  });
  it("retains the same child for failed-stop retry and handles drain-to-discard upgrade", async () => {
    for (const failedFirst of [true, false]) {
      const native = await driver(failedFirst ? 2 : 1), gate = deferred<void>();
      let packets = 0;
      const session = native.start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
        onPcmPacket: async () => { packets++; if (!failedFirst) await gate.promise; }, onFailure: () => undefined,
      });
      try {
        await session.ready; session.activate(); await vi.waitFor(() => expect(packets).toBeGreaterThan(0));
        const drain = session.stop({ mode: "drain" });
        if (failedFirst) await expect(drain).rejects.toThrow();
        const discard = session.stop({ mode: "discard" }); gate.resolve();
        if (!failedFirst) expect(await drain).toBeNull();
        expect(await discard).toBeNull();
      } finally { gate.resolve(); await session.stop({ mode: "discard" }); }
    }
  });
  it("cancels before asynchronous authorization or native readiness and rejects a wrong artifact hash", async () => {
    const gate = deferred<void>(), native = await driver(1, () => gate.promise);
    const first = native.start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
      onPcmPacket: async () => { throw new Error("must not deliver"); }, onFailure: () => undefined,
    });
    await first.stop({ mode: "discard" }); gate.resolve(); await expect(first.ready).rejects.toThrow();
    const slow = await driver(4);
    const second = slow.start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
      onPcmPacket: async () => { throw new Error("must not deliver"); }, onFailure: () => undefined,
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await second.stop({ mode: "discard" })).toBeNull(); await expect(second.ready).rejects.toThrow();
    const wrong = await driver(1, undefined, "0".repeat(64)); expect(await wrong.getAvailability()).toBe(false);
    const third = wrong.start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
      onPcmPacket: async () => undefined, onFailure: () => undefined,
    });
    await expect(third.ready).rejects.toThrow(); await third.stop({ mode: "discard" });
  });
  it("carries actual native mixed audio through the existing WAV adapter including its final partial chunk", async () => {
    const coverage: DesktopPCMCoverage[] = [], waves: Uint8Array[] = [];
    const source = new DesktopPcmCaptureSource(await driver(), async value => { coverage.push(value); });
    const capabilities: CaptureCapabilities = {
      protocol_version: "1.0", media: { media_type: "audio/wav", encoding: "pcm_s16le", channels: 1, sample_rate_hz: 16_000 },
      target_chunk_duration_ms: 200, max_envelope_bytes: 10_000, max_chunks: 5, remaining_aggregate_plaintext_bytes: 50_000,
      capture_lease_ttl_seconds: 30, reservation_window_seconds: 30, max_reservations_per_batch: 5, upload_concurrency: 1,
    };
    try {
      await source.start({ capabilities, onChunk: async chunk => { waves.push(chunk.wavBytes.slice()); } });
      await source.stop();
      expect(waves.map(bytes => bytes.length)).toEqual([6444, 3244]);
      expect(coverage.map(value => value.phase)).toEqual(["started", "stopped"]);
      for (const wave of waves) {
        expect(new TextDecoder().decode(wave.subarray(0, 4))).toBe("RIFF");
        const view = new DataView(wave.buffer, wave.byteOffset, wave.length);
        for (let i = 44; i < wave.length; i += 2) expect(view.getInt16(i, true)).toBe(4096);
        wave.fill(0);
      }
    } finally { await source.stop(); }
  });
  it("exits its dedicated process after parent loss even when the source never confirms stop", async () => {
    expect(consent.allPartiesAgreed).toBe(true);
    if (!fixturePath) throw new Error("compiled fixture required");
    const child = spawn(fixturePath, ["--capture-v2"], { stdio: ["pipe", "pipe", "ignore"], env: {} });
    const decoder = new NativeProcessDecoder(), ready = deferred<void>();
    let exited = false;
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => { exited = true; resolve(code); });
    });
    child.stdout.on("data", (bytes: Buffer) => {
      decoder.push(bytes, (kind, payload) => {
        if (kind === 1 && nativeMetadata(payload).type === "ready") ready.resolve();
      });
    });
    try {
      child.stdin.write(nativeCommand({ type: "start", application: "com.google.Chrome", processID: 6,
        windowID: 1, maximumDurationSeconds: 60, maximumOutputFrames: 16_000,
        processFence: nativePipeFixtureFence() }));
      await ready.promise;
      const started = Date.now(); child.stdin.end();
      expect(await closed).toBe(1);
      expect(Date.now() - started).toBeGreaterThanOrEqual(14_000);
      expect(Date.now() - started).toBeLessThan(19_000);
    } finally { if (!exited) { child.kill("SIGKILL"); await closed; } decoder.clear(); }
  }, 22_000);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function renewableCapabilities(): CaptureCapabilities {
  return { protocol_version: "1.0", media: { media_type: "audio/wav", encoding: "pcm_s16le", channels: 1, sample_rate_hz: 16_000 },
    target_chunk_duration_ms: 200, max_envelope_bytes: 10_000, max_chunks: 2, remaining_aggregate_plaintext_bytes: 20_000,
    capture_lease_ttl_seconds: 30, reservation_window_seconds: 30, max_reservations_per_batch: 2, upload_concurrency: 1 };
}
