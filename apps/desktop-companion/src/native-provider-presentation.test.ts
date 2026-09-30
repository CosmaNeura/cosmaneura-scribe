import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativeProviderPresentation } from "./native-provider-presentation.js";
import { NativeProcessDecoder, nativeCommand, nativeMetadata } from "./native-process-wire.js";

const root = process.env.SCRIBE_PRESENTATION_FIXTURE_ROOT!;
const session = "30000000-0000-4000-8000-000000000003";
const inactive = { visibility: "persistent", visible: false, phase: "inactive", captureSessionId: null } as const;
const recording = { visibility: "persistent", visible: true, phase: "recording", captureSessionId: session } as const;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function open(suffix = "", isSessionActive = () => true) {
  if (!root) throw new Error("Explicit owned presentation fixture path required");
  const helperPath = join(root, `presentation-fixture${suffix}`);
  const options = { enabled: true, helperPath, helperSha256: createHash("sha256").update(await readFile(helperPath)).digest("hex"), isSessionActive };
  const owner = await NativeProviderPresentation.open(options);
  cleanup.push(async () => { await owner.publish(inactive).catch(() => undefined); await owner.dispose(); });
  return { owner, options };
}

describe.skipIf(!root)("native presentation with the actual Swift protocol and invented surface", () => {
  it("selects privately and acknowledges presentation; active/failed ownership prevents replacement or disposal", async () => {
    const { owner } = await open();
    expect(await owner.selectWindow(new AbortController().signal)).toEqual({ application: "us.zoom.xos", processID: 41, windowID: 73 });
    await expect(owner.showWindowChooser()).rejects.toThrow();
    await owner.publish(recording);
    await expect(owner.showWindowChooser()).rejects.toThrow();
    await expect(owner.selectWindow(new AbortController().signal)).rejects.toThrow();
    await expect(owner.publish({ ...recording, captureSessionId: crypto.randomUUID() })).rejects.toThrow();
    await expect(owner.dispose()).rejects.toThrow();
    await owner.publish({ ...recording, phase: "failed" });
    await expect(owner.publish(recording)).rejects.toThrow();
    await owner.publish(inactive);
    await owner.dispose(); expect(owner.isHealthy()).toBe(false);
  });
  it("reveals one pending chooser without creating another selection or accepting a late canceled choice", async () => {
    const { owner } = await open();
    const abort = new AbortController();
    const selected = owner.selectWindow(abort.signal);
    await sleep(30);
    await owner.showWindowChooser();
    await owner.showWindowChooser();
    expect(await selected).toEqual({ application: "us.zoom.xos", processID: 41, windowID: 73 });
    await expect(owner.showWindowChooser()).rejects.toThrow();
    const cancelled = owner.selectWindow(abort.signal); const rejected = expect(cancelled).rejects.toThrow();
    abort.abort(); await rejected;
    await expect(owner.showWindowChooser()).rejects.toThrow();
  });
  it("cancels a pending picker without accepting its late result or poisoning a subsequent choice", async () => {
    const { owner } = await open();
    const abort = new AbortController(), selection = owner.selectWindow(abort.signal);
    abort.abort(); await expect(selection).rejects.toThrow();
    await sleep(200);
    expect(owner.isHealthy()).toBe(true);
    expect((await owner.selectWindow(new AbortController().signal)).windowID).toBe(73);
  });
  it("delivers the native Stop request without hiding the active indicator", async () => {
    const { owner } = await open("-stop");
    const event = new Promise(resolve => owner.onEvent(resolve));
    await owner.publish(recording);
    expect(await event).toEqual({ kind: "stop_requested", sessionId: session });
    expect(owner.isHealthy()).toBe(true);
    await expect(owner.dispose()).rejects.toThrow();
  });
  it("revokes availability on visibility loss and retains ownership until inactive is published", async () => {
    const { owner } = await open("-loss");
    const event = new Promise(resolve => owner.onEvent(resolve));
    await owner.publish(recording);
    expect(await event).toEqual({ kind: "failed", sessionId: session });
    expect(owner.isHealthy()).toBe(false);
    await expect(owner.dispose()).rejects.toThrow();
    await owner.publish(inactive); await owner.dispose();
  });
  it("detects native-session loss through its heartbeat and keeps the same stop barrier", async () => {
    let active = true;
    const { owner } = await open("", () => active);
    const event = new Promise(resolve => owner.onEvent(resolve));
    await owner.publish(recording); active = false;
    expect(await event).toEqual({ kind: "failed", sessionId: session });
    await expect(owner.dispose()).rejects.toThrow();
  });
  it("refuses omitted enablement or a mismatched executable hash", async () => {
    const { options } = await open();
    await expect(NativeProviderPresentation.open({ ...options, enabled: false })).rejects.toThrow();
    await expect(NativeProviderPresentation.open({ ...options, helperSha256: "0".repeat(64) })).rejects.toThrow();
  });
  it("bounds a frozen native publish and requires explicit inactive cleanup before disposal", async () => {
    const { owner } = await open("-frozen");
    const event = new Promise(resolve => owner.onEvent(resolve));
    await expect(owner.publish(recording)).rejects.toThrow();
    expect(await event).toEqual({ kind: "failed", sessionId: session });
    expect(owner.isHealthy()).toBe(false);
    await expect(owner.dispose()).rejects.toThrow();
    await owner.publish(inactive); await owner.dispose();
  });
});

async function raw() {
  const child = spawn(join(root, "presentation-fixture"), ["--presentation-v1"], { stdio: ["pipe", "pipe", "pipe"], env: {} });
  const decoder = new NativeProcessDecoder(), received: Record<string, unknown>[] = [];
  let stderr = "";
  child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString(); });
  child.stdout.on("data", (bytes: Buffer) => decoder.push(bytes, (_, body) => received.push(nativeMetadata(body))));
  child.stdin.on("error", () => undefined);
  const exit = new Promise<number | null>(resolve => child.once("close", code => resolve(code)));
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exit; });
  async function message(type: string, request?: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = received.find(row => row.type === type && (request === undefined || row.request === request));
      if (found) return found;
      await sleep(10);
    }
    throw new Error("Owned fixture response missing");
  }
  await message("ready");
  return { child, exit, message, stderr: () => stderr, send: (value: Record<string, unknown>) => child.stdin.write(nativeCommand(value)) };
}

describe.skipIf(!root)("Swift presentation protocol boundaries", () => {
  it.each([
    { type: "start", request: 1 },
    { type: "choose", request: true },
    { type: "choose", request: 1, windowID: 73 },
    { type: "publish", request: 1, phase: "recording", session: "invalid" },
  ])("rejects malformed or audio commands: %j", async command => {
    const f = await raw(); f.send(command); expect(await f.exit).toBe(1);
    expect(f.stderr()).toBe("");
  });
  it("refuses native close while active and closes only after an inactive acknowledgement", async () => {
    const f = await raw();
    f.send({ type: "publish", request: 1, phase: "recording", session }); await f.message("published", 1);
    f.send({ type: "close", request: 2 }); await f.message("unavailable", 2);
    expect(f.child.exitCode).toBeNull();
    f.send({ type: "publish", request: 3, phase: "inactive", session: null }); await f.message("published", 3);
    f.send({ type: "close", request: 4 }); await f.message("closed", 4);
    expect(await f.exit).toBe(0); expect(f.stderr()).toBe("recording\ninactive\n");
  });
  it("retains an unconfirmed-stop warning on parent EOF while an active presentation exists", async () => {
    const f = await raw();
    f.send({ type: "publish", request: 1, phase: "recording", session }); await f.message("published", 1);
    f.child.stdin.end();
    for (let attempt = 0; attempt < 100 && !f.stderr().includes("failed"); attempt++) await sleep(10);
    expect(f.stderr()).toBe("recording\nfailed\n"); expect(f.child.exitCode).toBeNull();
    // Explicit fixture cleanup kills only this audio-free invented surface.
  });
  it("rejects replayed command IDs and oversized metadata before showing UI", async () => {
    const f = await raw(); f.send({ type: "heartbeat", request: 2 }); await f.message("heartbeat", 2);
    f.send({ type: "choose", request: 2 }); expect(await f.exit).toBe(1); expect(f.stderr()).toBe("");
    const g = await raw(); g.child.stdin.write(Buffer.from([0, 0, 8, 1])); expect(await g.exit).toBe(1);
  });
});
