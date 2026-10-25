import assert from "node:assert/strict";
import test from "node:test";
import { installAdmissionObserver } from "./admission-observer.mjs";

test('retained admission observer exposes implementation identity and refuses teardown of pending native work', async () => {
  let settle;
  const pending = new Promise(resolve => { settle = resolve; }), original = () => pending;
  globalThis.window = { Capacitor: { nativePromise: original } };
  const binding = { runId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', appointmentRef: 'appointment_01m5q8r3kzeng9szb5frh6ppk3' };
  installAdmissionObserver(binding, null, 'a'.repeat(64));
  const observer = window.__scribeLabAdmissionObserver;
  assert.equal(window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'getState', {}), pending);
  assert.equal(observer.describe().observerSHA256, 'a'.repeat(64));
  assert.equal(observer.describe().pendingObservedReplies, 1);
  assert.equal(observer.uninstall().ownedResourcesSettled, false);
  assert.equal(window.__scribeLabAdmissionObserver, observer);
  settle(null); await pending;
  assert.equal(observer.describe().pendingObservedReplies, 0);
  assert.equal(observer.uninstall().ownedResourcesSettled, true);
  assert.equal(window.Capacitor.nativePromise, original);
});

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
  assert.deepEqual(described, { ...binding, observerSHA256: null, pendingObservedReplies: 0 });
  described.runId = id(99);
  assert.deepEqual(window.__scribeLabAdmissionObserver.describe(), { ...binding, observerSHA256: null, pendingObservedReplies: 0 });
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
  globalThis.window = { Capacitor: { nativePromise: (_plugin, method, options) => pending ?? Promise.resolve(
    ['openProviderRecording', 'providerRecordingCommand'].includes(method) ? { requestId: options.requestId, ok: true, recording: value } : value) } };
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
  finishOldRead({ requestId: command.requestId, ok: true, recording: value }); await oldRead;
  assert.equal(window.__scribeLabAdmissionObserver.readRecording(), null);
  pending = Promise.resolve({ requestId: command.requestId, ok: true, recording: value });
  await window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRecordingCommand", command);
  assert.equal(window.__scribeLabAdmissionObserver.readRecording(), null);
  finishPause({ requestId: command.requestId, ok: true, recording: { ...value, phase: "paused", revision: 3 } }); await mutation; pending = null;
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
  await window.Capacitor.nativePromise("CosmasWorkspaceAuth", "providerRecordingCommand", { ...command, kind: "seal" });
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

// Public build7 reply shape: NativeProviderRecordingBridge.snapshot and
// PCMSignalMonitor.Snapshot. No hardware or native requests occur in these tests.
const silentSignal = () => ({ version: 2, signal: {
  inputBuffers: 12, convertedBuffers: 11, inputEverNonzero: false, convertedEverNonzero: false,
  inputLevel: 0, convertedLevel: 0, inputAgeMs: 4, convertedAgeMs: 7,
  zeroInputMs: 250, route: 'built_in', inputMuted: false,
} });
async function signalHarness() {
  let value = response, calls = 0, lastPromise;
  globalThis.window = { Capacitor: { nativePromise: (_plugin, method, options) => {
    calls++; return lastPromise = Promise.resolve(['openProviderRecording', 'providerRecordingCommand'].includes(method)
      ? { requestId: options.requestId, ok: true, recording: value } : value);
  } } };
  installAdmissionObserver(binding);
  await window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'providerRequest', request);
  value = { version: 1, revision: 1, recorderId: id(8), sessionId: id(7), phase: 'recording', busy: false,
    recordedChunks: 0, recordedPlaintextBytes: 0, capturedAudioFrames: 4000, input: 'built_in', signal: silentSignal() };
  await window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'openProviderRecording', {
    requestId: id(9), revision: id(4), sessionId: id(7), workspaceId: binding.workspaceId,
    bindingRef: 'synthetic-mount-reference',
  });
  return { observer: window.__scribeLabAdmissionObserver,
    calls: () => calls,
    async reply(signal, patch = {}) {
      value = { ...value, ...patch, revision: value.revision + 1, signal };
      const promise = window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'providerRecordingCommand', {
        requestId: id(10), revision: id(4), recorderId: id(8), kind: 'read',
      });
      assert.equal(promise, lastPromise);
      assert.equal((await promise).recording, value);
      return value;
    },
  };
}

test('projects separate input/conversion boundaries without retaining arbitrary native fields or making requests', async () => {
  const h = await signalHarness();
  try {
    const initial = h.observer.readRecording();
    assert.deepEqual(initial.signal, { version: 2, ...silentSignal().signal });
    assert.equal(initial.capturedAudioFrames, 4000);
    const inputOnly = silentSignal();
    Object.assign(inputOnly.signal, { inputBuffers: 24, inputEverNonzero: true, inputLevel: 0.2,
      zeroInputMs: 0, deviceUID: 'must-not-retain', audioURL: 'must-not-retain', samples: [1, 2] });
    inputOnly.private = 'must-not-retain';
    const productValue = await h.reply(inputOnly);
    assert.equal(productValue.signal, inputOnly);
    const input = h.observer.readRecording();
    assert.equal(input.signal.inputEverNonzero, true);
    assert.equal(input.signal.convertedEverNonzero, false);
    assert(!JSON.stringify(input).includes('must-not-retain'));
    input.signal.inputBuffers = 999;
    assert.equal(h.observer.readRecording().signal.inputBuffers, 24);
    const converted = silentSignal();
    Object.assign(converted.signal, { inputBuffers: 25, convertedBuffers: 24,
      inputEverNonzero: true, convertedEverNonzero: true, inputLevel: 0.25, convertedLevel: 0.24, zeroInputMs: 0 });
    await h.reply(converted, { capturedAudioFrames: 16000 });
    const end = h.observer.readRecording();
    assert.equal(end.signal.convertedEverNonzero, true);
    assert.equal(end.capturedAudioFrames, 16000);
    assert(end.nativeRevision > initial.nativeRevision);
    assert.equal(end.sessionId, initial.sessionId);
    assert.equal(h.calls(), 4); // admission/open and exactly the two product reads above
  } finally { assert.equal(h.observer.uninstall().ownedResourcesSettled, true); }
});

test('absent or malformed signal is unavailable and never reuses earlier nonzero evidence', async () => {
  const h = await signalHarness();
  try {
    const invalid = [undefined, null, { version: 1, signal: silentSignal().signal }, { version: 2, signal: null },
      ...[{ inputBuffers: -1 }, { convertedBuffers: 2147483648 }, { inputBuffers: 1.5 },
        { inputEverNonzero: 1 }, { convertedEverNonzero: 'true' }, { inputLevel: NaN },
        { convertedLevel: Infinity }, { inputLevel: 1.01 }, { convertedLevel: -0.01 },
        { inputAgeMs: -1 }, { convertedAgeMs: 86400001 }, { inputAgeMs: undefined },
        { zeroInputMs: null }, { zeroInputMs: 0.5 }, { zeroInputMs: 86400001 },
        { route: 'BlackHole2ch_UID' }, { inputMuted: undefined }]
        .map(patch => ({ version: 2, signal: { ...silentSignal().signal, ...patch } }))];
    for (const malformed of invalid) {
      await h.reply({ version: 2, signal: { ...silentSignal().signal, inputEverNonzero: true } });
      assert.equal(h.observer.readRecording().signal.inputEverNonzero, true);
      await h.reply(malformed);
      assert.equal(h.observer.readRecording().signal, null);
    }
    for (const route of ['none', 'built_in', 'bluetooth', 'wired', 'usb', 'other']) {
      await h.reply({ version: 2, signal: { ...silentSignal().signal, route,
        inputAgeMs: null, convertedAgeMs: 86400000, inputMuted: true } });
      assert.equal(h.observer.readRecording().signal.route, route);
    }
  } finally { assert.equal(h.observer.uninstall().ownedResourcesSettled, true); }
});

test('signal shares recorder freshness, stop history and scope invalidation', async () => {
  const originalPerformance = globalThis.performance;
  let now = 5;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now, timeOrigin: 10 } });
  const h = await signalHarness();
  try {
    now += 15001;
    assert.equal(h.observer.readRecording(), null);
    await h.reply(silentSignal(), { phase: 'sealed' });
    const terminal = h.observer.readTerminal();
    terminal.signal.route = 'usb';
    assert.equal(h.observer.readTerminal().signal.route, 'built_in');
    now += 15001;
    assert.equal(h.observer.readRecording(), null);
    assert.equal(h.observer.readTerminal().observedAtMonotonicMs, terminal.observedAtMonotonicMs);
    await h.reply(silentSignal(), { sessionId: id(99) });
    assert.equal(h.observer.readRecording(), null);
    assert.equal(h.observer.readTerminal(), null);
  } finally {
    assert.equal(h.observer.uninstall().ownedResourcesSettled, true);
    Object.defineProperty(globalThis, 'performance', { configurable: true, value: originalPerformance });
  }
});

async function lifecycleHarness() {
  let next, lastPromise, nextError;
  const original = () => { if (nextError) { const error = nextError; nextError = null; throw error; }
    return lastPromise = Promise.resolve(next); };
  globalThis.window = { Capacitor: { nativePromise: original } };
  installAdmissionObserver(binding);
  next = response; await window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'providerRequest', request);
  const state = { version: 1, revision: 8, recorderId: id(8), sessionId: id(7), phase: 'sealed', busy: false,
    recordedChunks: 2, recordedPlaintextBytes: 32000, capturedAudioFrames: 16000, input: 'built_in' };
  const open = { requestId: id(9), revision: id(4), workspaceId: binding.workspaceId, bindingRef: 'synthetic-mount-reference', sessionId: id(7) };
  next = { requestId: open.requestId, ok: true, recording: state };
  await window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'openProviderRecording', open);
  const close = { requestId: id(10), revision: id(4), recorderId: id(8), kind: 'close' };
  return { observer: window.__scribeLabAdmissionObserver, state, open, close,
    throws(method, options, error) { nextError = error;
      assert.throws(() => window.Capacitor.nativePromise('CosmasWorkspaceAuth', method, options), actual => actual === error); },
    invoke(method, options, reply) { next = reply; const promise = window.Capacitor.nativePromise('CosmasWorkspaceAuth', method, options);
      assert.equal(promise, lastPromise); return promise; } };
}

test('actual recording envelope is required; a flat state, failed or foreign reply never becomes native evidence', async () => {
  for (const change of [value => value.recording, value => ({ ...value, requestId: id(99) }),
    value => ({ ...value, ok: false }), value => ({ ...value, recording: null })]) {
    const h = await lifecycleHarness();
    await h.invoke('openProviderRecording', h.open, change({ requestId: h.open.requestId, ok: true, recording: h.state }));
    assert.equal(h.observer.readRecording(), null); assert.equal(h.observer.readClosed(), null);
    h.observer.uninstall();
  }
});

test('correlated close survives same-scope navigation and remains an absorbing lifecycle receipt, not fresh recording', async () => {
  const h = await lifecycleHarness(); let settle;
  const held = new Promise(resolve => { settle = resolve; });
  const promise = h.invoke('providerRecordingCommand', h.close, held);
  h.observer.clear({ reason: 'navigation' });
  assert.equal(h.observer.readClosed(), null); assert.equal(h.observer.uninstall().ownedResourcesSettled, false);
  settle({ requestId: h.close.requestId, ok: true, recording: null }); await promise;
  const closed = h.observer.readClosed();
  assert.equal(closed.source, 'normal-native-recorder-close-response'); assert.equal(closed.phase, 'closed');
  assert.equal(closed.sessionId, id(7)); assert.equal(closed.recorderId, id(8));
  assert.equal(closed.nativeRevisionBeforeClose, 8); assert.equal(closed.pendingObservedReplies, 0);
  assert.equal(closed.currentCaptureMutationSequence, closed.captureMutationSequence);
  assert.equal(h.observer.rebindCurrent({ ...binding, revision: id(4) }), true);
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(h.observer.readClosed().observedAtMonotonicMs, closed.observedAtMonotonicMs);
  assert(h.observer.readClosed().inspectedAtMonotonicMs > closed.inspectedAtMonotonicMs);
  assert.equal(h.observer.readRecording(), null); assert.equal(h.observer.read(), null);
  h.observer.rebindCurrent({ ...binding, workspaceId: id(99), revision: id(4) });
  assert.equal(h.observer.readClosed(), null); h.observer.uninstall();
});

test('failed, uncorrelated and late closes cannot settle a newer recorder or survive auth invalidation', async () => {
  for (const patch of [{ ok: false }, { requestId: id(99) }, { recording: {} }, { unexpected: true }]) {
    const h = await lifecycleHarness();
    await h.invoke('providerRecordingCommand', h.close, { requestId: h.close.requestId, ok: true, recording: null, ...patch });
    assert.equal(h.observer.readClosed(), null); h.observer.uninstall();
  }
  for (const invalidate of ['open', 'start', 'auth']) {
    const h = await lifecycleHarness(); let settle;
    const closing = h.invoke('providerRecordingCommand', h.close, new Promise(resolve => { settle = resolve; }));
    if (invalidate === 'auth') h.observer.clear();
    else if (invalidate === 'open') await h.invoke('openProviderRecording', h.open, { requestId: h.open.requestId, ok: true, recording: h.state });
    else await h.invoke('providerRecordingCommand', { ...h.close, requestId: id(11), kind: 'start' }, { requestId: id(11), ok: true, recording: h.state });
    settle({ requestId: h.close.requestId, ok: true, recording: null }); await closing;
    assert.equal(h.observer.readClosed(), null); h.observer.uninstall();
  }
});

test('idempotent iOS close retains its first timestamp, and old close acknowledgement cannot bind a new recorder', async () => {
  const h = await lifecycleHarness(), reply = { requestId: h.close.requestId, ok: true, recording: null };
  await h.invoke('providerRecordingCommand', h.close, reply);
  const first = h.observer.readClosed(); await new Promise(resolve => setTimeout(resolve, 2));
  const repeat = { ...h.close, requestId: id(11) };
  await h.invoke('providerRecordingCommand', repeat, { ...reply, requestId: repeat.requestId });
  const repeated = h.observer.readClosed();
  assert.equal(repeated.observedAtMonotonicMs, first.observedAtMonotonicMs);
  assert.equal(repeated.closeRequestId, first.closeRequestId);
  assert(repeated.captureMutationSequence > first.captureMutationSequence);
  assert.equal(repeated.captureMutationSequence, repeated.currentCaptureMutationSequence);
  await h.invoke('openProviderRecording', h.open, { requestId: h.open.requestId, ok: true,
    recording: { ...h.state, recorderId: id(88) } });
  await h.invoke('providerRecordingCommand', h.close, reply);
  assert.equal(h.observer.readClosed(), null); h.observer.uninstall();
});

test('synchronous recording or admission mutations invalidate closed evidence without replacing the product error', async () => {
  for (const [method, options] of [['openProviderRecording', null], ['providerRecordingCommand', { kind: 'start' }],
    ['providerRequest', request]]) {
    const h = await lifecycleHarness();
    await h.invoke('providerRecordingCommand', h.close, { requestId: h.close.requestId, ok: true, recording: null });
    assert(h.observer.readClosed());
    h.throws(method, options ?? h.open, new Error('original synthetic bridge failure'));
    assert.equal(h.observer.readClosed(), null); assert.equal(h.observer.describe().pendingObservedReplies, 0);
    h.observer.uninstall();
  }
});

test('every attempted admission invalidates closure even when its body cannot be observed', async () => {
  for (const body of [undefined, '{invalid', 'x'.repeat(8193), JSON.stringify({ workspace_id: id(99) })]) {
    const h = await lifecycleHarness();
    await h.invoke('providerRecordingCommand', h.close, { requestId: h.close.requestId, ok: true, recording: null });
    assert(h.observer.readClosed());
    await h.invoke('providerRequest', { ...request, body }, response);
    assert.equal(h.observer.readClosed(), null); assert.equal(h.observer.read(), null);
    h.observer.uninstall();
  }
});
