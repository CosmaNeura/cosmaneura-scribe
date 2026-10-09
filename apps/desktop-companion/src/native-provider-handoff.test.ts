import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { NativeProviderPresentation } from "./native-provider-presentation.js";
import { nativeCommand } from "./native-process-wire.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("./native-process-driver.js", () => ({ verifyNativeHelper: vi.fn(async () => undefined) }));
const inactive = { visibility: "persistent", visible: false, phase: "inactive", captureSessionId: null } as const;
const recording = { visibility: "persistent", visible: true, phase: "recording",
  captureSessionId: "30000000-0000-4000-8000-000000000003" } as const;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers(); vi.clearAllMocks();
});
async function fixture(v2 = true, acknowledge = true) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  let windowID: number | null = 73;
  const commands: Record<string, unknown>[] = [];
  const child = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough();
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit("close", 1)); return true; });
  child.stdin = new Writable({
    write(frame: Buffer, _encoding, done) {
      const value = JSON.parse(frame.subarray(5).toString()) as Record<string, unknown>;
      commands.push(value);
      queueMicrotask(() => {
        if (!acknowledge && value.type === "primaryWindow") return;
        const type = value.type === "publish" ? "published" : value.type === "close" ? "closed" : value.type;
        child.stdout.write(nativeCommand({ type, request: value.request }));
      });
      done();
    },
    final(done) { done(); queueMicrotask(() => child.emit("close", 0)); },
  });
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => child.stdout.write(nativeCommand({ type: "ready", version: v2 ? 2 : 1 })));
    return child as unknown as ReturnType<typeof spawn>;
  });
  const owner = await NativeProviderPresentation.open({ enabled: true, helperPath: "/never-executed-handoff-fixture",
    helperSha256: "0".repeat(64), isSessionActive: () => true,
    ...(v2 ? { primaryWindowId: () => windowID } : {}) });
  cleanup.push(async () => { await owner.publish(inactive).catch(() => undefined); await owner.dispose(); });
  return { owner, commands, window: (value: number | null) => { windowID = value; } };
}
it("opts into v2 and acknowledges exact main-owned identity before capture presentation", async () => {
  const f = await fixture(); await f.owner.publish(recording);
  expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(["--presentation-v2"]);
  expect(f.commands.map(value => value.type)).toEqual(["primaryWindow", "publish"]);
  expect(f.commands[0]).toEqual({ type: "primaryWindow", request: 1, windowID: 73 });
  f.window(null); await vi.advanceTimersByTimeAsync(1000);
  expect(f.commands.at(-2)).toMatchObject({ type: "primaryWindow", windowID: null });
  expect(f.commands.at(-1)).toMatchObject({ type: "heartbeat" });
  expect(f.owner.isHealthy()).toBe(true);
});
it("retains byte-compatible v1 behavior when main handoff is absent", async () => {
  const f = await fixture(false); await f.owner.publish(recording);
  await vi.advanceTimersByTimeAsync(1000);
  expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(["--presentation-v1"]);
  expect(f.commands.map(value => value.type)).toEqual(["publish", "heartbeat"]);
});
it("fails closed on a missing handoff acknowledgement and retains active ownership", async () => {
  const f = await fixture(true, false);
  const publishing = f.owner.publish(recording), failure = expect(publishing).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(3000); await failure;
  expect(f.owner.isHealthy()).toBe(false);
  expect(f.commands.some(value => value.type === "publish")).toBe(false);
  await expect(f.owner.dispose()).rejects.toThrow();
});
it("does not transmit a malformed window identifier", async () => {
  const f = await fixture(); f.window(Number.NaN);
  await expect(f.owner.publish(recording)).rejects.toThrow();
  expect(f.commands).toEqual([]);
  expect(f.owner.isHealthy()).toBe(false);
});
