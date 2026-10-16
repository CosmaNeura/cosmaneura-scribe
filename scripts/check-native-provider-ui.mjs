// Actual compiled iOS host, controller, controls and meter. Native replies and
// prior all-party consent are synthetic; no OS source, account or network runs.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";
import { IDBFactory } from "fake-indexeddb";
const [bundle, jsdomPath] = process.argv.slice(2);
if (!bundle || !jsdomPath) throw new Error("Usage: check-native-provider-ui.mjs provider-capture.js jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomPath));
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "capacitor://localhost/index.html", runScripts: "outside-only", pretendToBeVisual: true });
const window = dom.window, root = window.document.getElementById("root"), calls = [];
Object.defineProperty(window, "crypto", { value: webcrypto });
Object.assign(window, { Headers, Response, TextEncoder, TextDecoder, structuredClone, indexedDB: new IDBFactory() });
const forbidden = () => { throw new Error("No OS source, Core operation, key replacement or network permitted"); };
window.fetch = forbidden;
window.CapacitorCustomPlatform = { name: "ios" };
window.Capacitor = { PluginHeaders: ["IOSPCM", "SecureQueue", "CosmasWorkspaceAuth"].map(name => ({ name, methods: [] })), nativePromise: forbidden };
let locked = false;
Object.defineProperty(window.navigator, "locks", { value: { request: async (name, _options, callback) => {
  if (locked) return callback(null); locked = true;
  try { return await callback({ name, mode: "exclusive" }); } finally { locked = false; }
} } });
const module = new SourceTextModule(await readFile(bundle, "utf8"), { context: dom.getInternalVMContext() });
await module.link(forbidden); await module.evaluate();
const sessionId = webcrypto.randomUUID(), abort = new window.AbortController();
let heldStart, hold = true;
let state = { version: 1, revision: 1, recorderId: webcrypto.randomUUID(), sessionId, phase: "ready", failure: null, busy: false,
  recordedChunks: 0, recordedPlaintextBytes: 0, capturedAudioFrames: 0, maximumPlaintextBytes: 402653184, input: "built_in", completion: null,
  signal: { version: 2, signal: null } };
const update = fields => { state = { ...state, ...fields, revision: state.revision + 1 }; };
const response = requestId => ({ requestId, ok: true, recording: structuredClone(state) });
const nativeRecording = { open: async (_session, requestId) => response(requestId), command: async request => {
  calls.push(request.kind);
  if (request.kind === "close") return { requestId: request.requestId, ok: true, recording: null };
  if (request.kind === "start") {
    if (hold) { update({ phase: "starting", busy: true }); await new Promise(done => { heldStart = done; }); }
    else update({ phase: "recording", failure: null, busy: false, signal: { version: 2, signal: { inputBuffers: 30, convertedBuffers: 30,
      inputEverNonzero: true, convertedEverNonzero: true, inputLevel: 0.1, convertedLevel: 0.1,
      inputAgeMs: 0, convertedAgeMs: 0, zeroInputMs: 0, inputMuted: false, route: "usb" } } });
  } else if (request.kind === "pause") { update({ phase: "paused", busy: false }); heldStart?.(); }
  else if (request.kind === "input") update({ input: request.input });
  return response(request.requestId);
} };
const encounter = { appointmentRef: "appointment_01j00000000000000000000000", title: "Synthetic visit", detail: "Invented all-party consent" };
const host = module.namespace.createProviderIOSHost({ signal: abort.signal, listEncounters: async () => [encounter], createEncounter: forbidden,
  openEncounter: async () => ({ encounter, recoveryScope: webcrypto.randomUUID(), signal: abort.signal,
    scope: { workspaceId: webcrypto.randomUUID(), appointmentRef: encounter.appointmentRef, bindingRef: "scribe_capture_binding_01j00000000000000000000000" },
    reauthorizeRecorder: async () => {}, nativeRecording, request: forbidden, openInCore: forbidden,
    uploadTarget: { putCompleteEnvelope: forbidden }, prepareNativeSource: forbidden, releaseNativeSource: forbidden }) });
const resources = await (await host.openEncounter(encounter.appointmentRef, abort.signal)).recorder(sessionId, abort.signal);
assert.equal(resources.captureMode, "native_microphone");
const app = window.document.createElement("cosmaneura-capture");
app.bindProvider({ sessionId, controller: resources.controller, captureMode: resources.captureMode, sourceKind: "microphone",
  languageMode: "english", signal: abort.signal, authorizedRequest: forbidden,
  journal: { load: async () => null, save: forbidden, clear: forbidden }, deactivate: resources.deactivate });
root.append(app);
const button = id => app.querySelector(`[data-testid="${id}"]`);
const until = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(done => setTimeout(done, 10)); }
  throw new Error("Native provider UI state did not arrive");
};
try {
  await until(() => button("record-button"));
  assert.equal(calls.length, 0);
  assert.equal(app.textContent.includes("Keep this app in the foreground"), false);
  button("record-button").click();
  await until(() => button("stop-button").textContent.includes("Cancel start"));
  assert.equal(button("stop-button").disabled, false);
  assert.equal(app.querySelector("scribe-ios-input-meter"), null);
  button("stop-button").click();
  await until(() => button("resume-recording") && !button("resume-recording").disabled);
  assert.deepEqual(calls, ["start", "pause"]);
  button("resume-recording").click();
  await until(() => button("stop-button").textContent.includes("Cancel start"));
  assert.equal(button("stop-button").disabled, false);
  assert.ok(app.textContent.includes("Starting microphone"));
  button("stop-button").click();
  await until(() => button("resume-recording") && !button("resume-recording").disabled);
  const input = button("microphone-input"); input.value = "external"; input.dispatchEvent(new window.Event("change"));
  hold = false; button("resume-recording").click();
  await until(() => app.querySelector("scribe-ios-input-meter")?.shadowRoot?.textContent.includes("USB microphone"));
  const meter = app.querySelector("scribe-ios-input-meter").shadowRoot;
  assert.ok(Number(meter.querySelector('[role="meter"]').getAttribute("aria-valuenow")) > 0);
  assert.ok(calls.includes("input")); assert.ok(calls.includes("read"));
  for (const seconds of [1, 2]) {
    update({ capturedAudioFrames: seconds * 16_000 });
    await resources.controller.refreshTranscriptionStatus();
    await until(() => app.querySelector(".recording-duration")?.textContent.includes(`0:0${seconds}`));
    assert.equal(resources.controller.snapshot.recordedChunks, 0);
  }
  // A suspended/hidden renderer does not close native recording.
  Object.defineProperty(window.document, "visibilityState", { configurable: true, value: "hidden" });
  window.document.dispatchEvent(new window.Event("visibilitychange"));
  assert.equal(calls.includes("close"), false);
  const startsBeforeInterruption = calls.filter(kind => kind === "start").length;
  update({ phase: "paused", failure: "captureInterrupted" });
  await resources.controller.refreshTranscriptionStatus();
  await until(() => app.textContent.includes("Recording was interrupted."));
  assert.ok(app.textContent.includes("Speech during the interruption was not recorded."));
  assert.equal(app.querySelector("scribe-ios-input-meter"), null);
  assert.equal(button("resume-recording").disabled, false);
  assert.equal(button("stop-button").disabled, false);
  assert.equal(calls.filter(kind => kind === "start").length, startsBeforeInterruption);
  button("resume-recording").click();
  await until(() => app.querySelector("scribe-ios-input-meter"));
  assert.equal(app.textContent.includes("Recording was interrupted."), false);
  assert.equal(calls.filter(kind => kind === "start").length, startsBeforeInterruption + 1);
  update({ phase: "stopPending", failure: "stopPending" });
  await resources.controller.refreshTranscriptionStatus();
  await until(() => button("stop-button").textContent.includes("Retry finish recording"));
  assert.equal(button("resume-recording"), null);
  update({ phase: "paused", failure: "recoveryFailed", recordedChunks: 1, recordedPlaintextBytes: 204 });
  await resources.controller.refreshTranscriptionStatus();
  await until(() => button("resume-recording")?.textContent.includes("Resume recording"));
  assert.ok(button("stop-button").textContent.includes("Retry saving"));
  assert.ok(app.textContent.includes("Saving is not confirmed."));
  button("stop-button").click();
  await app.updateComplete;
  await until(() => calls.includes("seal") && resources.controller.snapshot.statusCode === "capture_recovery_pending"
    && !button("resume-recording").disabled && app.textContent.includes("Saving is not confirmed."));
  assert.ok(app.textContent.includes("Saving is not confirmed."));
  const startsBeforeRecovery = calls.filter(kind => kind === "start").length;
  button("resume-recording").click();
  await until(() => app.querySelector("scribe-ios-input-meter"));
  assert.equal(calls.filter(kind => kind === "start").length, startsBeforeRecovery + 1);
  assert.equal(app.textContent.includes("Saving is not confirmed."), false);
  app.remove(); await resources.deactivate();
  assert.equal(calls.filter(kind => kind === "close").length, 1); assert.equal(locked, false);
  // The same compiled screen renders receipt-confirmed progress and keeps
  // completion confirmation distinct from bytes having reached the server.
  const upload = window.document.createElement("cosmaneura-capture");
  const snapshot = { ...resources.controller.snapshot, state: "uploading", statusCode: "capture_uploading",
    recordedChunks: 1080, queuedChunks: 540, elapsedSeconds: 10800,
    native: { phase: "sealed", busy: false, uploadProgress: { total: 1080, registered: 540 } } };
  let notify, finish;
  const recording = { ...snapshot, state: "recording", statusCode: "capture_recording", native: { phase: "recording", busy: false } };
  upload.bindProvider({ sessionId, controller: { ...resources.controller, snapshot,
    stopRecording: () => new Promise(done => { finish = done; }),
    subscribe: listener => { notify = listener; listener(recording); return () => {}; } },
  captureMode: "native_microphone", sourceKind: "microphone", languageMode: "english", signal: abort.signal,
  authorizedRequest: forbidden, journal: { load: async () => null, save: forbidden, clear: forbidden },
  deactivate: async () => {} });
  root.append(upload);
  await until(() => upload.querySelector('[data-testid="stop-button"]'));
  upload.querySelector('[data-testid="stop-button"]').click();
  await until(() => upload.textContent.includes("Stopping recording…"));
  notify({ ...snapshot, statusCode: "capture_sealing", native: { phase: "sealing", busy: true } });
  await until(() => upload.textContent.includes("Saving recording before upload…"));
  assert.equal(upload.textContent.includes("Stopping recording…"), false);
  notify(snapshot);
  await until(() => upload.querySelector("progress"));
  assert.equal(upload.querySelector("progress").max, 1080);
  assert.equal(upload.querySelector("progress").value, 540);
  assert.ok(upload.textContent.includes("Audio uploaded 50%"));
  assert.ok(upload.textContent.includes("Recording stopped. Uploading your saved audio…"));
  assert.equal(upload.textContent.includes("Stopping…"), false);
  assert.equal(upload.querySelector('[data-testid="stop-button"]').disabled, true);
  assert.ok(upload.textContent.includes("Elapsed 3:00:00"));
  notify({ ...snapshot, statusCode: "capture_upload_confirming", queuedChunks: 0,
    native: { ...snapshot.native, uploadProgress: { total: 1080, registered: 1080 } } });
  await until(() => upload.textContent.includes("Confirming receipt before transcription"));
  assert.equal(upload.querySelector("progress").value, 1080);
  finish();
  upload.remove();
  console.log(JSON.stringify({ checks: 11, compiled_native_provider: true, source_and_core_fixtures: true,
    cancellable_start: true, native_meter_and_input: true, physical_recording: false }));
} finally { heldStart?.(); await resources.deactivate(); dom.window.close(); }
