import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { AppiumUI, IOS_STARTUP_READINESS_MS } from './appium-ui.mjs';
import { runJourney } from './engine.mjs';
import { IOS_CONTEXT_DISCOVERY, IOS_CONTEXT_ATTESTATION, IOS_CONTEXT_READINESS_MS } from './ios-webview.mjs';
import { sha256 } from './journal.mjs';

const bundleId = 'test.scribe';
const contexts = () => [{ id: 'NATIVE_APP' },
  { id: 'WEBVIEW_123.1', bundleId, url: 'capacitor://localhost' }];

async function fixture(t, { firstRead, attest = true } = {}) {
  const output = await mkdtemp(join(tmpdir(), 'scribe-ios-startup-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const scenario = { schema: 1, syntheticOnly: true, runId: 'startup-test', mode: 'fixed', executionKind: 'mock',
    targetId: `owned-startup-${randomUUID()}`, sourceSHA: 'a'.repeat(40),
    build: { bundleId, number: '1', sha256: 'b'.repeat(64) }, fixture: { sha256: 'c'.repeat(64) },
    personas: [{ id: 'a', profile: 'a' }, { id: 'b', profile: 'b' }] };
  const ui = new AppiumUI('/unused'), events = [];
  ui.config = { target: { role: 'owned-ios-simulator' }, app: { bundleId }, admissionBinding: { runId: randomUUID() } };
  ui.scenario = scenario; ui.output = output; ui.session = randomUUID();
  let context = 'NATIVE_APP', reads = 0;
  ui.rawRequest = async (path, method = 'GET', body, signal) => {
    if (path === '/context' && method === 'GET') return context;
    if (body?.script === IOS_CONTEXT_DISCOVERY.script) {
      events.push('discover'); return ++reads === 1 && firstRead ? firstRead(signal) : contexts();
    }
    if (path === '/context') { context = body.name; events.push(context); return null; }
    if (body?.script === IOS_CONTEXT_ATTESTATION) { events.push('attest'); return attest; }
    if (body?.script.includes('?.describe()')) { events.push('describe'); return null; }
    events.push('install'); return null;
  };
  ui.lockIdentity = async () => scenario.targetId;
  ui.doctor = async () => ({ ready: true, targetId: scenario.targetId, executionKind: 'mock' });
  ui.connect = async () => { events.push('connect'); };
  ui.restore = async () => { events.push('restore'); };
  ui.steps = async () => { events.push('input'); };
  ui.observe = async action => ({ action, origin: 'product-ui', executionKind: 'mock', targetId: scenario.targetId,
    observedAtEpochMs: Date.now(), checks: [{ locator: 'test-only', kind: 'visible', actual: true, expected: true }] });
  ui.cleanup = async () => ({ ownedResourcesSettled: true });
  ui.failureArtifact = async () => {};
  return { ui, output, scenario, events, context: () => context,
    run: () => runJourney({ scenario, adapter: ui, output, labRoot: output, stopAfter: 'sign_in' }) };
}

test('a cold inspector read longer than 1500ms completes setup before any sign-in input', async t => {
  const f = await fixture(t, { firstRead: async signal => {
    await delay(1700, undefined, { signal }); return contexts();
  } });
  assert.equal((await f.run()).status, 'PAUSED');
  assert.ok(f.events.indexOf('attest') < f.events.indexOf('install'));
  assert.ok(f.events.indexOf('install') < f.events.indexOf('input'));
  const journal = JSON.parse(await readFile(join(f.output, 'run.json')));
  const readiness = journal.events.find(event => event.kind === 'initial_ui_readiness');
  assert.ok(readiness);
  assert.ok(journal.events.indexOf(readiness) < journal.events.findIndex(event => event.kind === 'action_started'));
  const files = (await readdir(f.output)).filter(name => name.startsWith('ios-webview-startup.'));
  assert.equal(files.length, 1);
  const receipt = JSON.parse(await readFile(join(f.output, files[0])));
  assert.equal(readiness.evidenceSHA256, sha256(JSON.stringify(receipt)));
  assert.equal(receipt.status, 'READY'); assert.equal(receipt.qualification, 'NOT_ESTABLISHED');
  assert.ok(receipt.elapsedMs >= 1700); assert.equal(receipt.contextRestored, true);
  assert.equal(f.context(), 'NATIVE_APP');
});

async function receipt(f) {
  const files = (await readdir(f.output)).filter(name => name.startsWith('ios-webview-startup.'));
  assert.equal(files.length, 1);
  return JSON.parse(await readFile(join(f.output, files[0])));
}
const setup = f => f.ui.prepareInitialUI(f.scenario, { output: f.output });

test('native-only setup is bounded, recorded and followed by independent fresh ownership checks', async t => {
  const f = await fixture(t, { firstRead: async () => [{ id: 'NATIVE_APP' }] });
  await setup(f);
  assert.equal((await receipt(f)).nativeOnlyReplies, 1);
  assert.equal((await receipt(f)).readCount, 2);
  assert.ok(!f.events.includes('describe')); assert.ok(!f.events.includes('install')); assert.ok(!f.events.includes('input'));
  const original = f.ui.rawRequest;
  f.ui.rawRequest = (path, method, body, ...rest) => body?.script === IOS_CONTEXT_DISCOVERY.script
    ? Promise.resolve([{ id: 'NATIVE_APP' }, { ...contexts()[1], bundleId: 'foreign.app' }])
    : original(path, method, body, ...rest);
  await assert.rejects(f.ui.webview('return observer.read()'), /owned_webview_ambiguous/);
  assert.ok(!f.events.includes('install'));
  assert.throws(() => setup(f), /ios_startup_scope_invalid/);
});

test('startup does not relax malformed, foreign, duplicate or post-switch identity refusals', async t => {
  for (const rows of [null, [], [{ id: 'NATIVE_APP', title: null }],
    [{ id: 'NATIVE_APP' }, { ...contexts()[1], bundleId: 'foreign.app' }],
    [{ id: 'NATIVE_APP' }, { ...contexts()[1], url: 'capacitor://localhost/?code=never-log' }],
    [...contexts(), { ...contexts()[1], id: 'WEBVIEW_123.2' }]]) {
    const f = await fixture(t, { firstRead: async () => rows });
    await assert.rejects(f.run(), /owned_webview_ambiguous/);
    assert.equal((await receipt(f)).readCount, 1);
    assert.equal(f.events.includes('input'), false); assert.equal(f.events.includes('install'), false);
    assert.equal(JSON.parse(await readFile(join(f.output, 'run.json'))).pending, null);
    assert.equal(JSON.stringify(await receipt(f)).includes('never-log'), false);
  }
  const f = await fixture(t, { attest: false });
  await assert.rejects(f.run(), /owned_webview_identity_changed/);
  assert.equal(f.context(), 'NATIVE_APP'); assert.equal(f.events.includes('input'), false);
  assert.equal((await receipt(f)).status, 'FAILED');
});

test('caller cancellation never accepts a late owned result or retries the startup attempt', async t => {
  let release, entered;
  const called = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { firstRead: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const controller = new AbortController();
  const pending = f.ui.prepareInitialUI(f.scenario, { output: f.output, signal: controller.signal });
  await called; controller.abort(Error('caller_cancelled'));
  release(contexts());
  await assert.rejects(pending, /caller_cancelled/);
  assert.equal((await receipt(f)).failure, 'caller_aborted');
  assert.equal(f.events.includes('attest'), false); assert.equal(f.events.includes('input'), false);
  assert.throws(() => setup(f), /ios_startup_scope_invalid/);
});

test('failed native-context restoration cannot report successful startup', async t => {
  const f = await fixture(t), original = f.ui.rawRequest;
  f.ui.rawRequest = async (path, method, body, ...rest) => {
    if (path === '/context' && body?.name === 'NATIVE_APP') throw Error('restore_lost');
    return original(path, method, body, ...rest);
  };
  await assert.rejects(setup(f), /restore_lost/);
  const observed = await receipt(f);
  assert.equal(observed.status, 'FAILED'); assert.equal(observed.contextRestored, false);
  assert.equal(f.ui.contextUncertain, true); assert.equal(f.events.includes('input'), false);
});

test('a warm bootstrap never widens the subsequent 1500ms proof discovery window', async t => {
  const f = await fixture(t); await setup(f);
  const original = f.ui.rawRequest;
  f.ui.rawRequest = async (path, method, body, signal, ...rest) => {
    if (body?.script === IOS_CONTEXT_DISCOVERY.script) {
      await delay(1700, undefined, { signal }); return contexts();
    }
    return original(path, method, body, signal, ...rest);
  };
  assert.equal(IOS_CONTEXT_READINESS_MS, 1500);
  const start = performance.now();
  await assert.rejects(f.ui.webview('return observer.read()', [], AbortSignal.timeout(2000)), /owned_webview_not_ready/);
  assert.ok(performance.now() - start >= 1450);
  assert.equal(f.events.includes('install'), false);
});

test('Mac2 setup remains unchanged and startup cannot run over an existing admission', async t => {
  const f = await fixture(t); f.ui.config.target.role = 'owned-macos-lab';
  assert.equal(setup(f), null); assert.deepEqual(f.events, []); assert.deepEqual(await readdir(f.output), []);
  f.ui.config.target.role = 'owned-ios-simulator'; f.ui.admission = { sessionId: randomUUID() };
  assert.throws(() => setup(f), /ios_startup_scope_invalid/);
});

test('the 30s setup limit aborts a slow transport with no observer or input effects', async t => {
  const f = await fixture(t, { firstRead: async signal => {
    await delay(60000, undefined, { signal }); return contexts();
  } });
  assert.equal(IOS_STARTUP_READINESS_MS, 30000);
  await assert.rejects(setup(f), /ios_webview_startup_timeout/);
  const observed = await receipt(f);
  assert.equal(observed.failure, 'ios_webview_startup_timeout'); assert.equal(observed.readCount, 1);
  assert.ok(observed.elapsedMs >= 29950); assert.equal(observed.qualification, 'NOT_ESTABLISHED');
  assert.equal(f.events.includes('input'), false); assert.equal(f.events.includes('install'), false);
});

test('actual loopback transport performs setup then fresh observer discovery before sign-in', async t => {
  const f = await fixture(t); let current = 'NATIVE_APP', reads = 0, installed = false;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = raw ? JSON.parse(raw) : null; let value = null;
    if (request.url.endsWith('/context') && request.method === 'GET') value = current;
    else if (request.url.endsWith('/context')) current = body.name;
    else if (body?.script === IOS_CONTEXT_DISCOVERY.script) {
      if (++reads === 1) await delay(1700);
      value = contexts();
    } else if (body?.script === IOS_CONTEXT_ATTESTATION) value = current === 'WEBVIEW_123.1';
    else if (!body?.script.includes('?.describe()')) { installed = true; }
    response.end(JSON.stringify({ value }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    f.ui.base = `http://127.0.0.1:${server.address().port}`;
    f.ui.rawRequest = AppiumUI.prototype.rawRequest;
    f.ui.steps = async () => { assert.equal(installed, true); assert.equal(current, 'NATIVE_APP'); f.events.push('input'); };
    await f.run();
    assert.equal(reads, 3); assert.equal((await receipt(f)).readCount, 1);
    assert.equal(f.events.filter(event => event === 'input').length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
