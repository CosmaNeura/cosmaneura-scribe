import assert from "node:assert/strict";
import test from "node:test";
import { installAdmissionObserver } from "./admission-observer.mjs";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const binding = { runId: id(1), workspaceId: id(2), appointmentRef: "appointment_01m5q8r3kzeng9szb5frh6ppk3" };
const request = { requestId: id(3), revision: id(4), action: "capture-admissions", body: JSON.stringify({
  workspace_id: binding.workspaceId, binding_ref: "synthetic-mount-reference", request_nonce: id(5),
  attestation: { secretFixture: "must never persist" },
}) };
const response = { status: 200, requestId: id(3), revision: id(4), body: JSON.stringify({
  status: "admitted", workspace_id: binding.workspaceId, appointment_ref: binding.appointmentRef,
  binding_ref: "synthetic-mount-reference",
  request_nonce: id(5), consent_record_id: id(6), session_id: id(7),
  operation_ref: "scribe_admission_01m5q8r3kzeng9szb5frh6ppk3", protected: "must never persist",
}) };

test("observes only the exact normal admission and preserves promise identity", async () => {
  const promise = Promise.resolve(response), original = () => promise;
  globalThis.window = { Capacitor: { nativePromise: original } };
  installAdmissionObserver(binding);
  const described = window.__scribeLabAdmissionObserver.describe();
  assert.deepEqual(described, binding);
  described.runId = id(99);
  assert.deepEqual(window.__scribeLabAdmissionObserver.describe(), binding);
  assert.equal(window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRequest", request), promise);
  await promise;
  const receipt = window.__scribeLabAdmissionObserver.read();
  assert.equal(receipt.consentRecordId, id(6)); assert.equal(receipt.sessionId, id(7));
  assert.equal(receipt.requestId, id(3)); assert.equal(receipt.appointmentRef, binding.appointmentRef);
  assert(!JSON.stringify(receipt).includes("must never persist"));
  assert(!Object.keys(receipt).includes("body"));
  window.__scribeLabAdmissionObserver.uninstall();
  assert.equal(window.Capacitor.nativePromise, original);
});

test("clearing excludes an older reply and unrelated actions never become consent", async () => {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  globalThis.window = { Capacitor: { nativePromise: () => pending } };
  installAdmissionObserver(binding);
  window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRequest", request);
  window.__scribeLabAdmissionObserver.clear(); finish(response); await pending;
  assert.equal(window.__scribeLabAdmissionObserver.read(), null);
  window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRequest", { ...request, action: "capture-notes" });
  window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRequest", { ...request,
    body: JSON.stringify({ workspace_id: id(22), binding_ref: "synthetic-mount-reference", request_nonce: id(5) }) });
  await pending; assert.equal(window.__scribeLabAdmissionObserver.read(), null);
  window.__scribeLabAdmissionObserver.uninstall();
});

test("rejects stale context, denied admission, wrong nonce and malformed reply", async () => {
  const body = JSON.parse(response.body);
  for (const changed of [
    { ...response, status: 403 }, { ...response, requestId: id(91) },
    { ...response, revision: id(92) }, { ...response, body: "not json" },
    ...[{ status: "denied" }, { request_nonce: id(93) }, { workspace_id: id(94) }, { binding_ref: "wrong-mount" },
      { appointment_ref: "appointment_01m5q8r3kzeng9szb5frh6ppk4" },
      { consent_record_id: null }, { session_id: "not-a-session" }]
      .map(patch => ({ ...response, body: JSON.stringify({ ...body, ...patch }) })),
  ]) {
    const pending = Promise.resolve(changed);
    globalThis.window = { Capacitor: { nativePromise: () => pending } };
    installAdmissionObserver(binding);
    window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRequest", request);
    await pending;
    assert.equal(window.__scribeLabAdmissionObserver.read(), null);
    window.__scribeLabAdmissionObserver.uninstall();
  }
});

test("expires a receipt and never changes a failed product promise", async () => {
  const originalPerformance = globalThis.performance;
  let now = 5;
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => now, timeOrigin: 10 } });
  try {
    let result = Promise.resolve(response);
    globalThis.window = { Capacitor: { nativePromise: () => result } };
    installAdmissionObserver(binding);
    window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRequest", request);
    await result;
    assert.equal(window.__scribeLabAdmissionObserver.read().observedAtMonotonicMs, 5);
    now = 120006;
    assert.equal(window.__scribeLabAdmissionObserver.read(), null);
    const failure = new Error("synthetic private message");
    result = Promise.reject(failure);
    assert.equal(window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRequest", request), result);
    await assert.rejects(result, error => error === failure);
    assert.equal(window.__scribeLabAdmissionObserver.read(), null);
    window.__scribeLabAdmissionObserver.uninstall();
  } finally { Object.defineProperty(globalThis, "performance", { configurable: true, value: originalPerformance }); }
});

test("retains actual native phases and counts only for the admitted recording", async () => {
  let value = response, pending = null;
  globalThis.window = { Capacitor: { nativePromise: () => pending ?? Promise.resolve(value) } };
  installAdmissionObserver(binding);
  await window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRequest", request);
  value = { version: 1, revision: 1, recorderId: id(8), sessionId: id(7), phase: "ready", busy: false,
    recordedChunks: 0, recordedPlaintextBytes: 0, capturedAudioFrames: 0, input: "built_in",
    completion: { leaseId: "not retained" }, signal: { private: "not retained" } };
  const open = { requestId: id(9), revision: id(4), sessionId: id(7),
    workspaceId: binding.workspaceId, bindingRef: "synthetic-mount-reference" };
  await window.Capacitor.nativePromise("CosmasWorkspaceAuth", "openProviderRecording", open);
  assert.equal(window.__scribeLabAdmissionObserver.readRecording().phase, "ready");
  const command = { requestId: id(10), revision: id(4), recorderId: id(8), kind: "read" };
  value = { ...value, phase: "recording", revision: 2, capturedAudioFrames: 16000 };
  await window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRecordingCommand", command);
  const observed = window.__scribeLabAdmissionObserver.readRecording();
  assert.equal(observed.phase, "recording"); assert.equal(observed.capturedAudioFrames, 16000);
  assert.equal(observed.source, "normal-native-recording-response");
  assert(!JSON.stringify(observed).includes("not retained"));
  let finishOldRead;
  pending = new Promise(resolve => { finishOldRead = resolve; });
  const oldRead = window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRecordingCommand", command);
  let finishPause;
  pending = new Promise(resolve => { finishPause = resolve; });
  const mutation = window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRecordingCommand", { ...command, kind: "pause" });
  assert.equal(window.__scribeLabAdmissionObserver.readRecording(), null);
  finishOldRead(value); await oldRead;
  assert.equal(window.__scribeLabAdmissionObserver.readRecording(), null);
  pending = Promise.resolve(value);
  await window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRecordingCommand", command);
  assert.equal(window.__scribeLabAdmissionObserver.readRecording(), null);
  finishPause({ ...value, phase: "paused", revision: 3 }); await mutation; pending = null;
  assert.equal(window.__scribeLabAdmissionObserver.readRecording().phase, "paused");
  value = { ...value, phase: "paused", sessionId: id(99), revision: 3 };
  await window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRecordingCommand", command);
  assert.equal(window.__scribeLabAdmissionObserver.readRecording(), null);
  value = { ...value, sessionId: id(7), revision: 1 };
  await window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRecordingCommand", command);
  assert.equal(window.__scribeLabAdmissionObserver.readRecording(), null);
  value = { ...value, phase: "paused", revision: 4 };
  await window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRecordingCommand", { ...command, kind: "pause" });
  assert.equal(window.__scribeLabAdmissionObserver.readRecording().phase, "paused");
  assert.equal(window.__scribeLabAdmissionObserver.readTerminal(), null);
  value = { ...value, phase: "sealed", revision: 5 };
  await window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRecordingCommand", { ...command, kind: "finish" });
  assert.equal(window.__scribeLabAdmissionObserver.readTerminal().sessionId, id(7));
  const stoppedAt = window.__scribeLabAdmissionObserver.readTerminal().observedAtMonotonicMs;
  await new Promise(resolve => setTimeout(resolve, 5));
  value = { ...value, revision: 6 };
  await window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRecordingCommand", command);
  assert(window.__scribeLabAdmissionObserver.readRecording().observedAtMonotonicMs > stoppedAt);
  assert.equal(window.__scribeLabAdmissionObserver.readTerminal().observedAtMonotonicMs, stoppedAt);
  let finishAdmission;
  pending = new Promise(resolve => { finishAdmission = resolve; });
  const admissionRequest = window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRequest", request);
  assert.equal(window.__scribeLabAdmissionObserver.read(), null);
  assert.equal(window.__scribeLabAdmissionObserver.readRecording(), null);
  assert.equal(window.__scribeLabAdmissionObserver.readTerminal(), null);
  finishAdmission(response); await admissionRequest;
  window.__scribeLabAdmissionObserver.clear();
  assert.equal(window.__scribeLabAdmissionObserver.readRecording(), null);
  window.__scribeLabAdmissionObserver.uninstall();
});
