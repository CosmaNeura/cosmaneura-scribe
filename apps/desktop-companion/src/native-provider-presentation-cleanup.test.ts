import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { NativeProviderPresentation, NativeScreenAccessRequired } from "./native-provider-presentation.js";
import { DesktopCaptureController } from "./controller.js";
import { nativeCommand } from "./native-process-wire.js";
import type { RuntimeDiagnostic } from "./runtime-diagnostics.js";

// Existing main-process injection seams only. No real child, audio source,
// device, permission request, key store, file payload or network request.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("./native-process-driver.js", () => ({
  verifyNativeHelper: vi.fn(async () => undefined),
  nativeHelperPermissions: vi.fn(async () => true),
}));

const inactive = { visibility: "persistent", visible: false, phase: "inactive", captureSessionId: null } as const;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function fixture(withholdChoice = false, inlineMeetingSelection = false) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const lifetime = new AbortController();
  const diagnostics = vi.fn<RuntimeDiagnostic>();
  const commands: Record<string, unknown>[] = [];
  const child = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough();
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit("close", 1)); return true; });
  child.stdin = new Writable({
    write(frame: Buffer, _encoding, done) {
      const command = JSON.parse(frame.subarray(5).toString()) as Record<string, unknown>;
      commands.push(command);
      queueMicrotask(() => {
        if (withholdChoice && ["choose", "cancel", "windows"].includes(command.type as string)) return;
        if (command.type === "windows") {
          child.stdout.write(nativeCommand({ type: "window", request: command.request,
            application: "us.zoom.xos", processID: 42, windowID: 74, title: "Zoom — Synthetic visit" }));
          child.stdout.write(nativeCommand({ type: "windows", request: command.request, count: 1 }));
          return;
        }
        const type = command.type === "publish" ? "published" : command.type === "close" ? "closed" : "heartbeat";
        child.stdout.write(nativeCommand({ type, request: command.request }));
      });
      done();
    },
    final(done) { done(); queueMicrotask(() => child.emit("close", 0)); },
  });
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => child.stdout.write(nativeCommand({ type: "ready", version: inlineMeetingSelection ? 3 : 1 })));
    return child as unknown as ReturnType<typeof spawn>;
  });
  const presentation = await NativeProviderPresentation.open({ enabled: true,
    helperPath: "/never-executed-presentation-fixture", helperSha256: "0".repeat(64),
    inlineMeetingSelection, diagnostics,
    isSessionActive: () => !lifetime.signal.aborted });
  const adapter = {
    initialize: vi.fn(async () => "ready" as const), refreshPermissions: vi.fn(async () => "ready" as const),
    start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined), shutdown: vi.fn(async () => undefined),
    onSignal: vi.fn(() => () => undefined),
  };
  // The ordinary Stop state is stopped, not shutdown/closed. A fresh controller
  // starts in that same no-capture/no-grant state, without generating any audio.
  const controller = new DesktopCaptureController(adapter, presentation, { enabled: true });
  await presentation.publish(inactive);
  expect(controller.snapshot().state).toBe("stopped");
  cleanup.push(async () => {
    await controller.shutdownFromMain("fixture-cleanup").catch(() => undefined);
    await presentation.publish(inactive).catch(() => undefined);
    await presentation.dispose();
  });
  return { lifetime, presentation, controller, adapter, commands, diagnostics,
    reply: (value: Record<string, unknown>) => child.stdout.write(nativeCommand(value)) };
}

it("lists bounded inline metadata without choosing a window, publishing recording, or starting audio", async () => {
  const f = await fixture(false, true);
  expect(await f.presentation.listMeetingWindows(new AbortController().signal)).toEqual([
    { application: "us.zoom.xos", processID: 42, windowID: 74, title: "Zoom — Synthetic visit" },
  ]);
  expect(f.commands.filter(command => command.type === "choose")).toHaveLength(0);
  expect(f.diagnostics).toHaveBeenCalledExactlyOnceWith("meeting_windows_ready");
  expect(f.adapter.start).not.toHaveBeenCalled();
  await f.presentation.publish({ visibility: "persistent", visible: true, phase: "recording", captureSessionId: "30000000-0000-4000-8000-000000000003" });
  await expect(f.presentation.listMeetingWindows(new AbortController().signal)).rejects.toThrow();
  await f.presentation.publish(inactive);
});

it.each([
  ["screen_access_denied", "meeting_windows_screen_access_denied"],
  ["lookup_failed", "meeting_windows_lookup_failed"],
  ["window_limit_exceeded", "meeting_windows_limit_exceeded"],
] as const)("accepts only bounded window failure metadata (%s) without starting capture", async (diagnostic, event) => {
  const f = await fixture(true, true);
  const listing = f.presentation.listMeetingWindows(new AbortController().signal);
  const rejected = diagnostic === "screen_access_denied" ? expect(listing).rejects.toBeInstanceOf(NativeScreenAccessRequired) : expect(listing).rejects.toThrow();
  const request = f.commands.find(command => command.type === "windows")!.request;
  f.reply({ type: "unavailable", request, diagnostic });
  await rejected;
  expect(f.presentation.isHealthy()).toBe(true);
  expect(f.diagnostics).toHaveBeenCalledExactlyOnceWith(event);
  expect(f.commands.filter(command => command.type === "choose")).toHaveLength(0);
  expect(f.adapter.start).not.toHaveBeenCalled();
});

it("retains compatibility with unavailable metadata replies without a diagnostic", async () => {
  const f = await fixture(true, true);
  const listing = f.presentation.listMeetingWindows(new AbortController().signal);
  const rejected = expect(listing).rejects.toThrow();
  const request = f.commands.find(command => command.type === "windows")!.request;
  f.reply({ type: "unavailable", request });
  await rejected;
  expect(f.presentation.isHealthy()).toBe(true);
  expect(f.diagnostics).toHaveBeenCalledExactlyOnceWith("meeting_windows_unavailable");
  expect(f.adapter.start).not.toHaveBeenCalled();
});

it.each([
  { diagnostic: "invented private detail" },
  { diagnostic: "lookup_failed", title: "Synthetic forbidden field" },
])("fails closed on unexpected window diagnostic data without logging it", async metadata => {
  const f = await fixture(true, true);
  const listing = f.presentation.listMeetingWindows(new AbortController().signal);
  const rejected = expect(listing).rejects.toThrow();
  const request = f.commands.find(command => command.type === "windows")!.request;
  f.reply({ type: "unavailable", request, ...metadata });
  await rejected;
  expect(f.presentation.isHealthy()).toBe(false);
  expect(f.diagnostics).toHaveBeenCalledExactlyOnceWith("meeting_windows_protocol_failed");
  expect(f.adapter.start).not.toHaveBeenCalled();
});

it("reports an empty successful list separately from discovery failure", async () => {
  const f = await fixture(true, true);
  const listing = f.presentation.listMeetingWindows(new AbortController().signal);
  const request = f.commands.find(command => command.type === "windows")!.request;
  f.reply({ type: "windows", request, count: 0 });
  expect(await listing).toEqual([]);
  expect(f.presentation.isHealthy()).toBe(true);
  expect(f.diagnostics).toHaveBeenCalledExactlyOnceWith("meeting_windows_empty");
  expect(f.adapter.start).not.toHaveBeenCalled();
});

it("keeps diagnostic callbacks outside metadata authority", async () => {
  const f = await fixture(false, true);
  f.diagnostics.mockImplementation(() => { throw new Error("invented observer failure"); });
  expect(await f.presentation.listMeetingWindows(new AbortController().signal)).toHaveLength(1);
  expect(f.presentation.isHealthy()).toBe(true);
  expect(f.adapter.start).not.toHaveBeenCalled();
});

it("does not accept window diagnostics on a picker-selection reply", async () => {
  const f = await fixture(true, true);
  const selection = f.presentation.selectWindow(new AbortController().signal);
  const rejected = expect(selection).rejects.toThrow();
  const request = f.commands.find(command => command.type === "choose")!.request;
  f.reply({ type: "unavailable", request, diagnostic: "lookup_failed" });
  await rejected;
  expect(f.presentation.isHealthy()).toBe(false);
  expect(f.diagnostics).not.toHaveBeenCalled();
  expect(f.adapter.start).not.toHaveBeenCalled();
});

it("rejects a late inline list after cancellation and waits for its acknowledgement before cleanup", async () => {
  const f = await fixture(true, true), abort = new AbortController();
  const listing = f.presentation.listMeetingWindows(abort.signal), rejected = expect(listing).rejects.toThrow();
  abort.abort();
  const request = f.commands.find(command => command.type === "windows")!.request;
  f.reply({ type: "window", request, application: "us.zoom.xos", processID: 42, windowID: 74, title: "Zoom — Synthetic visit" });
  f.reply({ type: "windows", request, count: 1 });
  await rejected;
  expect(f.presentation.isHealthy()).toBe(true);
  await f.presentation.publish(inactive);
  expect(f.adapter.start).not.toHaveBeenCalled();
});

it.each(["unavailable", "selected"])("waits for a cancelled picker acknowledgement (%s) before hiding inactive presentation", async type => {
  const f = await fixture(true), abort = new AbortController();
  const selection = f.presentation.selectWindow(abort.signal);
  const rejected = expect(selection).rejects.toThrow();
  abort.abort(); await rejected;
  let stopped = false;
  const stopping = f.controller.shutdownFromMain("cancelled-choice").then(() => { stopped = true; });
  void stopping.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(100);
  expect(stopped).toBe(false);
  expect(f.presentation.isHealthy()).toBe(true);
  expect(f.commands.filter(command => command.type === "publish")).toHaveLength(1);
  const request = f.commands.find(command => command.type === "choose")!.request;
  f.reply({ type, request, ...(type === "selected" ? { application: "us.zoom.xos", processID: 41, windowID: 73 } : {}) });
  await stopping;
  expect(stopped).toBe(true); expect(f.presentation.isHealthy()).toBe(true);
  expect(f.adapter.start).not.toHaveBeenCalled();
  expect(f.commands.filter(command => command.type === "publish")).toHaveLength(2);
});

it("bounds a missing cancelled-picker acknowledgement and keeps capture disabled", async () => {
  const f = await fixture(true), abort = new AbortController();
  const selection = f.presentation.selectWindow(abort.signal);
  const rejected = expect(selection).rejects.toThrow();
  abort.abort(); await rejected;
  const stopping = f.presentation.publish(inactive), failed = expect(stopping).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(3_000); await failed;
  expect(f.presentation.isHealthy()).toBe(false);
  expect(f.adapter.start).not.toHaveBeenCalled();
});

it("closes an already stopped owner on the first attempt while its session is active", async () => {
  const f = await fixture();
  await expect(f.controller.shutdownFromMain("first-close")).resolves.toBeUndefined();
  expect(f.adapter.shutdown).toHaveBeenCalledOnce();
  expect(f.adapter.start).not.toHaveBeenCalled();
});

it("closes an already stopped owner on the first attempt immediately after session revocation", async () => {
  const f = await fixture();
  f.lifetime.abort();
  await expect(f.controller.shutdownFromMain("first-close")).resolves.toBeUndefined();
  expect(f.controller.snapshot().state).toBe("stopped");
  expect(f.adapter.shutdown).toHaveBeenCalledOnce();
  expect(f.adapter.start).not.toHaveBeenCalled();
  expect(spawn).toHaveBeenCalledOnce();
  expect(f.commands.filter(command => command.type === "publish")).toHaveLength(1);
});

it("keeps same-owner cleanup idempotent after session revocation", async () => {
  const f = await fixture();
  f.lifetime.abort();
  await f.controller.shutdownFromMain("first-close");
  await f.controller.shutdownFromMain("same-owner-repeat");
  expect(f.adapter.shutdown).toHaveBeenCalledOnce();
  expect(f.adapter.start).not.toHaveBeenCalled();
  expect(spawn).toHaveBeenCalledOnce();
});

it("still denies recording publication and picker selection after revocation and retains active ownership until inactive", async () => {
  const f = await fixture();
  const recording = { visibility: "persistent", visible: true, phase: "recording",
    captureSessionId: "30000000-0000-4000-8000-000000000003" } as const;
  await f.presentation.publish(recording);
  f.lifetime.abort();
  await expect(f.presentation.selectWindow(new AbortController().signal)).rejects.toThrow();
  await expect(f.presentation.publish(recording)).rejects.toThrow();
  await expect(f.presentation.dispose()).rejects.toThrow();
  expect(f.adapter.shutdown).not.toHaveBeenCalled();
  await f.controller.shutdownFromMain("confirmed-stop-cleanup");
  await expect(f.presentation.dispose()).resolves.toBeUndefined();
  expect(f.adapter.start).not.toHaveBeenCalled();
  expect(spawn).toHaveBeenCalledOnce();
});

it("retains active ownership when physical shutdown fails and clears it only after a confirmed stop", async () => {
  const f = await fixture();
  await f.presentation.publish({ visibility: "persistent", visible: true, phase: "recording",
    captureSessionId: "30000000-0000-4000-8000-000000000003" });
  f.lifetime.abort();
  f.adapter.shutdown.mockRejectedValueOnce(new Error("invented unconfirmed physical stop"));
  await expect(f.controller.shutdownFromMain("unconfirmed-close")).rejects.toMatchObject({ code: "adapter_failure" });
  await expect(f.presentation.dispose()).rejects.toThrow();
  expect(f.commands.filter(command => command.type === "publish" && command.phase === "inactive")).toHaveLength(1);
  await expect(f.controller.shutdownFromMain("confirmed-stop-retry")).resolves.toBeUndefined();
  await expect(f.presentation.dispose()).resolves.toBeUndefined();
  expect(f.adapter.shutdown).toHaveBeenCalledTimes(2);
  expect(f.adapter.start).not.toHaveBeenCalled();
});

it("also closes on the first attempt after the heartbeat has observed revocation", async () => {
  const f = await fixture();
  f.lifetime.abort();
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(f.controller.shutdownFromMain("close-after-heartbeat")).resolves.toBeUndefined();
  expect(f.adapter.start).not.toHaveBeenCalled();
});
