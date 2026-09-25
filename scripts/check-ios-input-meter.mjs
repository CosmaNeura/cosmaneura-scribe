// Actual bundled component; invented levels only. No device, microphone or network.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";

const [bundlePath, jsdomModule] = process.argv.slice(2);
const { JSDOM } = await import(pathToFileURL(jsdomModule));
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "capacitor://localhost/index.html", runScripts: "outside-only", pretendToBeVisual: true,
});
const window = dom.window;
Object.defineProperty(window, "crypto", { value: webcrypto });
Object.assign(window, { Headers, Response, TextEncoder, TextDecoder });
window.fetch = () => { throw new Error("Unexpected network request"); };
window.CapacitorCustomPlatform = { name: "ios" };
const timers = new Map(); let timerId = 0, reads = 0, pending;
window.setInterval = callback => { timers.set(++timerId, callback); return timerId; };
window.clearInterval = id => timers.delete(id);
const signal = { inputBuffers: 20, convertedBuffers: 20, inputEverNonzero: true,
  convertedEverNonzero: true, inputLevel: 0.125, convertedLevel: 0.125,
  inputAgeMs: 10, convertedAgeMs: 10, zeroInputMs: 0, route: "built_in" };
let response = { version: 1, signal }, hold = false;
window.Capacitor = {
  PluginHeaders: [{ name: "IOSPCM", methods: [{ name: "getCaptureSignal", rtype: "promise" }] }],
  nativePromise: async (plugin, method) => {
    assert.equal(plugin, "IOSPCM"); assert.equal(method, "getCaptureSignal"); reads++;
    return hold ? new Promise(resolve => { pending = resolve; }) : response;
  },
};
const module = new SourceTextModule(await readFile(bundlePath, "utf8"), { context: dom.getInternalVMContext() });
await module.link(() => { throw new Error("Unexpected external module"); }); await module.evaluate();
const root = window.document.getElementById("root"), abort = new window.AbortController();
const sessionId = "10000000-0000-4000-8000-000000000001";
let snapshot = { sessionId, state: "ready", statusCode: "ready", recordedChunks: 0,
  queuedChunks: 0, elapsedSeconds: 0, remainingBudgetSeconds: 60, remainingAuthoritySeconds: 60,
  transcriptionStatus: null, transcript: null }, listener;
const forbidden = () => { throw new Error("Unexpected capture or clinical operation"); };
const dispose = module.namespace.mountProviderCapture(root, {
  sessionId, sourceKind: "microphone", languageMode: "english", signal: abort.signal,
  authorizedRequest: forbidden, journal: { load: forbidden, save: forbidden }, deactivate: async () => {},
  controller: { get snapshot() { return snapshot; },
    subscribe: callback => { listener = callback; callback(snapshot); return () => {}; },
    startRecording: forbidden, stopRecording: forbidden },
});
const app = root.querySelector("cosmaneura-capture");
const flush = async () => { await app.updateComplete; await new Promise(resolve => setImmediate(resolve));
  await root.querySelector("scribe-ios-input-meter")?.updateComplete; };
const change = async state => { snapshot = { ...snapshot, state }; listener(snapshot); await flush(); };
const tick = async () => { for (const callback of timers.values()) callback(); await flush(); };
try {
  await flush(); assert.equal(reads, 0); assert.equal(timers.size, 0);
  await change("recording");
  let meter = root.querySelector("scribe-ios-input-meter");
  assert.ok(meter); assert.equal(timers.size, 1);
  assert.ok(meter.shadowRoot.textContent.includes("iPhone microphone"));
  assert.ok(meter.shadowRoot.querySelectorAll(".on").length > 0);
  response = { version: 1, signal: { ...signal, inputLevel: 0, convertedLevel: 0, zeroInputMs: 3_500 } };
  await tick(); assert.equal(meter.shadowRoot.querySelectorAll(".on").length, 0);
  assert.ok(meter.shadowRoot.textContent.includes("No input detected"));
  response = { version: 1, signal: { ...signal, inputAgeMs: 2_000 } };
  await tick(); assert.equal(meter.shadowRoot.querySelectorAll(".on").length, 0);
  hold = true; await tick(); const late = pending, beforePause = reads;
  await change("paused"); assert.equal(timers.size, 0); assert.equal(reads, beforePause);
  assert.equal(root.querySelector("scribe-ios-input-meter"), null);
  hold = false; response = { version: 1, signal: null };
  await change("recording"); meter = root.querySelector("scribe-ios-input-meter");
  late({ version: 1, signal }); await flush();
  assert.equal(meter.shadowRoot.querySelectorAll(".on").length, 0);
  await change("uploading"); assert.equal(timers.size, 0);
  assert.equal(root.querySelector("scribe-ios-input-meter"), null);
  await change("recording"); abort.abort(); await flush();
  assert.equal(timers.size, 0); assert.equal(root.querySelector("scribe-ios-input-meter"), null);
  console.log("iPhone built meter: signal/zero/stale display, no capture actions, pause/resume late-response isolation, upload and revocation cleanup passed.");
} finally { dispose(); dom.window.close(); }
