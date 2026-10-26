import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppiumUI, IOS_OBSERVER_HASHES } from './appium-ui.mjs';
import { IOS_CONTEXT_ATTESTATION } from './ios-webview.mjs';

// This process mocks only the Darwin export's in-memory brand to exercise the
// post-action failure path on any host. No fixture ever yields qualified timing.
// The production module has no test injection switch or remote request here.
mock.module('./native-journal-export.mjs', { namedExports: { requireOwnedJournalExport: value => value } });
const { collectNativePerformanceAction } = await import('./native-performance.mjs');
const runId = '11111111-1111-4111-8111-111111111111';
const scope = { runId, workspaceId: '22222222-2222-4222-8222-222222222222',
  appointmentRef: 'appointment_01m5tq2ryvffgskvkba3v2peaq', sessionId: '33333333-3333-4333-8333-333333333333',
  recorderId: '44444444-4444-4444-8444-444444444444', authRevision: '55555555-5555-4555-8555-555555555555' };
const sample = { source: 'normal-native-timing-response', ...scope, requestId: '66666666-6666-4666-8666-666666666666',
  nativeRevision: 1, method: 'providerRecordingCommand', kind: 'read',
  sample: { version: 1, clock: 'dispatch-uptime-ns', monotonicNs: '1', captureAttempt: 0, droppedEvents: 0 },
  transport: { clock: 'performance-now-ms', sentAtMonotonicMs: 1, receivedAtMonotonicMs: 2, browserTimeOriginMs: 1000,
    roundTripMs: 1, browserTimestampPrecision: 'UNKNOWN', browserTimestampResolutionMs: null, totalUncertaintyMs: null,
    qualification: 'NOT_ESTABLISHED' } };

async function exercise({ failure = false, thrown, collision = false, initialPhase = 'ready' } = {}) {
  const output = await realpath(await mkdtemp(join(tmpdir(), 'scribe-performance-lifecycle-')));
  const evidencePath = join(output, `performance-record-${runId}.json`);
  let context = 'NATIVE_APP', clicks = 0, invoked = 0, exports = 0;
  const history = { source: 'passive-native-timing-history', ...scope, maximumSamples: 128,
    invalidSamples: 0, unavailableSamples: 0, discardedRevisionSamples: 0, evictedSamples: 0, samples: [sample] };
  const server = createServer(async (request, response) => {
    let body = ''; for await (const bytes of request) body += bytes;
    body = body ? JSON.parse(body) : null;
    const path = request.url.replace(/^\/session\/[^/]+/, ''); let value;
    if (path === '/context') { if (body) context = body.name; value = context; }
    else if (path === '/execute/sync' && body.script === 'mobile: getContexts')
      value = [{ id: 'NATIVE_APP' }, { id: 'WEBVIEW_1.1', bundleId: 'mock.app', url: 'capacitor://localhost' }];
    else if (path === '/execute/sync' && body.script === IOS_CONTEXT_ATTESTATION) value = true;
    else if (path === '/execute/sync' && body.script.includes('readRecording'))
      value = { source: 'normal-native-recording-response', ...scope, phase: initialPhase, busy: false,
        nativeRevision: 1, timingObservation: sample, observedAtMonotonicMs: 1, browserTimeOriginMs: Date.now() - 1 };
    else if (path === '/execute/sync' && body.script.includes('readTiming'))
      value = { descriptor: { ...scope, observerSHA256: IOS_OBSERVER_HASHES.admission }, history };
    else if (path === '/elements') value = [{ 'element-6066-11e4-a52e-4f735466cecf': 'owned' }];
    else if (path === '/element/owned/click') { clicks++; value = null; }
    else if (path === '/element/owned/displayed') value = true;
    else { response.writeHead(404); response.end('{}'); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const ui = new AppiumUI('/unused'), locator = { using: 'accessibility id', value: 'Synthetic Record' };
  const plan = { actions: [{ action: 'click', locator }], assertions: [{ kind: 'visible', locator, expected: true }], waitMs: 10 };
  ui.config = { target: { role: 'owned-ios-simulator' }, app: { bundleId: 'mock.app' }, journey: { record: plan } };
  ui.output = output; ui.base = `http://127.0.0.1:${server.address().port}`; ui.session = runId; ui.binding = scope;
  ui.admission = { source: 'normal-native-admission-response', ...scope, consentRecordId: runId,
    revision: scope.authRevision, requestId: runId, requestNonce: runId };
  const original = { raw: ui.rawRequest, check: ui.check, find: ui.find };
  const result = { origin: 'product-ui', executionKind: 'mock', targetId: 'fixture-only', checks: [] };
  let returned, caught = false, error;
  try {
    try {
      returned = await collectNativePerformanceAction({ ui, phase: 'record', evidencePath, signal: AbortSignal.timeout(5000),
        clock: { sample: async () => ({}), snapshot: () => ({ source: 'mock-clock', samples: [] }) },
        exportJournal: async () => { if (++exports > 1) throw Error('synthetic export failure'); return { source: 'mock-export' }; },
        invoke: async () => { invoked++; await ui.steps(plan); await ui.check(plan);
          if (collision) await writeFile(evidencePath, 'existing evidence', { flag: 'wx', mode: 0o600 });
          if (failure) throw thrown; return result; } });
    } catch (value) { caught = true; error = value; }
    assert.equal(ui.rawRequest, original.raw); assert.equal(ui.check, original.check); assert.equal(ui.find, original.find);
    assert.equal(ui.session, runId); assert.equal(ui.uncertainMutations.size, 0);
    let retained = null; try { retained = await readFile(evidencePath, 'utf8'); } catch (value) { if (value.code !== 'ENOENT') throw value; }
    return { returned, result, caught, error, retained, clicks, invoked, exports };
  } finally { ui.lifetime.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(output, { recursive: true, force: true }); }
}

test('post-action collection failure preserves the original result and private unqualified evidence without replay', async () => {
  const actual = await exercise(); assert.equal(actual.caught, false); assert.equal(actual.returned.result, actual.result);
  assert.equal(actual.returned.receipt.qualification, 'NOT_ESTABLISHED');
  assert.equal(JSON.parse(actual.retained).receipt.collectionStatus, 'EVIDENCE_INCOMPLETE');
  assert.equal(actual.clicks, 1); assert.equal(actual.invoked, 1);
});
test('the original rejection including undefined survives later export or retention failure', async () => {
  for (const thrown of [Error('original synthetic rejection'), undefined]) for (const collision of [false, true]) {
    const actual = await exercise({ failure: true, thrown, collision });
    assert.equal(actual.caught, true); assert.equal(actual.error, thrown); assert.equal(actual.clicks, 1);
    if (collision) assert.equal(actual.retained, 'existing evidence');
    else assert.equal(JSON.parse(actual.retained).receipt.collectionStatus, 'NORMAL_ACTION_FAILED');
  }
});
test('retention collision never overwrites evidence and fails after exactly one normal action', async () => {
  const actual = await exercise({ collision: true }); assert.equal(actual.caught, true);
  assert.match(actual.error.message, /evidence_not_retained/); assert.equal(actual.retained, 'existing evidence'); assert.equal(actual.clicks, 1);
});
test('already recording fails before action, clock or export instead of measuring a second start', async () => {
  const actual = await exercise({ initialPhase: 'recording' }); assert.equal(actual.caught, true);
  assert.match(actual.error.message, /initial_native_phase_unconfirmed/); assert.equal(actual.clicks, 0); assert.equal(actual.exports, 0);
});
