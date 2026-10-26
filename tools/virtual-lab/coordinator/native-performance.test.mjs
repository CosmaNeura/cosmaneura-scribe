import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { projectKernelClockSample, boundKernelClockWindow } from './kernel-clock.mjs';
import { analyzeNativePerformanceEvidence as analyze, bindNativePerformanceEvidence, observeUIActionCalls,
  collectNativePerformanceAction, retainNativePerformanceEvidence } from './native-performance.mjs';
import { mkdtemp, realpath, readFile, stat, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { AppiumUI } from './appium-ui.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const runId = 'f7cb7381-a86a-47cc-a4e5-9e7c9fd118a6';
const identity = { hostname: 'owned.example', hardwareSHA256: 'a'.repeat(64), bootSessionUUID: runId, pid: 123, parentPID: 124 };
const scope = { runId, workspaceId: 'e84c3940-85dd-4e3e-a40c-0d096a573495', appointmentRef: 'appointment_01m5tq2ryvffgskvkba3v2peaq',
  sessionId: 'b3fd4375-ae2a-4b44-9de3-7ac0a7688f38', recorderId: 'ad1ac669-e158-4e4b-b5dc-bf9916d0277b', authRevision: runId };
function clockSample(raw, sequence) {
  const sleep = 500000000n, nonce = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  return projectKernelClockSample({ expectedNonce: nonce, expectedRunId: runId, expectedIdentity: { ...identity },
    nodeVersion: '24.22.1', uvVersion: '1.52.1', nodeSentNs: String(raw + sleep - 4n), nodeReceivedNs: String(raw + sleep + 4n),
    reply: { schema: 1, source: 'owned-kernel-clock', runId, nonce, sequence, identity: { ...identity }, timebase: { numer: 1, denom: 1 },
      continuousBeforeTicks: String(raw + sleep - 3n), continuousAfterTicks: String(raw + sleep + 3n),
      absoluteBeforeTicks: String(raw - 2n), absoluteAfterTicks: String(raw + 2n), dispatchRawTicks: String(raw), dispatchUptimeNs: String(raw),
      audioBeforeSeconds: Number(raw - 2n) / 1e9, audioAfterSeconds: Number(raw + 2n) / 1e9,
      audioBeforeRoundTripTicks: String(raw - 2n), audioAfterRoundTripTicks: String(raw + 2n),
      apiResolutionNs: { uptimeRaw: '1', monotonicRaw: '1' } } });
}
function timing(nativeNs, captureAttempt, nativeRevision) {
  return { source: 'normal-native-timing-response', ...scope, requestId: `00000000-0000-4000-8000-${String(nativeRevision).padStart(12, '0')}`,
    nativeRevision, method: 'providerRecordingCommand', kind: 'read',
    sample: { version: 1, clock: 'dispatch-uptime-ns', monotonicNs: String(nativeNs), captureAttempt, droppedEvents: 0 },
    transport: { clock: 'performance-now-ms', sentAtMonotonicMs: Number(nativeNs) / 1e6, receivedAtMonotonicMs: Number(nativeNs) / 1e6 + 1,
      browserTimeOriginMs: 10000, roundTripMs: 1, browserTimestampPrecision: 'UNKNOWN', browserTimestampResolutionMs: null,
      totalUncertaintyMs: null, qualification: 'NOT_ESTABLISHED' } };
}
function fixture() {
  const first = timing(1400000000n, 0, 1), input = timing(2400000000n, 1, 2), last = timing(8000000000n, 1, 3);
  const history = samples => ({ source: 'passive-native-timing-history', ...scope, maximumSamples: 128, evictedSamples: 0,
    invalidSamples: 0, unavailableSamples: 0, discardedRevisionSamples: 0, samples });
  const entries = [['startRequested', 1600000000], ['sourceReadyReceived', 1700000000], ['firstInputBuffer', 2000000000],
    ['firstConvertedBuffer', 2050000000], ['readyAccepted', 2200000000], ['firstPacketPersistenceStarted', 6500000000],
    ['firstPacketPersistenceCompleted', 6520000000]].map(([event, value]) => ({ utc: '2026-10-26T04:00:00.000Z',
      event, clock: 'dispatch-uptime-ns', monotonic_ns: String(value), capture_attempt: 1, dropped_events: 0 }));
  const bytes = Buffer.from(JSON.stringify(entries));
  const before = { source: 'owned-ios-native-journal-export', status: 'MISSING', runId, targetId: 'owned-ios',
    process: { pid: 321, processStart: 'Mon Oct 26 02:49:25 2026', executablePath: '/owned/Scribe.app/App', uid: 501 },
    build: { sourceSHA: 'a'.repeat(40), bundleSHA256: 'b'.repeat(64) }, container: '/owned/container', path: '/owned/container/Library/Caches/scribe-capture-startup-v1.json',
    hostname: identity.hostname, hardwareSHA256: identity.hardwareSHA256, bootSessionUUID: identity.bootSessionUUID, bytes: null };
  return { phase: 'record', historyBefore: history([first]), historyAfter: history([first, input, last]), before,
    admission: { source: 'normal-native-admission-response', ...scope, consentRecordId: runId, revision: scope.authRevision, requestId: runId, requestNonce: runId },
    initialRecording: { source: 'normal-native-recording-response', phase: 'ready', busy: false, timingObservation: first },
    after: { ...before, status: 'READ', bytes, sha256: hash(bytes) },
    window: boundKernelClockWindow(clockSample(1000000000n, 1), clockSample(9000000000n, 2)),
    timeline: { source: 'normal-ui-adapter-action-observation', action: 'record', status: 'OBSERVED', configuredFinds: 1,
      commands: [{ kind: 'click', invokedNs: '2000000000', settledNs: '2600000000', status: 'FULFILLED' }],
      checks: [{ kind: 'ui-assertions', invokedNs: '2600000000', settledNs: '2800000000', status: 'FULFILLED' }] },
    observation: { origin: 'product-ui', executionKind: 'live', targetId: 'owned-ios', checks: [{ actual: true, expected: true }],
      nativeObservation: { source: 'normal-native-recording-response', ...scope, phase: 'recording', busy: false, nativeRevision: 2,
        timingObservation: input, capturedAudioFrames: 1024,
        signal: { version: 2, inputBuffers: 4, convertedBuffers: 4, inputMuted: false } } } };
}
function editJournal(value, edit) {
  const events = JSON.parse(value.after.bytes); edit(events); value.after.bytes = Buffer.from(JSON.stringify(events)); value.after.sha256 = hash(value.after.bytes);
}

test('consistent supplied evidence keeps the physical-touch/browser/whole-workflow qualifications separate', () => {
  const result = analyze(fixture());
  assert.equal(result.qualification, 'SUPPLIED_EVIDENCE_CONSISTENCY_ONLY');
  assert.equal(result.readinessBudgetResult, 'WITHIN_BOUND');
  const ready = result.measurements.find(value => value.event === 'readyAccepted');
  assert.equal(ready.nativeFromStartNs, '600000000');
  assert.equal(ready.commandToEvent.lowerNs, '699999996');
  assert.equal(ready.commandToEvent.upperNs, '700000004');
  assert.equal(result.commandRoundTripNs, '600000000');
  assert.equal(result.commandToUIAssertionsNs, '800000000');
  assert.equal(result.measurements.at(-1).commandToEvent.budgetResult, 'NOT_APPLICABLE');
  assert.equal(result.retention.wholeJournalCompleteness, 'UNKNOWN');
  assert.equal(result.browserPrecision, 'UNKNOWN');
  assert.equal(result.acousticArrival, 'NOT_MEASURED');
  assert.equal(result.fullWorkflowAcceptance, 'NOT_ESTABLISHED');
});
test('retained JSON cannot impersonate a live owned-process export', () => {
  assert.throws(() => bindNativePerformanceEvidence(fixture()), /export_unconfirmed/);
});
for (const [name, edit] of [
  ['changed process', v => { v.after.process = { ...v.after.process, pid: 999 }; }],
  ['changed app bytes', v => { v.after.build = { ...v.after.build, bundleSHA256: 'c'.repeat(64) }; }],
  ['foreign boot', v => { v.after.bootSessionUUID = '00000000-0000-4000-8000-000000000004'; }],
  ['foreign session', v => { v.historyAfter.samples.at(-1).sessionId = '00000000-0000-4000-8000-000000000004'; }],
  ['foreign consent admission revision', v => { v.admission.revision = '00000000-0000-4000-8000-000000000004'; }],
  ['counter skipped', v => { v.historyAfter.samples.at(-1).sample.captureAttempt = 2; }],
  ['discarded reply', v => { v.historyAfter.discardedRevisionSamples = 1; }],
  ['required observer anchor evicted', v => { v.historyAfter.samples.shift(); v.historyAfter.evictedSamples = 1; }],
  ['observer eviction counter regressed', v => { v.historyBefore.evictedSamples = 1; }],
  ['required native start evicted', v => editJournal(v, rows => rows.shift())],
  ['queue/budget drop', v => editJournal(v, rows => { rows.at(-1).dropped_events = 1; })],
  ['journal changed after export', v => { v.after.bytes[1] ^= 1; }],
  ['stale earlier process event', v => editJournal(v, rows => { rows[0].monotonic_ns = '1'; })],
  ['future journal event beyond normal sample', v => editJournal(v, rows => { rows.at(-1).monotonic_ns = '8500000000'; })],
  ['muted input', v => { v.observation.nativeObservation.signal.inputMuted = true; }],
  ['zero usable frames', v => { v.observation.nativeObservation.capturedAudioFrames = 0; }],
  ['native scope not confirmed', v => { v.observation.nativeObservation.timingObservation = timing(2400000000n, 2, 2); }],
  ['same request ID with different native sample', v => { v.observation.nativeObservation.timingObservation = timing(2400000001n, 1, 2); }],
  ['UI assertion failed', v => { v.observation.checks[0].actual = false; }],
  ['already recording before Record', v => { v.initialRecording.phase = 'recording'; }],
  ['unrelated configured click', v => { v.timeline.action = 'save'; }],
  ['unknown click target', v => { v.timeline.configuredFinds = 0; }],
  ['native readiness before first converted buffer', v => editJournal(v, rows => { rows[4].monotonic_ns = '2000000000'; })],
  ['action reply lost', v => { v.timeline.status = 'UNQUALIFIED'; }],
  ['late command outside calibration', v => { v.timeline.commands[0].settledNs = '10000000000'; }],
]) test(name + ' never qualifies', () => { const value = fixture(); edit(value); assert.throws(() => analyze(value)); });
test('Resume requires the same paused native owner and a new capture attempt', () => {
  const value = fixture(); value.phase = 'resume'; value.timeline.action = 'resume';
  assert.throws(() => analyze(value), /initial_native_phase/);
  value.initialRecording.phase = 'paused';
  assert.equal(analyze(value).readinessBudgetResult, 'WITHIN_BOUND');
});
test('optional missing first packet stays unobserved; no four-second packet budget is invented', () => {
  const value = fixture(); editJournal(value, rows => rows.splice(-2));
  const result = analyze(value);
  assert.equal(result.readinessBudgetResult, 'WITHIN_BOUND');
  assert.equal(result.measurements.at(-1).status, 'NOT_OBSERVED');
});
test('older observer eviction is explicit but does not erase a retained required interval', () => {
  const value = fixture(); value.historyBefore.evictedSamples = 20; value.historyAfter.evictedSamples = 22;
  const result = analyze(value); assert.equal(result.retention.requiredObserverAnchorRetained, true);
  assert.equal(result.retention.after, 22); assert.equal(result.retention.wholeJournalCompleteness, 'UNKNOWN');
});

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function uiFixture() {
  const plan = { actions: [{ action: 'click', locator: { using: 'id', value: 'record' } }], assertions: [] }, click = deferred(), check = deferred();
  const ui = { session: runId, config: { journey: { record: plan } }, rawRequest() { assert.equal(this, ui); return click.promise; },
    find() { assert.equal(this, ui); return Promise.resolve('owned'); }, check() { assert.equal(this, ui); return check.promise; } };
  return { ui, click, check, plan };
}
test('observer preserves exact original promises and dispatches no requests', async () => {
  const { ui, click, check, plan } = uiFixture(), original = ui.rawRequest, priorCheck = ui.check;
  const observer = observeUIActionCalls(ui, 'record');
  await ui.find(plan.actions[0].locator);
  assert.equal(ui.rawRequest('/element/owned/click', 'POST', {}), click.promise);
  assert.equal(ui.check(plan), check.promise);
  click.resolve(); check.resolve(); await Promise.all([click.promise, check.promise]);
  const receipt = observer.close(); assert.equal(receipt.status, 'OBSERVED'); assert.equal(receipt.commands.length, 1);
  assert.equal(ui.rawRequest, original); assert.equal(ui.check, priorCheck);
  assert.equal(JSON.stringify(receipt).includes('/element'), false);
});
test('late input reply after closure remains uncertain and cannot update retained evidence', async () => {
  const { ui, click } = uiFixture(), observer = observeUIActionCalls(ui, 'record');
  ui.rawRequest('/element/owned/click', 'POST', {});
  const before = observer.close(); click.resolve(); await click.promise;
  assert.equal(before.status, 'UNQUALIFIED'); assert.equal(observer.close().commands[0].status, 'PENDING');
});
test('unexpected typing, duplicate click and changed wrapper ownership never become timing proof', async () => {
  for (const mode of ['typing', 'duplicate', 'replacement', 'wrong-target', 'unresolved-target']) {
    const { ui, click, check, plan } = uiFixture(), observer = observeUIActionCalls(ui, 'record');
    if (mode !== 'unresolved-target') await ui.find(plan.actions[0].locator);
    ui.rawRequest(`/element/${mode === 'wrong-target' ? 'foreign' : 'owned'}/click`, 'POST', {}); ui.check(plan);
    if (mode === 'typing') ui.rawRequest('/element/owned/value', 'POST', { text: 'never retained' });
    if (mode === 'duplicate') ui.rawRequest('/element/other/click', 'POST', {});
    const foreign = () => Promise.resolve(); if (mode === 'replacement') ui.rawRequest = foreign;
    click.resolve(); check.resolve(); await Promise.all([click.promise, check.promise]);
    assert.equal(observer.close().status, 'UNQUALIFIED');
    if (mode === 'replacement') assert.equal(ui.rawRequest, foreign);
  }
});
test('original rejected request is neither swallowed nor replaced', async () => {
  const { ui, click } = uiFixture(), observer = observeUIActionCalls(ui, 'record');
  const originalError = Error('synthetic failure'), promise = ui.rawRequest('/element/owned/click', 'POST', {});
  click.reject(originalError); await assert.rejects(promise, error => error === originalError);
  assert.equal(observer.close().commands[0].status, 'REJECTED');
});

test('live collector rejects mock/replaced adapters and aborted calls before invoking any action', async () => {
  let invoked = 0;
  const args = { ui: uiFixture().ui, phase: 'record', invoke: () => { invoked++; }, exportJournal() {} };
  await assert.rejects(collectNativePerformanceAction(args), /normal_adapter_required/);
  await assert.rejects(collectNativePerformanceAction({ ...args, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(invoked, 0);
});

test('retention is private, exclusive and size-bounded; a failure cannot replace prior evidence', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scribe-performance-evidence-')));
  const path = join(root, `performance-record-${runId}.json`), evidence = { status: 'NOT_ESTABLISHED' };
  try {
    const receipt = await retainNativePerformanceEvidence(path, root, evidence);
    const bytes = await readFile(path);
    assert.equal(receipt.sha256, hash(bytes)); assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(retainNativePerformanceEvidence(path, root, { changed: true }), /EEXIST/);
    assert.deepEqual(await readFile(path), bytes);
    await assert.rejects(retainNativePerformanceEvidence(join(root, 'arbitrary.json'), root, evidence), /path_unconfirmed/);
    await assert.rejects(retainNativePerformanceEvidence(join(root, `performance-resume-${runId}.json`), root, { data: 'x'.repeat(1048576) }), /too_large/);
    await chmod(root, 0o755);
    await assert.rejects(retainNativePerformanceEvidence(path, root, evidence), /not_private/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function httpDriver(testBody) {
  const requests = [];
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Payload is synthetic and not retained. */ }
    const path = request.url.replace(/^\/session\/[^/]+/, ''); requests.push({ method: request.method, path });
    let value;
    if (path === '/context') value = 'NATIVE_APP';
    else if (path === '/elements') value = [{ 'element-6066-11e4-a52e-4f735466cecf': 'configured-control' }];
    else if (path === '/element/configured-control/displayed') value = true;
    else if (path.endsWith('/click')) {
      if (server.rejectClick) { response.writeHead(500); response.end(JSON.stringify({ value: { error: 'synthetic' } })); return; }
      value = null;
    } else { response.writeHead(404); response.end('{}'); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const ui = new AppiumUI('/unused'); ui.base = `http://127.0.0.1:${server.address().port}`; ui.session = runId;
  const locator = { using: 'accessibility id', value: 'Synthetic Record' };
  const plan = { actions: [{ action: 'click', locator }], assertions: [{ kind: 'visible', locator, expected: true }], waitMs: 10 };
  ui.config = { target: { role: 'owned-ios-simulator' }, journey: { record: plan } };
  try { await testBody({ ui, plan, requests, server }); }
  finally { ui.lifetime.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('actual loopback WebDriver transport binds the configured resolution/click/check without extra requests', async () => {
  await httpDriver(async ({ ui, plan, requests }) => {
    const request = ui.rawRequest, find = ui.find, check = ui.check;
    const observed = observeUIActionCalls(ui, 'record');
    await ui.steps(plan); await ui.check(plan);
    const receipt = observed.close(); assert.equal(receipt.status, 'OBSERVED');
    assert.equal(receipt.configuredFinds, 1); assert.equal(receipt.commands.length, 1);
    assert.equal(receipt.commands[0].kind, 'click'); assert.equal(ui.rawRequest, request); assert.equal(ui.find, find); assert.equal(ui.check, check);
    assert.deepEqual(requests.filter(row => row.method === 'POST').map(row => row.path), ['/elements', '/element/configured-control/click', '/elements']);
    assert.equal(ui.uncertainMutations.size, 0);
  });
});

test('actual failed HTTP click remains uncertain and observer cleanup does not clear native ownership guards', async () => {
  await httpDriver(async ({ ui, plan, server, requests }) => {
    server.rejectClick = true;
    const observed = observeUIActionCalls(ui, 'record');
    await assert.rejects(ui.steps(plan), /webdriver_request_failed/);
    assert.equal(observed.close().status, 'UNQUALIFIED'); assert.equal(ui.uncertainMutations.size, 1);
    assert.equal(ui.session, runId); assert.equal(requests.filter(row => row.path.endsWith('/click')).length, 1);
  });
});
