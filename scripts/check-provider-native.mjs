// Exercise the actual provider bundle without native credentials, audio or services.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";

const [bundlePath, jsdomModule] = process.argv.slice(2);
if (!bundlePath || !jsdomModule) throw new Error("Usage: check-provider-native.mjs provider-capture.js installed-jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomModule));
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "capacitor://localhost/index.html", runScripts: "outside-only", pretendToBeVisual: true,
});
const window = dom.window;
Object.defineProperty(window.AbortSignal, "any", { value: undefined, configurable: true });
Object.defineProperty(window, "crypto", { value: webcrypto });
Object.assign(window, { Headers, Response, TextEncoder, TextDecoder });
window.fetch = () => { throw new Error("Unexpected network request"); };
const module = new SourceTextModule(await readFile(bundlePath, "utf8"), { context: dom.getInternalVMContext() });
await module.link(() => { throw new Error("Unexpected external module"); });
await module.evaluate();
assert.throws(() => module.namespace.createProviderIOSCaptureSource(), /provider_ios_capture_unavailable/);
const root = window.document.getElementById("root");
const abort = new window.AbortController();
const sessionId = "10000000-0000-4000-8000-000000000001";
let snapshot = { sessionId, state: "ready", statusCode: "synthetic_preview_ready",
  recordedChunks: 1, queuedChunks: 1, elapsedSeconds: 1, remainingBudgetSeconds: 60,
  remainingAuthoritySeconds: 60, transcriptionStatus: null, transcript: null };
let listener, starts = 0, stops = 0, closed = 0;
const unavailable = () => { throw new Error("Unexpected clinical operation"); };
const dispose = module.namespace.mountProviderCapture(root, {
  sessionId, sourceKind: "microphone", languageMode: "english", signal: abort.signal,
  authorizedRequest: unavailable, journal: { load: unavailable, save: unavailable },
  deactivate: async () => { closed++; },
  controller: {
    get snapshot() { return snapshot; },
    subscribe: callback => { listener = callback; callback(snapshot); return () => { listener = null; }; },
    startRecording: async () => { starts++; },
    stopRecording: async () => { stops++; throw new Error("audio_capture_native_stop_failed"); },
  },
});
const app = root.querySelector("cosmaneura-capture");
try {
  await app.updateComplete;
  assert.equal(starts, 0);
  snapshot = { ...snapshot, state: "paused", statusCode: "audio_session_interrupted" };
  listener(snapshot); await app.updateComplete;
  assert.ok(root.textContent.includes("Confirm stop before uploading"));
  assert.equal(root.textContent.includes("interrupted — stopped"), false);
  snapshot = { ...snapshot, statusCode: "audio_capture_native_stop_failed" };
  listener(snapshot); await app.updateComplete;
  assert.ok(root.textContent.includes("Recording stop is unconfirmed"));
  const stop = root.querySelector('[data-testid="stop-button"]');
  assert.ok(stop.textContent.includes("Retry stop and upload"));
  assert.equal(stop.disabled, false);
  assert.equal(root.querySelector('[data-testid="record-button"]').disabled, true);
  stop.click(); await app.updateComplete; await Promise.resolve(); await app.updateComplete;
  assert.equal(stops, 1);
  assert.ok(root.textContent.includes("Recording stop is unconfirmed"));
  assert.equal(root.textContent.includes("Recording uploaded"), false);
  abort.abort(); await app.updateComplete; await Promise.resolve(); await app.updateComplete;
  assert.equal(root.textContent.includes("Retry stop and upload"), false);
  assert.equal(closed, 1);
  console.log("Built provider entry keeps unconfirmed stop visible/retryable, blocks recording, clears on revocation, and rejects absent native iOS capture.");
} finally { dispose(); dom.window.close(); }
