import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NativeMicrophoneInputService } from "./native-microphone-inputs.js";
import { NativeProcessPCMDriver, requestNativeRecordingAccess } from "./native-process-driver.js";
import { nativeCommand } from "./native-process-wire.js";
import type { RuntimeDiagnostic } from "./runtime-diagnostics.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

class ProbeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn<(signal: string) => boolean>(signal => { queueMicrotask(() => this.close(null, signal)); return true; });
  close(code: number | null, signal: string | null = null): void {
    // Node destroys parent-side stdin when the child exits. No actual process,
    // socket, XPC peer or microphone is used by this admission model.
    this.stdin.destroy();
    this.emit("close", code, signal);
  }
  reply(value: Record<string, unknown>, code = 0): void {
    this.stdout.write(nativeCommand(value));
    this.close(code);
  }
}

const originalMas = Object.getOwnPropertyDescriptor(process, "mas");
const helperBytes = Buffer.from("owned non-executed finite-probe fixture");
const helperSha256 = createHash("sha256").update(helperBytes).digest("hex");
let directory: string;
const children: ProbeChild[] = [];
beforeAll(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-finite-probe-")));
  for (const name of ["ScribeStorePipeBridge", "direct-helper"]) {
    await writeFile(join(directory, name), helperBytes, { mode: 0o700 });
  }
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
afterEach(() => {
  for (const child of children.splice(0)) {
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.removeAllListeners();
  }
  vi.mocked(spawn).mockReset();
  if (originalMas) Object.defineProperty(process, "mas", originalMas);
  else Reflect.deleteProperty(process, "mas");
  vi.useRealTimers();
});
function runtime(mas: boolean): void { Object.defineProperty(process, "mas", { value: mas, configurable: true }); }
function options(name = "ScribeStorePipeBridge") {
  return { enabled: true, helperPath: join(directory, name), helperSha256, isSessionActive: () => true };
}
function nextChild(onSpawn: (child: ProbeChild, mode: string) => void): void {
  vi.mocked(spawn).mockImplementation((_path, args) => {
    const child = new ProbeChild(); children.push(child);
    queueMicrotask(() => onSpawn(child, args?.[0] ?? ""));
    return child as unknown as ReturnType<typeof spawn>;
  });
}
function availability(microphoneOnly: boolean, name?: string, diagnostics?: RuntimeDiagnostic): Promise<boolean> {
  return new NativeProcessPCMDriver({ ...options(name), audioMode: () => microphoneOnly ? "microphone" : "meeting",
    ...(diagnostics ? { diagnostics } : {}),
    authorizeSelectedWindow: async () => { throw new Error("finite probe cannot authorize capture"); } }).getAvailability();
}

describe("finite Store bridge channel admission", () => {
  it.each([
    [false, false, "--availability-v1"], [false, true, "--microphone-availability-v1"],
    [true, false, "--request-permissions-v1"], [true, true, "--microphone-permissions-v1"],
  ] as const)("keeps connected stdin for permission=%s microphone=%s", async (permission, microphone, mode) => {
    runtime(true);
    nextChild((child, actualMode) => {
      expect(actualMode).toBe(mode);
      // Immediate EOF would fail the Store channel admission before any reply.
      expect(child.stdin.writableEnded).toBe(false);
      if (child.stdin.writableEnded) child.close(78);
      else child.reply({ type: "availability", available: true });
    });
    expect(await (permission ? requestNativeRecordingAccess(options(), new AbortController().signal, microphone)
      : availability(microphone))).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(options().helperPath, [mode], {
      stdio: ["pipe", "pipe", "pipe"], env: {}, cwd: directory, windowsHide: true,
    });
  });

  it.each([[false, "ScribeStorePipeBridge"], [true, "direct-helper"]] as const)(
    "preserves immediate EOF outside exact Store bridge runtime=%s helper=%s", async (mas, name) => {
      runtime(mas);
      nextChild(child => { expect(child.stdin.writableEnded).toBe(true); child.reply({ type: "availability", available: true }); });
      expect(await availability(true, name)).toBe(true);
    });

  it("forwards the actual input-service permission sink through a failed Store bridge", async () => {
    runtime(true);
    const diagnostics = vi.fn<RuntimeDiagnostic>();
    const inputs = new NativeMicrophoneInputService({ ...options(), diagnostics });
    nextChild((child, mode) => {
      expect(mode).toBe("--microphone-permissions-v1");
      child.stderr.write("SCRIBE_STORE_");
      child.stderr.write("BRIDGE:5\n");
      child.reply({ type: "availability", available: true }, 78);
    });
    expect(await inputs.requestRecordingAccess(new AbortController().signal, true)).toBe(false);
    expect(diagnostics.mock.calls.map(([event]) => event)).toEqual([
      "audio_permission_helper_check", "store_bridge_failed", "store_bridge_exit", "audio_permission_probe",
    ]);
    expect(diagnostics.mock.calls[0]).toEqual(["audio_permission_helper_check", expect.any(Number)]);
    expect(diagnostics.mock.calls[1]).toEqual(["store_bridge_failed", undefined, 5]);
    expect(diagnostics.mock.calls[2]).toEqual(["store_bridge_exit", undefined, 78]);
    expect(diagnostics.mock.calls[3]).toEqual(["audio_permission_probe", expect.any(Number)]);
  });

  it.each(["invalid", "oversize"] as const)("discards %s stderr while retaining failed-probe exit metadata", async kind => {
    runtime(true);
    const diagnostics = vi.fn<RuntimeDiagnostic>();
    nextChild(child => {
      if (kind === "invalid") child.stderr.write("synthetic text\nSCRIBE_STORE_BRIDGE:5 extra\nSCRIBE_STORE_BRIDGE:15\n");
      else {
        child.stderr.write("x".repeat(1025));
        child.stderr.write("SCRIBE_STORE_BRIDGE:5\n");
      }
      child.reply({ type: "availability", available: true }, 78);
    });
    expect(await availability(true, undefined, diagnostics)).toBe(false);
    expect(diagnostics.mock.calls.filter(([event]) => event.startsWith("store_bridge_")))
      .toEqual([["store_bridge_exit", undefined, 78]]);
  });

  it("keeps a successful permission result when timing and stderr observers throw", async () => {
    runtime(true);
    const diagnostics = vi.fn<RuntimeDiagnostic>(() => { throw new Error("synthetic observer failure"); });
    const inputs = new NativeMicrophoneInputService({ ...options(), diagnostics });
    nextChild(child => {
      child.stderr.write("SCRIBE_STORE_BRIDGE:8\n");
      child.reply({ type: "availability", available: true });
    });
    expect(await inputs.requestRecordingAccess(new AbortController().signal, true)).toBe(true);
    expect(diagnostics.mock.calls.map(([event]) => event)).toEqual([
      "audio_permission_helper_check", "store_bridge_failed", "audio_permission_probe",
    ]);
  });

  it.each([[false, "ScribeStorePipeBridge"], [true, "direct-helper"]] as const)(
    "never consumes Direct stderr or emits Store terminal events runtime=%s helper=%s", async (mas, name) => {
      runtime(mas);
      const diagnostics = vi.fn<RuntimeDiagnostic>();
      nextChild(child => {
        child.stderr.write("SCRIBE_STORE_BRIDGE:5\n");
        child.reply({ type: "availability", available: true }, 78);
      });
      expect(await availability(true, name, diagnostics)).toBe(false);
      expect(diagnostics.mock.calls.filter(([event]) => event.startsWith("store_bridge_"))).toEqual([]);
      expect(spawn).toHaveBeenCalledWith(options(name).helperPath, ["--microphone-availability-v1"], {
        stdio: ["pipe", "pipe", "ignore"], env: {}, cwd: directory, windowsHide: true,
      });
    });

  it.each([[false, 0], [true, 78]] as const)("retains availability=%s and exit=%s result gates", async (available, code) => {
    runtime(true);
    const diagnostics = vi.fn<RuntimeDiagnostic>();
    nextChild(child => child.reply({ type: "availability", available }, code));
    expect(await requestNativeRecordingAccess({ ...options(), diagnostics }, new AbortController().signal, true)).toBe(false);
    expect(diagnostics.mock.calls.filter(([event]) => event.startsWith("store_bridge_")))
      .toEqual([["store_bridge_exit", undefined, code]]);
  });

  it.each(["extra-field", "truncated", "missing"] as const)("rejects %s metadata with connected input", async kind => {
    runtime(true);
    nextChild(child => {
      if (kind === "extra-field") child.reply({ type: "availability", available: true, unwanted: true });
      else if (kind === "truncated") { child.stdout.write(Buffer.from([0, 0, 0, 10, 1])); child.close(0); }
      else child.close(0);
    });
    expect(await availability(true)).toBe(false);
  });

  it("kills an aborted connected permission probe and joins its false result", async () => {
    runtime(true);
    const diagnostics = vi.fn<RuntimeDiagnostic>();
    const abort = new AbortController();
    let selected!: ProbeChild;
    let spawned!: () => void;
    const ready = new Promise<void>(resolve => { spawned = resolve; });
    nextChild(child => { selected = child; spawned(); });
    const pending = requestNativeRecordingAccess({ ...options(), diagnostics }, abort.signal, true);
    await ready;
    expect(selected.stdin.writableEnded).toBe(false);
    abort.abort();
    expect(await pending).toBe(false);
    expect(selected.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(selected.stdin.destroyed).toBe(true);
    expect(diagnostics.mock.calls.filter(([event]) => event.startsWith("store_bridge_")))
      .toEqual([["store_bridge_signal", undefined, 2]]);
  });

  it.each([[false, 15_000], [true, 120_000]] as const)("retains permission=%s deadline=%s", async (permission, milliseconds) => {
    runtime(true); vi.useFakeTimers();
    let selected!: ProbeChild;
    let spawned!: () => void;
    const ready = new Promise<void>(resolve => { spawned = resolve; });
    nextChild(child => { selected = child; spawned(); });
    const pending = permission ? requestNativeRecordingAccess(options(), new AbortController().signal, true) : availability(true);
    await ready;
    await vi.advanceTimersByTimeAsync(milliseconds - 1);
    expect(selected.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(false);
    expect(selected.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it("retains helper verification, fresh session and pre-cancel gates before spawning", async () => {
    runtime(true);
    const abort = new AbortController(); abort.abort();
    for (const selected of [{ ...options(), enabled: false }, { ...options(), isSessionActive: () => false },
      { ...options(), helperSha256: "0".repeat(64) }]) {
      expect(await requestNativeRecordingAccess(selected, new AbortController().signal, true)).toBe(false);
    }
    expect(await requestNativeRecordingAccess(options(), abort.signal, true)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});
