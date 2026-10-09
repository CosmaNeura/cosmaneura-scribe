import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { nativePipeFixtureFence } from "./native-pipe-fixture.js";
import { NativeProcessDecoder, nativeCommand, nativeMetadata } from "./native-process-wire.js";

const fixturePath = process.env.SCRIBE_DESKTOP_PIPE_FIXTURE;
const consent = { id: "desktop-renewal-pipe-synthetic-consent", allPartiesAgreed: true };

describe.skipIf(!fixturePath)("renewal through the real private native host", () => {
  function fixture(mode = "--capture-v3", pid = 1) {
    expect(consent.allPartiesAgreed).toBe(true);
    if (!fixturePath) throw new Error("compiled synthetic fixture required");
    const child = spawn(fixturePath, [mode], { stdio: ["pipe", "pipe", "pipe"] });
    const decoder = new NativeProcessDecoder(), messages: Record<string, unknown>[] = [];
    const errors: unknown[] = [], samples: number[] = [], offsets: number[] = [];
    const closed = new Promise<void>(resolve => { child.once("close", () => resolve()); });
    function send(value: Record<string, unknown>) { child.stdin.write(nativeCommand(value)); }
    child.stdin.on("error", error => { errors.push(error); });
    child.stdout.on("data", (bytes: Buffer) => {
      try {
        decoder.push(bytes, (kind, payload) => {
          if (kind === 1) { messages.push(nativeMetadata(payload)); return; }
          const offset = payload.readUInt32BE(); offsets.push(offset);
          if (offset !== samples.length) errors.push(new Error("noncontiguous generated PCM"));
          for (let i = 4; i < payload.length; i += 2) samples.push(payload.readInt16LE(i));
          send({ type: "ack", firstFrame: offset });
        });
      } catch (error) { errors.push(error); }
    });
    const initial = { runId: randomUUID(), generation: 1, expiresAtMilliseconds: Date.now() + 60_000,
      maximumOutputFrames: 6400, hardMaximumOutputFrames: 12_800 };
    function start() {
      send({ type: "startRenewable", application: "com.google.Chrome", processID: pid, windowID: 1,
        authorization: initial, processFence: nativePipeFixtureFence() });
    }
    async function wait(type: string, request?: number) {
      let observed: Record<string, unknown> | undefined;
      await expect.poll(() => {
        observed = messages.find(value => value.type === type && (request === undefined || value.request === request));
        return observed !== undefined;
      }, { timeout: 4000, interval: 5 }).toBe(true);
      return observed!;
    }
    async function dispose() {
      child.stdin.end();
      const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 2000);
      await closed; clearTimeout(timeout); decoder.clear(); samples.fill(0);
    }
    return { child, initial, messages, errors, samples, offsets, send, start, wait, dispose };
  }

  it("keeps both generated voices and frame positions across extension and duplicate acknowledgement", async () => {
    const f = fixture();
    try {
      f.start(); await f.wait("ready"); f.send({ type: "activate" });
      await expect.poll(() => f.samples.length, { interval: 5 }).toBeGreaterThan(0);
      const next = { ...f.initial, generation: 2, expiresAtMilliseconds: f.initial.expiresAtMilliseconds + 30_000,
        maximumOutputFrames: 12_800 };
      f.send({ type: "extend", request: 1, authorization: next });
      expect(await f.wait("extended", 1)).toEqual({ type: "extended", request: 1, generation: 2 });
      f.send({ type: "extend", request: 2, authorization: next });
      await f.wait("extended", 2);
      f.send({ type: "stop", request: 1, mode: "drain" });
      const stopped = await f.wait("stopped", 1);
      expect(stopped.completion).toMatchObject({ outputFrames: 9600 });
      expect(f.samples).toHaveLength(9600);
      expect(new Set(f.samples)).toEqual(new Set([12_288]));
      expect(f.offsets[0]).toBe(0);
      expect(f.messages.filter(value => value.type === "ready")).toHaveLength(1);
      expect(f.messages.some(value => value.type === "failure")).toBe(false);
      expect(f.errors).toEqual([]);
    } finally { await f.dispose(); }
  });

  it("rejects renewable commands in the old capture-v2 mode", async () => {
    const f = fixture("--capture-v2");
    try { f.start(); await f.wait("failure"); expect(f.samples).toEqual([]); }
    finally { await f.dispose(); }
  });

  it("rejects a substituted run before extending the source", async () => {
    const f = fixture();
    try {
      f.start(); await f.wait("ready");
      f.send({ type: "extend", request: 1, authorization: { ...f.initial, runId: randomUUID(), generation: 2,
        expiresAtMilliseconds: f.initial.expiresAtMilliseconds + 30_000 } });
      await f.wait("failure");
      expect(f.messages.some(value => value.type === "extended")).toBe(false);
      expect(f.samples).toEqual([]);
    } finally { await f.dispose(); }
  });

  it("stop fences a renewal while the native source is suspended", async () => {
    const f = fixture("--capture-v3", 5);
    try {
      f.start(); await f.wait("ready");
      f.send({ type: "extend", request: 1, authorization: { ...f.initial, generation: 2,
        expiresAtMilliseconds: f.initial.expiresAtMilliseconds + 30_000, maximumOutputFrames: 12_800 } });
      f.send({ type: "stop", request: 1, mode: "discard" });
      expect((await f.wait("stopped", 1)).completion).toBeNull();
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(f.messages.some(value => value.type === "extended")).toBe(false);
      expect(f.samples).toEqual([]);
    } finally { await f.dispose(); }
  });
});
