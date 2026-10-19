import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CaptureCapabilities } from "../../capture/src/bff/contracts";
import { DesktopPcmCaptureSource } from "./pcm-capture-source.js";
import type { DesktopPCMCoverage, DesktopPCMFailure } from "./native-pcm-driver.js";
import { requestNativeRecordingAccess, NativeProcessPCMDriver } from "./native-process-driver.js";
import { NativeProcessDecoder, nativeCommand, nativeMetadata } from "./native-process-wire.js";
import { nativePipeFixtureFence } from "./native-pipe-fixture.js";
import type { NativeProcessFence } from "./native-process-fence.js";
import type { RuntimeDiagnostic } from "./runtime-diagnostics.js";

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
      expect(events).toEqual(["audio_start_pending", "audio_start_timeout", "audio_main_failure_reason", "audio_failed"]);
      expect(await session.stop({ mode: "discard" })).toBeNull();
      authorized.resolve(); await vi.advanceTimersByTimeAsync(1);
      expect(failures).toEqual(["failed"]);
      expect(events).toEqual(["audio_start_pending", "audio_start_timeout", "audio_main_failure_reason", "audio_failed"]);
    } finally { authorized.resolve(); vi.useRealTimers(); }
  });
});

describe("content-free existing probe timings", () => {
  // This executable accepts read-only/setup modes only; it has no audio source.
  const probeScript = `#!${process.execPath}
if (!["--availability-v1", "--request-permissions-v1", "--microphone-availability-v1", "--microphone-permissions-v1"].includes(process.argv[2])) process.exit(77);
const payload = Buffer.from(JSON.stringify({type: "availability", available: true}));
const header = Buffer.alloc(5); header.writeUInt32BE(payload.length + 1); header[4] = 1;
setTimeout(() => process.stdout.write(Buffer.concat([header, payload]), () => process.exit(0)), 40);
`;
  async function fixture(run: (options: { helperPath: string; helperSha256: string }) => Promise<void>): Promise<void> {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-readonly-probe-"))), helperPath = join(directory, "probe");
    try {
      await writeFile(helperPath, probeScript, { mode: 0o700 });
      await run({ helperPath, helperSha256: createHash("sha256").update(probeScript).digest("hex") });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  it("opens only fixed setup modes without requiring or constructing capture authority", async () => {
    await fixture(async helper => {
      const options = {...helper,enabled:true,isSessionActive:()=>true};
      expect(await requestNativeRecordingAccess(options,new AbortController().signal,true)).toBe(true);
      expect(await requestNativeRecordingAccess(options,new AbortController().signal,false)).toBe(true);
      const abort=new AbortController();abort.abort();
      expect(await requestNativeRecordingAccess(options,abort.signal,false)).toBe(false);
      expect(await requestNativeRecordingAccess({...options,enabled:false},new AbortController().signal,true)).toBe(false);
    });
  });
  it("uses microphone permission probes without application-audio access", async () => {
    await fixture(async helper => {
      const driver = new NativeProcessPCMDriver({ ...helper, enabled: true, audioMode: () => "microphone",
        isSessionActive: () => true, authorizeSelectedWindow: async () => { throw new Error("must not start"); } });
      expect(await driver.getAvailability()).toBe(true);
      await driver.requestPermissions(new AbortController().signal);
    });
  });
  const deniedSelection = async (): Promise<never> => { throw new Error("read-only probe must not authorize capture"); };
  it("measures helper checks and validated probe completion without changing results when diagnostics throws", async () => {
    await fixture(async helper => {
      const events: Array<{ event: string; duration: number | undefined }> = [];
      const driver = new NativeProcessPCMDriver({ ...helper, enabled: true, isSessionActive: () => true,
        authorizeSelectedWindow: deniedSelection, diagnostics: (event, duration) => {
          events.push({ event, duration }); throw new Error("diagnostics unavailable");
        } });
      expect(await driver.getAvailability()).toBe(true);
      expect(await driver.requestPermissions(new AbortController().signal)).toBe(true);
      expect(events.map(item => item.event)).toEqual(["audio_availability_helper_check", "audio_availability_probe",
        "audio_permission_helper_check", "audio_permission_probe"]);
      for (const item of events) {
        expect(Number.isFinite(item.duration)).toBe(true); expect(item.duration).toBeGreaterThanOrEqual(0);
        expect(item.duration).toBeLessThanOrEqual(3_600_000);
      }
      for (const item of events.filter(item => item.event.endsWith("_probe"))) expect(item.duration).toBeGreaterThanOrEqual(35);
    });
  });
  it("does not probe disabled, locked, already cancelled or tampered helpers", async () => {
    await fixture(async helper => {
      const diagnostics = vi.fn<RuntimeDiagnostic>(), base = { ...helper, diagnostics, authorizeSelectedWindow: deniedSelection };
      expect(await new NativeProcessPCMDriver({ ...base, isSessionActive: () => true }).getAvailability()).toBe(false);
      expect(await new NativeProcessPCMDriver({ ...base, enabled: true, isSessionActive: () => false }).getAvailability()).toBe(false);
      const cancelled = new AbortController(); cancelled.abort();
      expect(await new NativeProcessPCMDriver({ ...base, enabled: true, isSessionActive: () => true }).requestPermissions(cancelled.signal)).toBe(false);
      expect(diagnostics).not.toHaveBeenCalled();
      const wrong = new NativeProcessPCMDriver({ ...base, enabled: true, isSessionActive: () => true, helperSha256: "0".repeat(64) });
      expect(await wrong.getAvailability()).toBe(false);
      expect(diagnostics).toHaveBeenCalledTimes(1);
      expect(diagnostics).toHaveBeenCalledWith("audio_availability_helper_check", expect.any(Number));
    });
  });
  it("preserves the fresh session check and permission cancellation after diagnostic completion", async () => {
    await fixture(async helper => {
      let active = true;
      const events: string[] = [], abort = new AbortController();
      const driver = new NativeProcessPCMDriver({ ...helper, enabled: true, isSessionActive: () => active,
        authorizeSelectedWindow: deniedSelection, diagnostics: event => {
          events.push(event);
          if (event === "audio_availability_helper_check") active = false;
          if (event === "audio_permission_helper_check") abort.abort();
        } });
      expect(await driver.getAvailability()).toBe(false); active = true;
      expect(await driver.requestPermissions(abort.signal)).toBe(false);
      expect(events).toEqual(["audio_availability_helper_check", "audio_permission_helper_check"]);
    });
  });
  it("measures a cancelled in-flight permission probe and failed capture helper verification without suppressing failure", async () => {
    await fixture(async helper => {
      const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      const diagnostics = vi.fn<RuntimeDiagnostic>(event => {
        if (event === "audio_permission_helper_check") timer = setTimeout(() => abort.abort(), 20);
      });
      const driver = new NativeProcessPCMDriver({ ...helper, diagnostics, enabled: true, isSessionActive: () => true,
        authorizeSelectedWindow: deniedSelection });
      const permission = driver.requestPermissions(abort.signal);
      try { expect(await permission).toBe(false); }
      finally { clearTimeout(timer); }
      expect(diagnostics.mock.calls.map(call => call[0])).toEqual(["audio_permission_helper_check", "audio_permission_probe"]);
      const events: string[] = [], timings: Array<number | undefined> = [], failures: DesktopPCMFailure[] = [];
      const wrong = new NativeProcessPCMDriver({ ...helper, helperSha256: "0".repeat(64), enabled: true,
        isSessionActive: () => true, authorizeSelectedWindow: async () => ({ application: "us.zoom.xos", processID: 1,
          windowID: 1, captureAuthorizedUntil: Date.now() + 60_000 }), diagnostics: (event, duration) => {
          events.push(event);
          if (event === "audio_capture_helper_check") {
            timings.push(duration); throw new Error("diagnostic sink failed");
          }
        } });
      const session = wrong.start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
        onPcmPacket: async () => { throw new Error("must not capture"); }, onFailure: code => { failures.push(code); },
      });
      await expect(session.ready).rejects.toThrow();
      expect(await session.stop({ mode: "discard" })).toBeNull();
      expect(events).toEqual(["audio_start_pending", "audio_capture_helper_check", "audio_main_failure_reason", "audio_failed"]);
      expect(timings).toHaveLength(1); expect(Number.isFinite(timings[0])).toBe(true);
      expect(failures).toEqual(["failed"]);
    });
  });
});

describe("fixed recording failure diagnostics", () => {
  // Explicit invented consent precedes generated PCM. This fixture has no OS
  // audio API; it exercises the actual private-pipe driver and joined cleanup.
  async function fixture(reportedFailure: Record<string, unknown> | undefined,
    run: (driver: NativeProcessPCMDriver, events: Array<{ event: string; duration: number | undefined; reason: number | undefined }>) => Promise<void>): Promise<void> {
    expect(consent.allPartiesAgreed).toBe(true);
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-recording-diagnostics-")));
    const helperPath = join(directory, "fixture");
    const script = `#!${process.execPath}
if (!["--capture-v2", "--capture-v3"].includes(process.argv[2])) process.exit(77);
const reportedFailure = ${JSON.stringify(reportedFailure ?? null)};
const metadata = value => {
  const body = Buffer.from(JSON.stringify(value)), head = Buffer.alloc(5);
  head.writeUInt32BE(body.length + 1); head[4] = 1; process.stdout.write(Buffer.concat([head, body]));
};
let pending = Buffer.alloc(0);
process.stdin.on("data", part => {
  pending = Buffer.concat([pending, part]);
  while (pending.length >= 4 && pending.length >= pending.readUInt32BE(0) + 4) {
    const length = pending.readUInt32BE(0), value = JSON.parse(pending.subarray(5, length + 4));
    pending = pending.subarray(length + 4);
    if (value.type === "start" || value.type === "startRenewable") {
      metadata(reportedFailure ?? { type: "ready", start: { hostTimeNanoseconds: "1000000000",
        microphonePrerollNanoseconds: "0", systemPrerollNanoseconds: "0" } });
    } else if (value.type === "activate") {
      const head = Buffer.alloc(9); head.writeUInt32BE(9); head[4] = 2; head.writeUInt32BE(0, 5);
      process.stdout.write(Buffer.concat([head, Buffer.from([0, 16, 0, 240])]));
    } else if (value.type === "stop") metadata({ type: "stopped", request: value.request, completion: null });
  }
});
process.stdin.on("end", () => process.exit(0));
`;
    try {
      await writeFile(helperPath, script, { mode: 0o700 });
      const events: Array<{ event: string; duration: number | undefined; reason: number | undefined }> = [];
      await run(new NativeProcessPCMDriver({ enabled: true, helperPath,
        helperSha256: createHash("sha256").update(script).digest("hex"),
        getProcessFence: () => ({ epoch: randomUUID(), coordinatorDevice: "1", coordinatorInode: "2",
          captureDevice: "1", captureInode: "3" }),
        isSessionActive: () => true, authorizeSelectedWindow: async () => ({ application: "microphone",
          processID: 0, windowID: 0, captureAuthorizedUntil: Date.now() + 60_000 }),
        diagnostics: (event, duration, reason) => { events.push({ event, duration, reason }); },
      }), events);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  it("accepts legacy native failures and records exact bounded new reasons without changing cleanup", async () => {
    for (const metadata of [{ type: "failure", code: "failed" }, { type: "failure", code: "failed", reason: 8 },
      { type: "failure", code: "permission_required", reason: 2 }]) {
      await fixture(metadata, async (native, events) => {
        const failures: DesktopPCMFailure[] = [], packets = vi.fn(async () => undefined);
        const session = native.start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
          onPcmPacket: packets, onFailure: code => { failures.push(code); },
        });
        try {
          await expect(session.ready).rejects.toThrow("desktop_native_process_failed");
          expect(await session.stop({ mode: "discard" })).toBeNull();
          expect(failures).toEqual([metadata.code]); expect(packets).not.toHaveBeenCalled();
          expect(events.filter(row => row.event === "audio_main_failure_reason")).toEqual([
            { event: "audio_main_failure_reason", duration: undefined, reason: 15 },
          ]);
          expect(events.filter(row => row.event === "audio_native_failure_reason")).toEqual(metadata.reason === undefined ? [] : [
            { event: "audio_native_failure_reason", duration: undefined, reason: metadata.reason },
          ]);
          expect(events.filter(row => row.event === "audio_stop_confirmed")).toHaveLength(1);
        } finally { await session.stop({ mode: "discard" }); }
      });
    }
  });
  it("treats malformed or mismatched diagnostic reasons as transport failure without logging their contents", async () => {
    for (const metadata of [{ type: "failure", code: "failed", reason: 7 }, { type: "failure", code: "failed", reason: true },
      { type: "failure", code: "failed", reason: 13 }, { type: "failure", code: "failed", reason: 8, detail: "private content" }]) {
      await fixture(metadata, async (native, events) => {
        const failures: DesktopPCMFailure[] = [];
        const session = native.start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
          onPcmPacket: async () => undefined, onFailure: code => { failures.push(code); },
        });
        try {
          await expect(session.ready).rejects.toThrow();
          expect(await session.stop({ mode: "discard" })).toBeNull(); expect(failures).toEqual(["failed"]);
          expect(events.filter(row => row.event === "audio_main_failure_reason")).toEqual([
            { event: "audio_main_failure_reason", duration: undefined, reason: 3 },
          ]);
          expect(events.some(row => row.event === "audio_native_failure_reason")).toBe(false);
          expect(JSON.stringify(events)).not.toContain("private content");
        } finally { await session.stop({ mode: "discard" }); }
      });
    }
  });
  it("retains validated input-change context and confirms the owned helper stop", async () => {
    for (const [trigger, mismatch] of [[1, 4], [2, 2], [3, 128], [4, 0], [5, 0]]) {
      await fixture({ type: "failure", code: "device_changed", reason: 5, input_trigger: trigger, input_mismatch: mismatch }, async (native, events) => {
        const failures: DesktopPCMFailure[] = [];
        const session = native.start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
          onPcmPacket: async () => undefined, onFailure: code => { failures.push(code); },
        });
        try {
          await expect(session.ready).rejects.toThrow();
          expect(await session.stop({ mode: "discard" })).toBeNull();
          expect(failures).toEqual(["device_changed"]);
          expect(events.filter(row => row.event.startsWith("audio_input_change_"))).toEqual([
            { event: "audio_input_change_trigger", duration: undefined, reason: trigger },
            { event: "audio_input_change_mismatch", duration: undefined, reason: mismatch },
          ]);
          expect(events.filter(row => row.event === "audio_stop_confirmed")).toHaveLength(1);
        } finally { await session.stop({ mode: "discard" }); }
      });
    }
  });
  it("rejects incomplete, inconsistent and out-of-range input context without recording it", async () => {
    const valid = { type: "failure", code: "device_changed", reason: 5, input_trigger: 3, input_mismatch: 128 };
    for (const metadata of [
      { ...valid, reason: undefined }, { ...valid, code: "failed", reason: 8 },
      { ...valid, input_trigger: undefined }, { ...valid, input_mismatch: undefined },
      { ...valid, input_trigger: 0 }, { ...valid, input_trigger: 6 }, { ...valid, input_trigger: 1.5 },
      { ...valid, input_mismatch: -1 }, { ...valid, input_mismatch: 256 }, { ...valid, input_mismatch: 1.5 },
      { ...valid, input_mismatch: 0 }, { ...valid, input_trigger: 4 },
      { ...valid, input_mismatch: "private content" }, { ...valid, detail: "private content" },
    ]) {
      await fixture(metadata, async (native, events) => {
        const failures: DesktopPCMFailure[] = [];
        const session = native.start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
          onPcmPacket: async () => undefined, onFailure: code => { failures.push(code); },
        });
        try {
          await expect(session.ready).rejects.toThrow();
          expect(await session.stop({ mode: "discard" })).toBeNull();
          expect(failures).toEqual(["failed"]);
          expect(events.some(row => row.event.startsWith("audio_input_change_"))).toBe(false);
          expect(JSON.stringify(events)).not.toContain("private content");
        } finally { await session.stop({ mode: "discard" }); }
      });
    }
  });
  it("times a slow sink rejection, clears its PCM, and preserves failure and observed stop", async () => {
    await fixture(undefined, async (native, events) => {
      const failures: DesktopPCMFailure[] = [], references: Uint8Array[] = [];
      const session = native.start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
        onPcmPacket: async packet => {
          references.push(packet.pcmBytes); await new Promise(resolve => setTimeout(resolve, 120));
          throw new Error("private callback detail");
        }, onFailure: code => { failures.push(code); },
      });
      try {
        await session.ready; session.activate();
        await vi.waitFor(() => expect(failures).toEqual(["failed"]));
        expect(await session.stop({ mode: "discard" })).toBeNull();
        expect(references).toHaveLength(1); expect(references[0]!.every(value => value === 0)).toBe(true);
        const timings = events.filter(row => row.event === "audio_packet_sink");
        expect(timings).toHaveLength(1); expect(timings[0]!.duration).toBeGreaterThanOrEqual(100);
        expect(events.filter(row => row.event === "audio_main_failure_reason")).toEqual([
          { event: "audio_main_failure_reason", duration: undefined, reason: 13 },
        ]);
        expect(events.filter(row => row.event === "audio_stop_confirmed")).toHaveLength(1);
        expect(JSON.stringify(events)).not.toContain("private callback detail");
      } finally { await session.stop({ mode: "discard" }); }
    });
  });
  it("does not spend the timing budget on fast packet callbacks", async () => {
    await fixture(undefined, async (native, events) => {
      const references: Uint8Array[] = [], failures: DesktopPCMFailure[] = [];
      const session = native.start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
        onPcmPacket: async packet => { references.push(packet.pcmBytes); }, onFailure: code => { failures.push(code); },
      });
      try {
        await session.ready; session.activate();
        await vi.waitFor(() => { expect(references).toHaveLength(1); expect(references[0]!.every(value => value === 0)).toBe(true); });
        expect(await session.stop({ mode: "discard" })).toBeNull(); expect(failures).toEqual([]);
        expect(events.some(row => row.event === "audio_packet_sink")).toBe(false);
      } finally { await session.stop({ mode: "discard" }); }
    });
  });
});

describe.skipIf(!fixturePath)("actual Swift process with explicit invented source", () => {
  async function driver(pid = 1, authorize?: () => Promise<void>, hash?: string,
    fence: () => NativeProcessFence = nativePipeFixtureFence, expiresAt?: number,
    diagnostics?: RuntimeDiagnostic): Promise<NativeProcessPCMDriver> {
    expect(consent.allPartiesAgreed).toBe(true);
    if (!fixturePath) throw new Error("compiled fixture required");
    return new NativeProcessPCMDriver({ enabled: true, helperPath: fixturePath,
      helperSha256: hash ?? createHash("sha256").update(await readFile(fixturePath)).digest("hex"),
      getProcessFence: fence, ...(diagnostics ? { diagnostics } : {}),
      isSessionActive: () => true, authorizeSelectedWindow: async () => {
        await authorize?.();
        return { application: "com.google.Chrome", processID: pid, windowID: 1, captureAuthorizedUntil: expiresAt ?? Date.now() + 60_000 };
      } });
  }
  it("rejects native permission denial after authorization without a disposable probe or activation", async () => {
    const native = await driver(9), availability = vi.spyOn(native, "getAvailability");
    const coverage: DesktopPCMCoverage[] = [], chunks = vi.fn(async () => undefined);
    const source = new DesktopPcmCaptureSource(native, async value => { coverage.push(value); });
    try {
      await expect(source.start({ capabilities: renewableCapabilities(), onChunk: chunks })).rejects.toThrow();
      expect(availability).not.toHaveBeenCalled(); expect(coverage).toEqual([]);
      expect(chunks).not.toHaveBeenCalled();
    } finally { await source.stop(); }
  });
  it("preserves each first native input-change context despite subsequent failure and startup cancellation", async () => {
    for (let pid = 10; pid <= 14; pid++) {
      const events: Array<{ event: string; reason: number | undefined }> = [], failures: DesktopPCMFailure[] = [];
      const native = await driver(pid, undefined, undefined, nativePipeFixtureFence, undefined,
        (event, _duration, reason) => { events.push({ event, reason }); });
      const session = native.start({ sampleRateHz: 16_000, maximumOutputFrames: 16_000 }, {
        onPcmPacket: async () => { throw new Error("must not activate"); }, onFailure: code => { failures.push(code); },
      });
      try {
        await expect(session.ready).rejects.toThrow();
        expect(await session.stop({ mode: "discard" })).toBeNull();
        expect(failures).toEqual(["device_changed"]);
        expect(events.filter(row => row.event === "audio_native_failure_reason")).toEqual([
          { event: "audio_native_failure_reason", reason: 5 },
        ]);
        expect(events.filter(row => row.event.startsWith("audio_input_change_"))).toEqual([
          { event: "audio_input_change_trigger", reason: pid - 9 },
          { event: "audio_input_change_mismatch", reason: [4, 2, 128, 0, 0][pid - 10] },
        ]);
        expect(events.filter(row => row.event === "audio_stop_confirmed")).toHaveLength(1);
        expect(events.some(row => row.event === "audio_ready")).toBe(false);
      } finally { await session.stop({ mode: "discard" }); }
    }
  });
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
