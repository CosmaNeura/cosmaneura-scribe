import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, realpath, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppiumUI } from './appium-ui.mjs';

// Mock only the in-memory ownership brand, never add a production bypass.
// Actual adapter commands use an owned loopback HTTP server. These fixtures
// deliberately cannot produce qualified timing or a product acceptance claim.
mock.module('./desktop-observer.mjs', { namedExports: { isOwnedDesktopObserver: () => true } });
const { collectDesktopRecordPerformance, observeDesktopPhase } = await import('./desktop-performance.mjs');
const runId = '11111111-1111-4111-8111-111111111111';
async function exercise({ failure = false, thrown, collision = false, abort = false } = {}) {
  const output = await realpath(await mkdtemp(join(tmpdir(), 'scribe-desktop-performance-')));
  const evidencePath = join(output, `performance-record-${runId}.json`);
  let clicks = 0, invoked = 0, reads = 0, pendingReads = 0;
  const server = createServer(async (request, response) => {
    for await (const bytes of request) void bytes;
    const route = request.url.replace(/^\/session\/[^/]+/, ''); let value;
    if (route === '/elements') value = [{ 'element-6066-11e4-a52e-4f735466cecf': 'owned' }];
    else if (route === '/element/owned/click') { clicks++; value = null; }
    else if (route === '/element/owned/displayed') value = true;
    else { response.writeHead(404); response.end('{}'); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const ui = new AppiumUI('/unused'), controller = new AbortController();
  const locator = { using: 'accessibility id', value: 'Synthetic Record' };
  const plan = { actions: [{ action: 'click', locator }], assertions: [{ kind: 'visible', locator, expected: true }], waitMs: 10 };
  ui.config = { target: { role: 'owned-macos-lab', hostname: hostname() }, journey: { record: plan }, accountIdentitySHA256: 'a'.repeat(64) };
  ui.output = output; ui.base = `http://127.0.0.1:${server.address().port}`; ui.session = runId;
  ui.scenario = { admissionBinding: { runId }, targetId: 'synthetic-loopback' };
  const scope = { runId, workspaceId: runId, appointmentRef: 'appointment_01m5tq2ryvffgskvkba3v2peaq', sessionId: runId, revision: runId };
  ui.admission = { ...scope, source: 'normal-native-admission-response', consentRecordId: runId };
  ui.desktop = { identity: { pid: process.pid, executablePath: process.execPath, appPath: '/synthetic' }, async readPerformance() {
    reads++;
    if (reads > 1) {
      pendingReads++;
      try { await delay(100); throw Error('synthetic delayed read failure'); } finally { pendingReads--; }
    }
    return { source: 'owned-desktop-performance-snapshot', runId, ...ui.desktop.identity, hostname: hostname(), profile: output,
      mainMonotonicNs: process.hrtime.bigint().toString(), pendingObservedReplies: 0, admission: structuredClone(ui.admission),
      auth: { source: 'normal-desktop-auth-response', runId, phase: 'ready', revision: runId,
        identitySHA256: ui.config.accountIdentitySHA256, browserTimeOriginMs: Date.now(), observedAtMonotonicMs: 0 },
      recording: { ...scope, source: 'normal-desktop-recording-response', recorderId: runId, nativeRevision: 1,
        phase: 'ready', captureState: 'ready', pendingMutation: false, elapsedSeconds: 0, recordedChunks: 0, queuedChunks: 0 },
      diagnostics: { file: 'runtime-diagnostics-v1.jsonl', events: [] } };
  } };
  const original = { raw: ui.rawRequest, check: ui.check, find: ui.find };
  const result = { origin: 'product-ui', executionKind: 'mock', targetId: 'synthetic-loopback', checks: [] };
  let returned, caught = false, error;
  try {
    try {
      returned = await collectDesktopRecordPerformance({ ui, profileDirectory: output, evidencePath, signal: controller.signal,
        invoke: async () => {
          invoked++; await ui.steps(plan); await ui.check(plan);
          while (!pendingReads) await delay(5);
          if (collision) await writeFile(evidencePath, 'existing', { flag: 'wx', mode: 0o600 });
          if (abort) controller.abort(Error('synthetic caller abort'));
          if (failure) throw thrown;
          return result;
        } });
    } catch (value) { caught = true; error = value; }
    assert.equal(pendingReads, 0); // Every launched read settled before return.
    assert.equal(ui.rawRequest, original.raw); assert.equal(ui.check, original.check); assert.equal(ui.find, original.find);
    const retained = await readFile(evidencePath, 'utf8');
    return { returned, result, caught, error, retained, clicks, invoked, reads };
  } finally {
    ui.lifetime.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(output, { recursive: true, force: true });
  }
}
test('collection failure waits for its delayed reader and preserves the original action result without replay', async () => {
  const r = await exercise(); assert.equal(r.caught, false); assert.equal(r.returned, r.result);
  assert.equal(r.clicks, 1); assert.equal(r.invoked, 1); assert.equal(r.reads, 2);
  assert.equal(JSON.parse(r.retained).status, 'UNQUALIFIED');
});
test('original rejection, including undefined, survives delayed collection and retention failure', async () => {
  for (const thrown of [Error('synthetic original'), undefined]) for (const collision of [false, true]) {
    const r = await exercise({ failure: true, thrown, collision });
    assert.equal(r.caught, true); assert.equal(r.error, thrown); assert.equal(r.clicks, 1);
    if (collision) assert.equal(r.retained, 'existing');
  }
});
test('caller abort does not leave a reader or qualify an otherwise returned action', async () => {
  const r = await exercise({ abort: true }); assert.equal(r.clicks, 1); assert.equal(r.reads, 2);
  assert.equal(JSON.parse(r.retained).status, 'UNQUALIFIED');
});
test('exclusive evidence collision preserves old bytes and fails after the single action', async () => {
  const r = await exercise({ collision: true }); assert.equal(r.caught, true);
  assert.equal(r.retained, 'existing'); assert.equal(r.clicks, 1);
});
test('normal phase timing preserves full interval and original result or undefined rejection without copying content', async () => {
  const output = await realpath(await mkdtemp(join(tmpdir(), 'scribe-desktop-phase-'))), ui = new AppiumUI('/unused');
  try {
    const original = { sensitive: 'not retained' }; let calls = 0, caught = false;
    assert.equal(await observeDesktopPhase({ ui, phase: 'prepare', output, invoke: async () => { calls++; await delay(5); return original; } }), original);
    try { await observeDesktopPhase({ ui, phase: 'consent', output, invoke: async () => { calls++; throw undefined; } }); }
    catch (error) { caught = true; assert.equal(error, undefined); }
    assert.equal(caught, true); assert.equal(calls, 2);
    const files = await readdir(output); assert.equal(files.length, 2);
    for (const file of files) { const raw = await readFile(join(output, file), 'utf8'), r = JSON.parse(raw);
      assert.ok(!raw.includes('not retained')); assert.equal(r.authority, 'NONE'); assert.ok(BigInt(r.settledNs) >= BigInt(r.invokedNs)); }
  } finally { ui.lifetime.abort(); await rm(output, { recursive: true, force: true }); }
});
