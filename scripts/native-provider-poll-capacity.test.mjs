import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

// Execute the actual client class against a fake pipe. No native executable,
// Electron, browser, network, credential or account storage is used.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clientUrl = pathToFileURL(resolve(root, "apps/desktop-companion/src/native-provider-client.ts"));
const variant = process.env.SCRIBE_POLL_TEST_VARIANT ?? "candidate";
assert.ok(["candidate", "baseline"].includes(variant));
const baseline = variant === "baseline";
const baselinePath = resolve(root, "../scribe-native-poll-queue-resilience-evidence-20261102-01/BASELINE-NATIVE-PROVIDER-CLIENT.ts");
const moduleUrl = clientUrl.href + (baseline ? "?baseline" : "?candidate");
let loadedSourceSha256;
const mockModule = text => "data:text/javascript," + encodeURIComponent(text);
const mocks = new Map([
  ["node:child_process", mockModule("export function spawn(...args) { return globalThis.__scribePollTest.spawn(...args); }")],
  ["native-process-driver.js", mockModule("export async function verifyNativeHelper() {}")],
  ["store-bootstrap-diagnostics.js", mockModule("export class StoreBridgeDiagnosticDecoder { push() {} }")],
  ["runtime-diagnostics.js", mockModule("export const NO_DIAGNOSTICS = () => {};")],
]);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "node:child_process") return { url: mocks.get(specifier), shortCircuit: true };
    if (context.parentURL?.startsWith(pathToFileURL(root).href) && specifier.startsWith(".")) {
      const name = specifier.split("/").at(-1);
      if (mocks.has(name)) return { url: mocks.get(name), shortCircuit: true };
      const candidate = new URL(specifier, context.parentURL);
      const file = fileURLToPath(candidate);
      const typescript = file.endsWith(".js") ? file.slice(0, -3) + ".ts" : extname(file) ? file : file + ".ts";
      if (existsSync(typescript)) return { url: pathToFileURL(typescript).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.split("?")[0] === clientUrl.href) {
      const source = readFileSync(baseline ? baselinePath : fileURLToPath(clientUrl), "utf8");
      loadedSourceSha256 = createHash("sha256").update(source).digest("hex");
      return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
    }
    return next(url, context);
  },
});
const { NativeProviderClient } = await import(moduleUrl);
assert.equal(loadedSourceSha256, createHash("sha256").update(readFileSync(baseline ? baselinePath : fileURLToPath(clientUrl))).digest("hex"),
  "The executed client source must be the selected frozen baseline or candidate");
process.stdout.write(JSON.stringify({ testVariant: variant, executedSourceSha256: loadedSourceSha256 }) + "\n");
const ready = { phase: "ready", revision: "11111111-1111-4111-8111-111111111111" };
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

async function fixture(run) {
  const polls = new Map(), held = new Map();
  const priorInterval = globalThis.setInterval, priorClear = globalThis.clearInterval;
  globalThis.setInterval = callback => { const id = {}; polls.set(id, callback); return id; };
  globalThis.clearInterval = id => { polls.delete(id); };
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: new EventEmitter(), stderr: null });
  let initial = true, spawnCalls = 0;
  const reply = (id, result, ok = true) => {
    held.delete(id);
    child.stdout.emit("data", Buffer.from(JSON.stringify({ id, ok, result }) + "\n"));
  };
  child.stdin.write = (bytes, callback) => {
    const request = JSON.parse(bytes.toString()); held.set(request.id, request); callback?.();
    if (initial && request.method === "getState") { initial = false; queueMicrotask(() => reply(request.id, ready)); }
    return true;
  };
  child.stdin.end = () => { queueMicrotask(() => child.emit("close", 0, null)); };
  child.kill = () => { throw new Error("No process can be killed by this source check"); };
  globalThis.__scribePollTest = { spawn: (path, args) => {
    spawnCalls += 1;
    assert.equal(path, "/invented/owned/ScribeDesktopProvider");
    assert.deepEqual(args, ["--provider-v1"]);
    return child;
  } };
  let owner;
  try {
    owner = await NativeProviderClient.open({ helperPath: "/invented/owned/ScribeDesktopProvider", helperSha256: "a".repeat(64) });
    assert.equal(spawnCalls, 1); assert.equal(polls.size, 1);
    await run({ owner, child, held, reply, poll: () => { for (const callback of polls.values()) callback(); } });
  } finally {
    await owner?.dispose();
    globalThis.setInterval = priorInterval; globalThis.clearInterval = priorClear;
    delete globalThis.__scribePollTest;
  }
}

test("local capacity does not withdraw a ready native owner and polling resumes when a slot clears", async () => {
  await fixture(async ({ owner, held, reply, poll }) => {
    const pending = Array.from({ length: 8 }, () => owner.request("providerRequest", {}).catch(error => error));
    assert.equal(held.size, 8);
    poll(); await flush();
    assert.equal(owner.signal.aborted, false, "A local full queue is not native/session failure");
    assert.equal(owner.isReady(), true); assert.equal(held.size, 8);
    reply(held.keys().next().value, { fixture: true }); await flush();
    poll(); await flush();
    const observation = [...held.values()].find(request => request.method === "getState");
    assert.ok(observation, "The next periodic check must use newly available capacity");
    reply(observation.id, ready); await flush();
    assert.equal(owner.isReady(), true); assert.equal(owner.signal.aborted, false);
    for (const request of [...held.values()]) reply(request.id, { fixture: true });
    await Promise.all(pending);
  });
});

test("an actual rejected state reply still withdraws the native transport", async () => {
  await fixture(async ({ owner, held, reply, poll }) => {
    poll(); await flush();
    const observation = [...held.values()].find(request => request.method === "getState"); assert.ok(observation);
    reply(observation.id, null, false); await flush();
    assert.equal(owner.signal.aborted, true); assert.equal(owner.isReady(), false);
  });
});

test("auth withdrawal and child failure remain observable during local queue pressure", async () => {
  await fixture(async ({ owner, child, poll }) => {
    const pending = Array.from({ length: 8 }, () => owner.request("providerRequest", {}).catch(error => error));
    const states = [];
    await owner.addListener("authStateChanged", state => states.push(state));
    poll(); await flush();
    child.stdout.emit("data", Buffer.from(JSON.stringify({ event: "authStateChanged", state: {
      phase: "unavailable", revision: "22222222-2222-4222-8222-222222222222",
    } }) + "\n"));
    assert.equal(states.at(-1).phase, "unavailable"); assert.equal(owner.isReady(), false);
    child.emit("error", new Error("Invented pipe failure"));
    assert.equal(owner.signal.aborted, true); await Promise.all(pending);
  });
});
