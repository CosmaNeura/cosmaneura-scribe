import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

const fixture = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: fixture.spawn }));
vi.mock("./native-process-driver.js", () => ({ verifyNativeHelper: async () => undefined }));
import { NativeProviderClient } from "./native-provider-client.js";

const originalMas = Object.getOwnPropertyDescriptor(process, "mas");
afterEach(() => {
  if (originalMas) Object.defineProperty(process, "mas", originalMas);
  else Reflect.deleteProperty(process, "mas");
});
function child() {
  const value = new EventEmitter();
  const stdout = new PassThrough(), stderr = new PassThrough();
  const stdin = new Writable({ write(bytes: Buffer, _encoding, done) {
    const request = JSON.parse(bytes.toString()) as { id: string };
    queueMicrotask(() => { stdout.write(JSON.stringify({ id: request.id, ok: true,
      result: { phase: "signedOut", revision: "b32b6ff0-2922-4ea4-a7c6-fbaed747c2c8" } }) + "\n"); });
    done();
  }, final(done) { queueMicrotask(() => { value.emit("close", 0, null); }); done(); } });
  return Object.assign(value, { stdin, stdout, stderr, kill: vi.fn() });
}

it("captures only fixed Store bridge diagnostics while preserving auth requests and disposal", async () => {
  Object.defineProperty(process, "mas", { value: true, configurable: true });
  const processChild = child(); fixture.spawn.mockReturnValue(processChild);
  const diagnostics = vi.fn();
  const owner = await NativeProviderClient.open({ helperPath: "/synthetic/ScribeStorePipeBridge",
    helperSha256: "a".repeat(64), diagnostics });
  expect(owner.isReady()).toBe(false);
  processChild.stderr.write("invented private fixture\nSCRIBE_STORE_BRIDGE:10\n");
  expect(diagnostics).toHaveBeenCalledWith("store_bridge_failed", undefined, 10);
  expect(diagnostics).toHaveBeenCalledTimes(1);
  await owner.dispose();
  expect(diagnostics).toHaveBeenLastCalledWith("store_bridge_exit", undefined, 0);
  expect(processChild.kill).not.toHaveBeenCalled();
  expect(fixture.spawn).toHaveBeenCalledWith("/synthetic/ScribeStorePipeBridge", ["--provider-v1"],
    { stdio: ["pipe", "pipe", "pipe"], env: {}, cwd: "/synthetic", windowsHide: true });
});

it("keeps direct auth stderr ignored even if it contains the fixed Store grammar", async () => {
  Object.defineProperty(process, "mas", { value: false, configurable: true });
  const processChild = child(); fixture.spawn.mockReturnValue(processChild);
  const diagnostics = vi.fn();
  const owner = await NativeProviderClient.open({ helperPath: "/synthetic/ScribeDesktopProvider",
    helperSha256: "a".repeat(64), diagnostics });
  processChild.stderr.write("SCRIBE_STORE_BRIDGE:10\n");
  await owner.dispose();
  expect(diagnostics).not.toHaveBeenCalled();
  expect(fixture.spawn).toHaveBeenCalledWith("/synthetic/ScribeDesktopProvider", ["--provider-v1"],
    { stdio: ["pipe", "pipe", "ignore"], env: {}, cwd: "/synthetic", windowsHide: true });
});

it("keeps native failure and exit disposal live when a diagnostic observer throws", async () => {
  Object.defineProperty(process, "mas", { value: true, configurable: true });
  const processChild = child(); fixture.spawn.mockReturnValue(processChild);
  const diagnostics = vi.fn(() => { throw new Error("invented private fixture"); });
  const owner = await NativeProviderClient.open({ helperPath: "/synthetic/ScribeStorePipeBridge",
    helperSha256: "a".repeat(64), diagnostics });
  expect(() => processChild.stderr.write("SCRIBE_STORE_BRIDGE:11\n")).not.toThrow();
  await expect(owner.dispose()).resolves.toBeUndefined();
  expect(diagnostics).toHaveBeenCalledWith("store_bridge_failed", undefined, 11);
  expect(diagnostics).toHaveBeenCalledWith("store_bridge_exit", undefined, 0);
  expect(processChild.kill).not.toHaveBeenCalled();
});
