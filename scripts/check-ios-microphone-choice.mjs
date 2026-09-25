// Actual bundled UI with invented responses; no device, microphone or network.
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
let select = async input => ({ version: 1, input });
const calls = [];
window.Capacitor = {
  PluginHeaders: [{ name: "IOSPCM", methods: ["selectMicrophoneInput", "getCaptureSignal"].map(name => ({ name, rtype: "promise" })) }],
  nativePromise: async (plugin, method, options) => {
    assert.equal(plugin, "IOSPCM");
    if (method === "getCaptureSignal") return { version: 2, signal: null };
    assert.equal(method, "selectMicrophoneInput"); calls.push(options.input);
    return select(options.input);
  },
};
const module = new SourceTextModule(await readFile(bundlePath, "utf8"), { context: dom.getInternalVMContext() });
await module.link(() => { throw new Error("Unexpected external module"); }); await module.evaluate();
const root = window.document.getElementById("root"), abort = new window.AbortController();
const sessionId = "10000000-0000-4000-8000-000000000001";
let snapshot = { sessionId, state: "ready", statusCode: "ready", recordedChunks: 0,
  queuedChunks: 0, elapsedSeconds: 0, remainingBudgetSeconds: 60, remainingAuthoritySeconds: 60,
  transcriptionStatus: null, transcript: null }, listener, starts = 0, resumes = 0;
const forbidden = () => { throw new Error("Unexpected capture or clinical operation"); };
const dispose = module.namespace.mountProviderCapture(root, {
  sessionId, sourceKind: "microphone", languageMode: "english", signal: abort.signal,
  authorizedRequest: forbidden, journal: { load: forbidden, save: forbidden }, deactivate: async () => {},
  controller: { get snapshot() { return snapshot; },
    subscribe: callback => { listener = callback; callback(snapshot); return () => {}; },
    startRecording: async () => { starts++; }, resumeRecording: async () => { resumes++; }, stopRecording: forbidden },
});
const app = root.querySelector("cosmaneura-capture");
const flush = async () => { await app.updateComplete; await new Promise(resolve => setImmediate(resolve)); await app.updateComplete; };
const button = id => root.querySelector(`[data-testid="${id}"]`);
const change = async state => { snapshot = { ...snapshot, state }; listener(snapshot); await flush(); };
const choose = async value => {
  button("microphone-input").value = value;
  button("microphone-input").dispatchEvent(new window.Event("change", { bubbles: true })); await flush();
};
try {
  await flush(); assert.deepEqual(calls, []); assert.equal(starts, 0);
  assert.equal(button("microphone-input").value, "built_in");
  let resolveSelection;
  select = () => new Promise(resolve => { resolveSelection = resolve; });
  button("record-button").click(); await flush();
  assert.deepEqual(calls, ["built_in"]); assert.equal(starts, 0);
  assert.equal(button("microphone-input").disabled, true);
  button("record-button").click(); await choose("bluetooth");
  resolveSelection({ version: 1, input: "built_in" }); await flush();
  assert.equal(starts, 1); assert.equal(calls.length, 1);
  await change("recording"); assert.equal(button("microphone-input").disabled, true);
  await change("paused"); await choose("bluetooth"); assert.equal(calls.length, 1);
  select = async input => ({ version: 1, input });
  button("resume-recording").click(); await flush();
  assert.equal(resumes, 1); assert.equal(calls.at(-1), "bluetooth");
  await choose("external"); button("resume-recording").click(); await flush();
  assert.equal(resumes, 2); assert.equal(calls.at(-1), "external");
  await choose("bluetooth");
  for (const response of [undefined, { version: 2, input: "bluetooth" }, { version: 1, input: "built_in" }]) {
    select = async () => response;
    button("resume-recording").click(); await flush(); assert.equal(resumes, 2);
    assert.ok(root.querySelector('[role="alert"]').textContent.includes("could not be confirmed"));
  }
  select = async () => { throw new Error("invented private native detail"); };
  button("resume-recording").click(); await flush(); assert.equal(resumes, 2);
  assert.equal(root.textContent.includes("private native detail"), false);
  select = () => new Promise(resolve => { resolveSelection = resolve; });
  button("resume-recording").click(); await flush(); abort.abort();
  resolveSelection({ version: 1, input: "bluetooth" }); await flush();
  assert.equal(resumes, 2); assert.equal(button("microphone-input"), null);
  console.log("iPhone microphone UI: explicit default/choice, confirmed start/resume, busy fencing, failed confirmation and revocation passed.");
} finally { dispose(); dom.window.close(); }
