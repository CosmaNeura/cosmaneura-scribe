import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, readdir, stat, rm, realpath } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AppiumUI, IOS_OBSERVER_HASHES } from './appium-ui.mjs';
import { atomicJSON, sha256 } from './journal.mjs';
import { journalIdentity } from './tool-identity.mjs';
import { normalizedSessionCaps } from './session-attempt.mjs';
import { installAdmissionObserver } from '../native/admission-observer.mjs';
import { installVisitScopeObserver } from '../native/visit-observer.mjs';

const admission = { source: 'normal-native-admission-response', runId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222', appointmentRef: 'appointment_01m5q661ryetaa28yxe7vbqrex',
  sessionId: '33333333-3333-4333-8333-333333333333', consentRecordId: '44444444-4444-4444-8444-444444444444',
  observedAtMonotonicMs: 1, browserTimeOriginMs: Date.now() - 1 };
const recording = () => ({ ...admission, source: 'normal-native-recording-response', recorderId: '55555555-5555-4555-8555-555555555555', nativeRevision: 1, phase: 'recording', busy: false,
  observedAtMonotonicMs: 1, browserTimeOriginMs: Date.now() - 1 });
test('simulator microphone evidence must progress from captured silence to nonzero native input and conversion', () => {
  const ui = new AppiumUI('/unused');
  ui.config = { target: { role: 'owned-ios-simulator' }, sources: { participants: [{ kind: 'virtual-microphone' }] } };
  const initial = { ...recording(), recorderId: '55555555-5555-4555-8555-555555555555', capturedAudioFrames: 160,
    signal: { version: 2, inputBuffers: 1, convertedBuffers: 1, inputMuted: false,
      inputEverNonzero: false, convertedEverNonzero: false, inputLevel: 0, convertedLevel: 0 } };
  ui.assertMicrophoneSignal(initial, 'initial');
  const completed = { ...initial, capturedAudioFrames: 320, signal: { ...initial.signal, inputBuffers: 2,
    convertedBuffers: 2, inputEverNonzero: true, convertedEverNonzero: true } };
  ui.assertMicrophoneSignal(completed, 'completed');
  for (const change of [value => { value.signal = null; }, value => { value.signal.inputMuted = true; },
    value => { value.signal.inputEverNonzero = false; }, value => { value.signal.convertedEverNonzero = false; },
    value => { value.capturedAudioFrames = initial.capturedAudioFrames; }, value => { value.recorderId = admission.sessionId; }]) {
    const value = structuredClone(completed); change(value);
    assert.throws(() => ui.assertMicrophoneSignal(value, 'completed'), /native_microphone_signal_(unavailable|progress_missing)/);
  }
  assert.throws(() => ui.assertMicrophoneSignal(completed, 'initial'), /initial_silence_missing/);
  assert.throws(() => ui.assertMicrophoneSignal({ ...initial, capturedAudioFrames: 0 }, 'initial'), /signal_unavailable/);
});
async function recoveryRun(ui, output) {
  ui.scenario = { ...ui.scenario, runId: ui.scenario.runId ?? 'recovery-test', executionKind: 'mock' };
  ui.targetFingerprint = `test:${randomUUID()}`;
  await atomicJSON(join(output, 'run.json'), { identity: await journalIdentity(ui.scenario) });
  return output;
}
function driver() {
  const ui = new AppiumUI('/unused');
  ui.config = { sourceReaders: { state: { name: 'state' }, elapsed: { name: 'elapsed' } } };
  ui.scenario = { targetId: 'test-only' }; ui.admission = admission;
  ui.binding = admission; ui.assertVisit = async () => admission;
  ui.value = async reader => reader.name === 'state' ? 'Recording' : '00:03';
  return ui;
}
const artifactPNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=', 'base64');
test('phase screenshots and XML are unique private hash-bound diagnostics collected before fresh native proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scribe-phase-artifacts-'));
  try {
    const ui = driver(), order = []; ui.output = root; ui.session = 'test-owned';
    ui.check = async () => { order.push('checks'); return [{ locator: 'test', kind: 'visible', actual: true, expected: true }]; };
    ui.request = async (path, method) => { assert.equal(method, 'GET'); order.push(path);
      return path === '/screenshot' ? artifactPNG.toString('base64') : '<App><Button label="Synthetic ready"/></App>'; };
    ui.readAuth = async () => { order.push('fresh-proof'); return { identitySHA256: 'a'.repeat(64) }; };
    ui.config.accountIdentitySHA256 = 'a'.repeat(64);
    const first = await ui.observe('workspace'), second = await ui.observe('workspace');
    assert.deepEqual(order, ['checks', '/screenshot', '/source', 'fresh-proof', 'checks', '/screenshot', '/source', 'fresh-proof']);
    assert.equal(first.phaseArtifacts.collectionStatus, 'COMPLETE');
    assert.notEqual(first.phaseArtifacts.evidenceFile, second.phaseArtifacts.evidenceFile);
    for (const collection of [first.phaseArtifacts, second.phaseArtifacts]) {
      for (const artifact of [...collection.artifacts, collection]) {
        assert.match(artifact.evidenceFile, /^phase-workspace-[0-9a-f-]{36}\.(png|xml|json)$/);
        const path = join(root, artifact.evidenceFile);
        assert.equal(sha256(await readFile(path)), artifact.sha256);
        assert.equal((await stat(path)).mode & 0o777, 0o600);
      }
    }
    assert.equal((await readdir(root)).length, 6);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('phase artifacts preserve failed UI and native-proof diagnostics without replacing the original failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scribe-phase-failure-'));
  try {
    const ui = driver(); ui.output = root; ui.session = 'test-owned';
    const failure = new Error('actual_ui_assertion_failed');
    ui.check = async () => { throw failure; };
    ui.request = async path => path === '/screenshot' ? artifactPNG.toString('base64') : '<App/>';
    ui.readAuth = async () => { throw Error('must_not_read_proof_after_failed_checks'); };
    await assert.rejects(ui.observe('workspace'), error => error === failure);
    assert.equal((await readdir(root)).length, 3);
    ui.check = async () => [{ locator: 'test', kind: 'visible', actual: true, expected: true }];
    const proofFailure = new Error('actual_native_proof_missing'); ui.readAuth = async () => { throw proofFailure; };
    await assert.rejects(ui.observe('workspace'), error => error === proofFailure);
    assert.equal((await readdir(root)).length, 6);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a failed screenshot remains partial diagnostics and cannot manufacture a successful native proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scribe-phase-partial-'));
  try {
    const ui = driver(); ui.output = root; ui.session = 'test-owned';
    ui.check = async () => [{ locator: 'test', kind: 'visible', actual: true, expected: true }];
    ui.request = async path => path === '/screenshot' ? 'invalid screenshot' : '<App/>';
    const failure = new Error('actual_native_proof_missing'); ui.readAuth = async () => { throw failure; };
    await assert.rejects(ui.observe('workspace'), error => error === failure);
    const manifest = (await readdir(root)).find(name => name.endsWith('.json'));
    const receipt = JSON.parse(await readFile(join(root, manifest), 'utf8'));
    assert.equal(receipt.collectionStatus, 'PARTIAL'); assert.equal(receipt.artifacts.length, 1);
    assert.equal(receipt.artifacts[0].kind, 'accessibility-source'); assert.equal(receipt.unavailable[0].kind, 'screenshot');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('phase collection passes a bounded abort to both read-only requests and retains unavailability metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scribe-phase-abort-'));
  try {
    const ui = driver(); ui.output = root; ui.session = 'test-owned';
    const lifetime = new AbortController(); let requests = 0;
    ui.request = async (_path, method, body, signal) => {
      assert.equal(method, 'GET'); assert.equal(body, undefined); assert(signal instanceof AbortSignal); requests++;
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    };
    const started = performance.now(), work = ui.capturePhaseArtifacts('record', lifetime.signal);
    setTimeout(() => lifetime.abort(), 10);
    const receipt = await work;
    assert(performance.now() - started < 500); assert.equal(requests, 2);
    assert.equal(receipt.collectionStatus, 'UNAVAILABLE'); assert.equal(receipt.unavailable.length, 2);
    assert(receipt.evidenceFile); assert.equal((await readdir(root)).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('owned app configurations reject capabilities that reinstall or force relaunch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scribe-appium-config-'));
  try {
    const path = join(root, 'config.json'), ui = new AppiumUI(path);
    const config = { appiumUrl: 'http://127.0.0.1:4723', targetId: 'owned-test',
      target: { role: 'owned-ios-simulator' }, app: { bundleId: 'test.app', build: '1' }, admissionBinding: admission,
      accountIdentitySHA256: 'a'.repeat(64),
      capabilities: { 'appium:noReset': true, 'appium:shouldTerminateApp': false } };
    const scenario = { targetId: config.targetId, build: { bundleId: 'test.app', number: '1' }, admissionBinding: admission };
    for (const patch of [{ 'appium:forceAppLaunch': true }, { 'appium:fullReset': true }, { 'appium:app': '/tmp/other.app' },
      { 'appium:prerun': { command: 'unexpected' } }, { 'appium:postrun': { command: 'unexpected' } }]) {
      const bytes = JSON.stringify({ ...config, capabilities: { ...config.capabilities, ...patch } });
      await writeFile(path, bytes);
      await assert.rejects(ui.loadConfig({ ...scenario, adapterSHA256: sha256(bytes) }), /app_retention_required/);
    }
    const bytes = JSON.stringify(config); await writeFile(path, bytes);
    await ui.loadConfig({ ...scenario, adapterSHA256: sha256(bytes) });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('missing simulator input custody is rejected before any native UI operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scribe-input-config-'));
  try {
    const config = { appiumUrl: 'http://127.0.0.1:4723', targetId: 'owned-test', target: { role: 'owned-ios-simulator' },
      app: { bundleId: 'test.app', build: '1' }, admissionBinding: admission, accountIdentitySHA256: 'a'.repeat(64),
      capabilities: { 'appium:noReset': true, 'appium:shouldTerminateApp': false },
      sources: { participants: [{ kind: 'virtual-microphone', output: { deviceUID: 'BlackHole2ch_UID' } }] } };
    const bytes = JSON.stringify(config), path = join(root, 'config.json'); await writeFile(path, bytes);
    await assert.rejects(new AppiumUI(path).loadConfig({ targetId: 'owned-test', build: { bundleId: 'test.app', number: '1' },
      admissionBinding: admission, adapterSHA256: sha256(bytes) }), /virtual_input_custody_configuration_required/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a failed first custody sample retains evidence even if owned source cleanup rejects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scribe-input-first-failure-'));
  try {
    const target = { role: 'owned-ios-simulator', hostname: hostname(), root, marker: join(root, 'target.json'),
      udid: '11111111-1111-4111-8111-111111111111' };
    await writeFile(target.marker, JSON.stringify({ ...target, purpose: 'scribe-synthetic-virtual-lab' }));
    const helper = join(root, 'invalid-inspection'), bytes = '#!/bin/sh\nexit 0\n';
    await writeFile(helper, bytes, { mode: 0o700 });
    const ui = driver(); ui.output = root;
    ui.config.target = target;
    ui.config.sources = { participants: [{ kind: 'virtual-microphone' }], inputCustody: {
      inventoryHelper: helper, helperSHA256: sha256(bytes), expectedService: { executablePath: helper, executableSHA256: sha256(bytes) } } };
    let played = false;
    ui.sources = { participants: [{}], play: async () => { played = true; }, cleanup: async () => { throw Error('source_cleanup_unconfirmed'); } };
    await assert.rejects(ui.perform('play_source', ui.scenario, new AbortController().signal), /source_cleanup_unconfirmed/);
    assert.equal(played, false); assert.equal(ui.inputWatchUnsafe, true); assert.equal(ui.inputWatchCleanupUncertain, true);
    const saved = JSON.parse(await readFile(join(root, 'hal-input-unsafe.json'), 'utf8'));
    assert.equal(saved.assessment.status, 'BLOCKED');
    assert.equal(ui.inputWatchUnsafeEvidence.sha256, sha256(JSON.stringify(saved)));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('recovery session creation explicitly attaches without launching the app', async () => {
  const seen = [], sessionId = randomUUID(), output = await mkdtemp(join(tmpdir(), 'scribe-appium-connect-'));
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    seen.push({ method: request.method, url: request.url, body: raw ? JSON.parse(raw) : null });
    response.end(JSON.stringify({ value: request.method === 'POST' ? { sessionId, capabilities: normalizedSessionCaps(JSON.parse(raw).capabilities.alwaysMatch) }
      : request.url === '/appium/sessions' ? [] : null }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const ui = driver(); ui.base = `http://127.0.0.1:${server.address().port}`;
    ui.scenario = { runId: 'mock-appium-connect', executionKind: 'mock', targetId: 'test-only' };
    ui.targetFingerprint = randomUUID();
    await atomicJSON(join(output, 'run.json'), { identity: await journalIdentity(ui.scenario) });
    ui.config.target = { role: 'owned-ios-simulator', udid: 'owned-test-device' };
    ui.config.app = { bundleId: 'test.app' }; ui.config.capabilities = { 'appium:noReset': true,
      'appium:shouldTerminateApp': false, 'appium:autoLaunch': true };
    ui.cleanupIOSObservers = async () => ({ ownedResourcesSettled: true });
    await ui.connect(ui.scenario, { signal: new AbortController().signal, output, recoveryOnly: true });
    const caps = seen.find(value => value.method === 'POST').body.capabilities.alwaysMatch;
    assert.equal(caps['appium:autoLaunch'], false); assert.equal(caps['appium:forceAppLaunch'], false);
    assert.equal(caps['appium:noReset'], true); assert.equal(caps['appium:shouldTerminateApp'], false);
    assert.equal((await ui.cleanup({ preserveForRecovery: true })).ownedResourcesSettled, true);
    assert.deepEqual(seen.map(({ method, url }) => [method, url]), [['GET', '/appium/sessions'], ['POST', '/session'], ['DELETE', `/session/${sessionId}`], ['GET', '/appium/sessions']]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(output, { recursive: true, force: true }); }
});
test('parent abort retains the actual delayed creation response and cleanup joins and closes it', async () => {
  const output = await mkdtemp(join(tmpdir(), 'scribe-appium-late-')), sessionId = randomUUID(), seen = [];
  let submitted, release;
  const sent = new Promise(resolve => { submitted = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    seen.push([request.method, request.url]);
    if (request.method === 'POST') {
      const files = await readdir(join(output, 'appium-session-attempts'));
      assert.equal(files.length, 1); assert.equal((await stat(join(output, 'appium-session-attempts', files[0]))).mode & 0o777, 0o600);
      submitted(); await gate;
      response.end(JSON.stringify({ value: { sessionId, capabilities: normalizedSessionCaps(JSON.parse(raw).capabilities.alwaysMatch) } }));
    } else response.end(JSON.stringify({ value: request.url === '/appium/sessions' ? [] : null }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const ui = driver(), abort = new AbortController(); ui.base = `http://127.0.0.1:${server.address().port}`;
    ui.scenario = { runId: 'mock-appium-late', executionKind: 'mock' }; ui.targetFingerprint = randomUUID();
    ui.config = { target: { role: 'owned-ios-simulator', udid: randomUUID() }, app: { bundleId: 'mock.app' },
      capabilities: { 'appium:noReset': true, 'appium:shouldTerminateApp': false } };
    ui.cleanupIOSObservers = async () => ({ ownedResourcesSettled: true });
    await atomicJSON(join(output, 'run.json'), { identity: await journalIdentity(ui.scenario) });
    const connecting = ui.connect(ui.scenario, { signal: abort.signal, output, recoveryOnly: true });
    const rejected = assert.rejects(connecting, /abort/i);
    await sent; abort.abort();
    const closing = ui.cleanup(); let settled = false; closing.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(settled, false);
    release(); await rejected;
    assert.equal((await closing).ownedResourcesSettled, true); assert.equal(ui.session, null);
    const receipt = JSON.parse(await readFile(ui.creationAttempt.path, 'utf8'));
    assert.equal(receipt.phase, 'closed'); assert.equal(receipt.sessionId, sessionId);
    assert.deepEqual(seen, [['GET', '/appium/sessions'], ['POST', '/session'], ['DELETE', `/session/${sessionId}`], ['GET', '/appium/sessions']]);
  } finally { release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(output, { recursive: true, force: true }); }
});
test('lost creation transport cannot be settled by empty inventory or cleanup', async () => {
  const output = await mkdtemp(join(tmpdir(), 'scribe-appium-lost-')), seen = [];
  const server = createServer((request, response) => {
    seen.push([request.method, request.url]);
    if (request.method === 'POST') { request.resume(); request.socket.destroy(); }
    else response.end('{"value":[]}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const ui = driver(); ui.base = `http://127.0.0.1:${server.address().port}`;
    ui.scenario = { runId: 'mock-appium-lost', executionKind: 'mock' }; ui.targetFingerprint = randomUUID();
    ui.config = { target: { role: 'owned-ios-simulator', udid: randomUUID() }, app: { bundleId: 'mock.app' },
      capabilities: { 'appium:noReset': true, 'appium:shouldTerminateApp': false } };
    await atomicJSON(join(output, 'run.json'), { identity: await journalIdentity(ui.scenario) });
    await assert.rejects(ui.connect(ui.scenario, { signal: new AbortController().signal, output, recoveryOnly: true }));
    assert.equal((await ui.cleanup()).ownedResourcesSettled, false);
    assert.equal(JSON.parse(await readFile(ui.creationAttempt.path, 'utf8')).phase, 'dispatched');
    assert.equal(ui.sessionCreationUncertain, true); assert(!seen.some(([method]) => method === 'DELETE'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(output, { recursive: true, force: true }); }
});
test('Mac recovery creates only a passive inspector, never a Mac2 app session', async () => {
  const seen = [];
  const server = createServer((request, response) => { seen.push([request.method, request.url]); response.end('{"value":[]}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const ui = driver(); ui.base = `http://127.0.0.1:${server.address().port}`;
    ui.config.target = { role: 'owned-macos-lab' };
    let attached = false;
    ui.attachDesktopObserver = async (scenario, signal, readOnly) => {
      assert.equal(scenario, ui.scenario); signal.throwIfAborted(); assert.equal(readOnly, true);
      attached = true; ui.desktop = { close: async () => ({ ownedResourcesSettled: true }) };
    };
    await ui.connect(ui.scenario, { signal: new AbortController().signal, recoveryOnly: true });
    assert.equal(attached, true); assert.equal(ui.session, null);
    assert.equal((await ui.cleanup({ preserveForRecovery: true })).ownedResourcesSettled, true);
    assert.deepEqual(seen, [['GET', '/appium/sessions']]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('normal connect refuses an existing driver before Mac2 can replace it', async () => {
  const seen = [];
  const server = createServer((request, response) => { seen.push([request.method, request.url]);
    response.end('{"value":[{"id":"pre-existing"}]}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const ui = driver(); ui.base = `http://127.0.0.1:${server.address().port}`;
    ui.config.target = { role: 'owned-macos-lab' };
    await assert.rejects(ui.connect(ui.scenario), /existing_driver_session_unsettled/);
    assert.equal(ui.session, null); assert.notEqual(ui.sessionCreationUncertain, true);
    assert.deepEqual(seen, [['GET', '/appium/sessions']]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('cleanup retains native observers for stale, regressing or foreign stop proofs', async () => {
  for (const change of [native => { native.nativeRevision = 4; }, native => { native.workspaceId = admission.consentRecordId; },
    native => { native.browserTimeOriginMs -= 16000; }, native => { native.busy = true; }, () => {}]) {
    const ui = driver(); ui.scenario = { runId: 'cleanup-test', targetId: 'test-only', admissionBinding: admission };
    const native = { ...recording(), nativeRevision: 5, phase: 'sealed' }; change(native);
    ui.lastNativeRecording = { ...recording(), nativeRevision: 5 };
    let preserved;
    ui.desktop = { close: async ({ preserveForRecovery }) => { preserved = preserveForRecovery;
      return { ownedResourcesSettled: true }; } };
    ui.captureStateSnapshot = async () => ({ currentVisit: { ...admission, source: 'normal-native-mount-response' },
      nativeObservation: native, observerPendingReplies: 0 });
    const receipt = await ui.cleanup({ captureMayBeActive: true, captureProofAtOrAfterEpochMs: Date.now() });
    assert.equal(receipt.ownedResourcesSettled, true);
    assert.equal(preserved, native.nativeRevision < 5 || native.workspaceId !== admission.workspaceId || native.busy
      || Date.now() - native.browserTimeOriginMs > 15000);
  }
});
test('same-run retained iOS observers with different code cannot be silently reused', async () => {
  const ui = driver(); ui.config.admissionBinding = admission;
  ui.webview = async () => ({ ...admission, observerSHA256: '0'.repeat(64), pendingObservedReplies: 0 });
  await assert.rejects(ui.installObserver(), /admission_observer_binding_changed/);
  await assert.rejects(ui.installVisitObserver(), /visit_observer_binding_changed/);
});
test('recovery discovers live driver ownership and never touches an existing session', async () => {
  const output = await realpath(await mkdtemp(join(tmpdir(), 'scribe-recovery-context-')));
  const server = createServer((_request, response) => response.end(JSON.stringify({ value: [{ id: 'current-other-session' }] })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const ui = driver(); ui.base = `http://127.0.0.1:${server.address().port}`;
    await recoveryRun(ui, output);
    let connected = false; ui.connect = async () => { connected = true; };
    await assert.rejects(ui.recoveryInspect({ output, scenario: ui.scenario, state: { completed: [] }, observations: {}, signal: new AbortController().signal }), /recovery_existing_driver_session_unsettled/);
    assert.equal(connected, false); assert.equal(ui.session, null);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(output, { recursive: true, force: true }); }
});
test('recovery cannot infer old source cleanup from a new empty adapter', async () => {
  const output = await realpath(await mkdtemp(join(tmpdir(), 'scribe-recovery-context-')));
  const server = createServer((_request, response) => response.end(JSON.stringify({ value: [] })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const ui = driver(); ui.base = `http://127.0.0.1:${server.address().port}`;
    ui.scenario = { runId: 'recovery-unit', targetId: 'test-only', admissionBinding: admission };
    await recoveryRun(ui, output);
    ui.config.sources = {}; ui.connect = async (_scenario, options) => assert.equal(options.recoveryOnly, true);
    ui.webview = async () => ({ descriptor: { ...admission, observerSHA256: IOS_OBSERVER_HASHES.admission, pendingObservedReplies: 0 },
      visitDescriptor: { runId: admission.runId, observerSHA256: IOS_OBSERVER_HASHES.visit, pendingObservedReplies: 0 },
      currentVisit: admission, nativeObservation: recording(), currentNote: null });
    await assert.rejects(ui.recoveryInspect({ output, scenario: ui.scenario, state: { events: [], completed: ['prepare'], pending: null }, observations: {}, signal: new AbortController().signal }), error => error.code === 'ENOENT' && error.path === join(output, 'participants'));
    assert.equal(ui.sources, null);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(output, { recursive: true, force: true }); }
});
test('pre-Record recovery observes absent native callbacks without inventing stopped capture', async () => {
  const output = await realpath(await mkdtemp(join(tmpdir(), 'scribe-recovery-context-')));
  const server = createServer((_request, response) => response.end('{"value":[]}'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const ui = driver(); ui.base = `http://127.0.0.1:${server.address().port}`;
    ui.scenario = { runId: 'early-recovery', targetId: 'test-only', admissionBinding: admission };
    await recoveryRun(ui, output);
    ui.connect = async (_scenario, options) => { assert.equal(options.recoveryOnly, true); assert.equal(options.preRecordRecovery, true); };
    ui.webview = async () => ({ visitDescriptor: null, descriptor: null, currentVisit: null, nativeObservation: null, currentNote: null });
    const proof = await ui.recoveryInspect({ output, scenario: ui.scenario, state: { events: [], completed: [], pending: null },
      observations: {}, signal: new AbortController().signal });
    assert.equal(proof.recoveryStage, 'pre-record'); assert.equal(proof.nativeObservation, null);
    assert.deepEqual(proof.observers, { visit: null, admission: null, desktop: null });
    assert.equal(proof.observerPendingReplies, 0);
    await assert.rejects(ui.captureStateSnapshot(new AbortController().signal), /recovery_observer_missing_or_changed/);
    ui.webview = async () => { throw Error('transport_unavailable'); };
    await assert.rejects(ui.captureStateSnapshot(new AbortController().signal, { preRecord: true }), /transport_unavailable/);
    ui.webview = async () => ({ descriptor: null, currentVisit: null, nativeObservation: null, currentNote: null });
    await assert.rejects(ui.captureStateSnapshot(new AbortController().signal, { preRecord: true }), /recovery_observer_missing_or_changed/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(output, { recursive: true, force: true }); }
});
test('a Recording label cannot replace an actual bound native response', async () => {
  const ui = driver(); ui.webview = async () => null;
  await assert.rejects(ui.sourceObservation(), /native_recording_state_unavailable/);
  ui.webview = async () => ({ ...recording(), sessionId: '55555555-5555-4555-8555-555555555555' });
  await assert.rejects(ui.sourceObservation(), /native_recording_state_unavailable/);
  ui.webview = async () => ({ ...recording(), phase: 'paused' });
  await assert.rejects(ui.sourceObservation(), /recording_not_observed/);
  ui.webview = async () => ({ ...recording(), browserTimeOriginMs: Date.now() - 16000 });
  await assert.rejects(ui.sourceObservation(), /native_recording_state_unavailable/);
  ui.webview = async () => recording();
  assert.equal((await ui.sourceObservation()).capture.elapsedSeconds, 3);
});
test('a lower native revision cannot replace the cleanup observation baseline', async () => {
  const ui = driver(); ui.webview = async () => ({ ...recording(), nativeRevision: 5 });
  await ui.readRecording();
  ui.webview = async () => ({ ...recording(), nativeRevision: 4, phase: 'sealed' });
  await assert.rejects(ui.readRecording(), /native_recording_revision_regressed/);
  assert.equal(ui.lastNativeRecording.nativeRevision, 5);
  assert.equal(ui.lastNativeRecording.phase, 'recording');
});
test('a same-session replacement recorder cannot receive this journey Finish', async () => {
  const ui = driver(); ui.webview = async () => recording();
  await ui.readRecording();
  ui.webview = async () => ({ ...recording(), recorderId: admission.consentRecordId, nativeRevision: 9 });
  let clicked = false; ui.steps = async () => { clicked = true; };
  await assert.rejects(ui.perform('finish', ui.scenario, new AbortController().signal), /native_recorder_identity_changed/);
  assert.equal(clicked, false);
});

test('a transport-lost observer installation remains uncertain after session cleanup and cannot be overwritten by a later install', async () => {
  let installationArrived = false;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume owned test payload */ }
    if (request.url.endsWith('/execute/sync')) { installationArrived = true; request.socket.destroy(); }
    else response.end('{"value":null}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const ui = driver(); ui.base = `http://127.0.0.1:${server.address().port}`; ui.session = 'owned-test';
    await assert.rejects(ui.request('/execute/sync', 'POST', { script: 'test-only' }, undefined, { observerInstallation: true }));
    assert.equal(installationArrived, true); assert.equal(ui.observerInstallationUncertain, true);
    await assert.rejects(ui.request('/execute/sync', 'POST', {}, undefined, { observerInstallation: true }), /observer_installation_unsettled/);
    ui.cleanupIOSObservers = async () => ({ ownedResourcesSettled: true, observerRemoved: true });
    const result = await ui.cleanup();
    assert.equal(result.appiumSessionClosed, true); assert.equal(result.ownedResourcesSettled, false);
    assert.equal(result.observerInstallationUncertain, true);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('normal native identity is hashed and a wrong account blocks Create before any UI mutation', async () => {
  const ui = driver(); ui.scenario.admissionBinding = admission;
  ui.config.accountIdentitySHA256 = sha256('user_test_A');
  const auth = { source: 'normal-native-auth-response', runId: admission.runId, phase: 'ready',
    revision: admission.sessionId, userId: 'user_test_B', observedAtMonotonicMs: 1, browserTimeOriginMs: Date.now() - 1 };
  ui.webview = async () => auth; ui.installVisitObserver = async () => {};
  let clicked = false; ui.steps = async () => { clicked = true; };
  await assert.rejects(ui.perform('create_visit', ui.scenario), /native_account_identity_mismatch/);
  assert.equal(clicked, false);
  auth.userId = 'user_test_A';
  const proof = await ui.readAuth();
  assert.equal(proof.identitySHA256, ui.config.accountIdentitySHA256);
  assert.equal(JSON.stringify(proof).includes('user_test_A'), false);
  auth.browserTimeOriginMs -= 16000;
  await assert.rejects(ui.readAuth(), /native_auth_observation_invalid/);
});
test('a restored receipt cannot authorize Finish on a different mounted visit', async () => {
  const ui = driver(); ui.assertVisit = AppiumUI.prototype.assertVisit;
  ui.visitScope = async () => ({ ...admission, appointmentRef: 'appointment_01m5q8r3kzeng9szb5frh6ppk3' });
  let clicks = 0; ui.steps = async () => { clicks += 1; };
  await assert.rejects(ui.perform('finish', ui.scenario, new AbortController().signal), /current_visit_binding_changed/);
  await assert.rejects(ui.reconcile('save', ui.scenario), /current_visit_binding_changed/);
  assert.equal(clicks, 0);
});
test('mock source results cannot be relabeled as live UI observations', async () => {
  const ui = driver(); ui.config.sources = {};
  ui.sources = { participants: [{}], play: async () => ({ executionKind: 'mock' }) };
  await assert.rejects(ui.perform('play_source', ui.scenario, new AbortController().signal), /live_sources_required/);
});
test('Finish rejects a different recording session on the same visit before clicking', async () => {
  const ui = driver(); let clicks = 0;
  ui.webview = async () => ({ ...recording(), sessionId: '55555555-5555-4555-8555-555555555555' });
  ui.steps = async () => { clicks++; };
  await assert.rejects(ui.perform('finish', ui.scenario), /native_recording_state_unavailable/);
  assert.equal(clicks, 0);
  ui.webview = async () => ({ ...recording(), phase: 'sealed' });
  await assert.rejects(ui.perform('finish', ui.scenario), /bound_recording_not_finishable/);
  assert.equal(clicks, 0);
});
test('Finish observation requires actual same-session physical stop, even when UI assertions pass', async () => {
  const ui = driver(); ui.config.journey = { finish: {} }; ui.check = async () => [];
  ui.webview = async () => recording(); await ui.readRecording();
  ui.webview = async () => ({ ...recording(), phase: 'paused' });
  await assert.rejects(ui.observe('finish'), /bound_terminal_state_not_observed/);
  ui.webview = async () => ({ ...recording(), phase: 'sealed', browserTimeOriginMs: Date.now() - 120000 });
  assert.equal((await ui.observe('finish')).nativeTerminal.sessionId, admission.sessionId);
  ui.webview = async () => ({ ...recording(), phase: 'sealed', sessionId: '55555555-5555-4555-8555-555555555555' });
  await assert.rejects(ui.observe('finish'), /bound_terminal_state_not_observed/);
});
test('same-visit foreign note is rejected before any Save or edit mutation', async () => {
  const ui = driver(); let edits = 0;
  ui.steps = async () => { edits++; };
  ui.webview = async () => ({ source: 'normal-core-note-response', ...admission,
    session_id: '55555555-5555-4555-8555-555555555555', note_sha256: 'a'.repeat(64) });
  await assert.rejects(ui.perform('save', ui.scenario), /bound_note_response_not_observed/);
  assert.equal(edits, 0);
});
test('cleanup retains uncertainty for an unknown session or an unclosed source', async () => {
  const lost = driver(); lost.sessionCreationUncertain = true;
  assert.equal((await lost.cleanup()).ownedResourcesSettled, false);
  const source = driver(); source.sources = { cleanup: async () => ({ ownedResourcesSettled: false }) };
  assert.equal((await source.cleanup()).ownedResourcesSettled, false);
});
test('cleanup drains a late created session and prevents subsequent WebDriver calls', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push([request.method, request.url]); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"value":null}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const ui = driver(); ui.base = `http://127.0.0.1:${server.address().port}`;
    ui.sessionCreationUncertain = true;
    const late = ui.track(async () => { await new Promise(resolve => setTimeout(resolve, 20)); ui.session = 'owned-test-session'; ui.sessionCreationUncertain = false; });
    const cleanup = await ui.cleanup(); await late;
    assert.equal(cleanup.ownedResourcesSettled, true);
    assert.deepEqual(requests, [['DELETE', '/session/owned-test-session']]);
    await assert.rejects(ui.request('/element', 'POST', {}));
    assert.equal(requests.length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('a transport-lost native click retains quarantine even after successful session deletion', async () => {
  let seen, executed = false;
  const arrived = new Promise(resolve => { seen = resolve; });
  const server = createServer((request, response) => {
    if (request.method === 'POST') { seen(); setTimeout(() => { executed = true; response.end('{"value":null}'); }, 40); }
    else response.end('{"value":null}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const ui = driver(); ui.base = `http://127.0.0.1:${server.address().port}`; ui.session = 'owned';
    const cancel = new AbortController();
    const command = ui.request('/element/finish/click', 'POST', {}, cancel.signal);
    const rejected = assert.rejects(command);
    await arrived; cancel.abort(); await rejected;
    const receipt = await ui.cleanup();
    assert.equal(receipt.appiumSessionClosed, true);
    assert.equal(receipt.uncertainNativeMutationCount, 1);
    assert.equal(receipt.ownedResourcesSettled, false);
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(executed, true);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('full iOS cleanup removes nested owned observers and permits a different subsequent run', async () => {
  const original = () => Promise.resolve(null), native = () => {};
  globalThis.window = { Capacitor: { nativePromise: original, fromNative: native } };
  installVisitScopeObserver({ runId: admission.runId, observerSHA256: IOS_OBSERVER_HASHES.visit });
  installAdmissionObserver(admission, null, IOS_OBSERVER_HASHES.admission);
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null; let value = null;
    if (request.url.endsWith('/contexts')) value = ['NATIVE_APP', 'WEBVIEW_owned'];
    else if (request.url.endsWith('/context') && request.method === 'GET') value = 'NATIVE_APP';
    else if (request.url.endsWith('/execute/sync')) value = new Function(body.script)(...body.args);
    response.end(JSON.stringify({ value }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const ui = driver(); ui.config.target = { role: 'owned-ios-simulator' }; ui.config.admissionBinding = admission;
    ui.base = `http://127.0.0.1:${server.address().port}`; ui.session = 'owned';
    const retained = await ui.cleanupIOSObservers(true); assert.equal(retained.observerRetainedForRecovery, true);
    assert.ok(window.__scribeLabVisitObserver);
    const receipt = await ui.cleanup(); assert.equal(receipt.ownedResourcesSettled, true);
    assert.equal(window.Capacitor.nativePromise, original); assert.equal(window.Capacitor.fromNative, native);
    installVisitScopeObserver({ runId: '55555555-5555-4555-8555-555555555555' });
    assert.equal(window.__scribeLabVisitObserver.uninstall().ownedResourcesSettled, true);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); delete globalThis.window; }
});

test('asynchronous hosted navigation waits for actual state before the next input mutation', async () => {
  const ui = new AppiumUI('/unused'), events = []; let polls = 0;
  ui.value = async () => ++polls >= 2;
  ui.find = async locator => { events.push(['find', locator.value, polls]); return 'input'; };
  ui.request = async (path, method, body) => { events.push([path, method, body]); };
  await ui.steps({ actions: [
    { action: 'wait', waitMs: 1000, assertions: [{ locator: { using: 'accessibility id', value: 'Email code' }, kind: 'visible', expected: true }] },
    { action: 'clear', locator: { using: 'accessibility id', value: 'Code' } },
    { action: 'type', locator: { using: 'accessibility id', value: 'Code' }, text: 'synthetic' },
  ] }, new AbortController().signal);
  assert.equal(events[0][2], 2);
  assert.deepEqual(events[1], ['/element/input/clear', 'POST', {}]);
  assert.deepEqual(events[3], ['/element/input/value', 'POST', { text: 'synthetic' }]);
});
test('failed or unbounded intermediate state waits never advance to an input mutation', async () => {
  const ui = new AppiumUI('/unused'); ui.value = async () => false;
  ui.find = async () => { throw Error('next mutation must not run'); };
  for (const waitMs of [1, 0, -1, Infinity, 120001]) {
    await assert.rejects(ui.steps({ actions: [
      { action: 'wait', waitMs, assertions: [{ locator: {}, kind: 'visible', expected: true }] },
      { action: 'click', locator: {} },
    ] }, new AbortController().signal), /native_(state_not_observed|wait_deadline_invalid)/);
  }
});

test('ambiguous or missing native controls cannot choose an arbitrary first match', async () => {
  const ui = new AppiumUI('/unused'), key = 'element-6066-11e4-a52e-4f735466cecf';
  const locator = { using: 'accessibility id', value: 'Open note' };
  for (const matches of [[], [{ [key]: 'first' }, { [key]: 'second' }], [{ other: 'unknown' }]]) {
    ui.request = async (path, method, body) => { assert.equal(path, '/elements'); assert.equal(method, 'POST'); assert.deepEqual(body, locator); return matches; };
    await assert.rejects(ui.steps({ actions: [{ action: 'click', locator }] }), /native_locator_ambiguous_or_missing/);
  }
  ui.request = async () => [{ [key]: 'unique' }]; assert.equal(await ui.find(locator), 'unique');
});
