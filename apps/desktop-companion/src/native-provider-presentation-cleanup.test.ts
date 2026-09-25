import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { NativeProviderPresentation } from "./native-provider-presentation.js";
import { DesktopCaptureController } from "./controller.js";
import { nativeCommand } from "./native-process-wire.js";

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

async function fixture() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const lifetime = new AbortController();
  const commands: Record<string, unknown>[] = [];
  const child = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough();
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit("close", 1)); return true; });
  child.stdin = new Writable({
    write(frame: Buffer, _encoding, done) {
      const command = JSON.parse(frame.subarray(5).toString()) as Record<string, unknown>;
      commands.push(command);
      queueMicrotask(() => {
        const type = command.type === "publish" ? "published" : command.type === "close" ? "closed" : "heartbeat";
        child.stdout.write(nativeCommand({ type, request: command.request }));
      });
      done();
    },
    final(done) { done(); queueMicrotask(() => child.emit("close", 0)); },
  });
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => child.stdout.write(nativeCommand({ type: "ready", version: 1 })));
    return child as unknown as ReturnType<typeof spawn>;
  });
  const presentation = await NativeProviderPresentation.open({ enabled: true,
    helperPath: "/never-executed-presentation-fixture", helperSha256: "0".repeat(64),
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
  return { lifetime, presentation, controller, adapter, commands };
}

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
