import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJSON, sha256 } from './journal.mjs';
import { acquireGuard, releaseGuard } from './guard.mjs';
import { journalIdentity } from './tool-identity.mjs';
import { createSessionAttempt, recoverSessionCreations, sessionReturned, sessionClosed,
  sessionCapsMatch, normalizedSessionCaps, SESSION_ATTEMPT_CAPABILITY, RECOVERY_OPERATION_TIMEOUT_MS } from './session-attempt.mjs';

async function fixture({ create = true, base = 'http://127.0.0.1:9999' } = {}) {
  const output = await realpath(await mkdtemp(resolve(tmpdir(), 'scribe-session-attempt-')));
  const scenario = { runId: 'mock-session-creation', executionKind: 'mock' }, targetFingerprint = randomUUID();
  const identity = await journalIdentity(scenario), runIdentity = { runId: identity.runId,
    scenarioSHA256: identity.scenarioSHA256, implementationSHA256: identity.implementationSHA256, outputCanonical: output };
  await atomicJSON(resolve(output, 'run.json'), { identity, events: [] });
  const capabilities = { platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:noReset': true,
    'appium:autoLaunch': false, 'appium:forceAppLaunch': false, 'appium:shouldTerminateApp': false,
    'appium:udid': randomUUID(), 'appium:bundleId': 'mock.app' };
  const args = { output, scenario, base, capabilities, targetFingerprint };
  const handle = create ? await createSessionAttempt(args) : null;
  const locks = resolve(await realpath(tmpdir()), `scribe-virtual-lab-target-locks-${process.getuid()}`);
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const leasePath = resolve(locks, `${sha256(targetFingerprint)}.lock`);
  await atomicJSON(leasePath, { runIdentity, uncertain: true, pid: 2147483647, host: hostname(), token: randomUUID() });
  const guard = await acquireGuard(leasePath + '.acquiring', { runIdentity, attemptId: randomUUID(), pid: process.pid, host: hostname() });
  const authority = { leasePath, leaseSHA256: sha256(await readFile(leasePath)), guardOwnerPath: guard.ownerPath, guardOwnerSHA256: guard.ownerSHA256 };
  const calls = [], candidate = handle ? { id: randomUUID(), created: Date.now(), capabilities: handle.receipt.capabilities } : null;
  let active = candidate ? [candidate] : [];
  return { ...args, handle, candidate, authority, calls,
    inventory: async () => active, close: async id => { calls.push(id); active = []; return true; },
    signal: new AbortController().signal, setInventory: value => { active = value; },
    dead: async () => { const value = JSON.parse(await readFile(handle.path)); value.owner.pid = 2147483647; await atomicJSON(handle.path, value); },
    dispose: async () => { await releaseGuard(guard); await rm(leasePath, { force: true }); await rm(output, { recursive: true, force: true }); } };
}
test('generated capability and complete private receipt bind the exact journal before dispatch', async () => {
  const f = await fixture();
  try {
    assert.equal(f.handle.capabilities[SESSION_ATTEMPT_CAPABILITY], f.handle.receipt.attemptId);
    assert.equal(f.handle.receipt.runJournalSHA256, sha256(await readFile(resolve(f.output, 'run.json'))));
    assert.equal(f.handle.receipt.owner.pid, process.pid);
    assert.equal(RECOVERY_OPERATION_TIMEOUT_MS, 240000);
    await assert.rejects(createSessionAttempt(f), /session_creation_unsettled/);
    await sessionReturned(f.handle, f.candidate.id, f.candidate.capabilities);
    assert.equal(JSON.parse(await readFile(f.handle.path)).phase, 'returned');
    await assert.rejects(sessionClosed(f.handle, f.candidate.id, {}), /session_cleanup_unconfirmed/);
  } finally { await f.dispose(); }
});
test('only a unique freshly discovered nonce plus full retention and target caps may settle a dead creation owner', async () => {
  const f = await fixture();
  try {
    await f.dead(); const result = await recoverSessionCreations(f);
    assert.equal(result.recovered.length, 1); assert.deepEqual(f.calls, [f.candidate.id]);
    assert.equal(JSON.parse(await readFile(f.handle.path)).phase, 'closed');
    assert.deepEqual((await recoverSessionCreations(f)).recovered, []);
  } finally { await f.dispose(); }
});
test('absence, ambiguity, a live owner, changed journal/caps/lease and wrong nonce never issue a DELETE', async () => {
  for (const mutate of [
    async f => {},
    async f => { await f.dead(); f.setInventory([]); },
    async f => { await f.dead(); f.setInventory([f.candidate, { ...f.candidate, id: randomUUID() }]); },
    async f => { await f.dead(); f.candidate.capabilities = { ...f.candidate.capabilities, [SESSION_ATTEMPT_CAPABILITY]: randomUUID() }; },
    async f => { await f.dead(); f.candidate.capabilities = { ...f.candidate.capabilities, shouldTerminateApp: true }; },
    async f => { await f.dead(); f.candidate.capabilities = { ...f.candidate.capabilities, udid: randomUUID() }; },
    async f => { await f.dead(); const path = resolve(f.output, 'run.json'); const value = JSON.parse(await readFile(path)); value.events.push({ kind: 'action_started', action: 'record' }); await atomicJSON(path, value); },
    async f => { await f.dead(); await atomicJSON(f.authority.leasePath, {}); },
    async f => { await f.dead(); f.authority.guardOwnerSHA256 = '0'.repeat(64); },
  ]) {
    const f = await fixture();
    try { await mutate(f); await assert.rejects(recoverSessionCreations(f)); assert.deepEqual(f.calls, []); }
    finally { await f.dispose(); }
  }
});
test('failed deletion or continued discovery retains the unclosed ownership receipt', async () => {
  for (const failure of ['delete', 'inventory', 'changed-journal']) {
    const f = await fixture();
    try {
      await f.dead();
      f.close = async id => { f.calls.push(id);
        if (failure === 'changed-journal') { f.setInventory([]); const path = resolve(f.output, 'run.json');
          const value = JSON.parse(await readFile(path)); value.events.push({ kind: 'unexpected-change' }); await atomicJSON(path, value); }
        return failure !== 'delete'; };
      await assert.rejects(recoverSessionCreations(f), /close_unconfirmed|journal_changed/);
      assert.equal(JSON.parse(await readFile(f.handle.path)).phase, 'dispatched');
    } finally { await f.dispose(); }
  }
});
test('capability matching rejects alias collisions and never treats missing retention as safe', () => {
  assert.throws(() => normalizedSessionCaps({ noReset: true, 'appium:noReset': true }), /ambiguous/);
  assert.equal(sessionCapsMatch({}, {}), false);
  assert.equal(sessionCapsMatch({ noReset: true, shouldTerminateApp: false, 'scribe:creationAttempt': 'a' },
    { noReset: true, shouldTerminateApp: false, 'scribe:creationAttempt': 'b' }), false);
});
test('actual child crash after a mock HTTP dispatch leaves an invisible pending creation that is settled only after its nonce appears', { timeout: 30000 }, async () => {
  let posted, release, active = [];
  const dispatched = new Promise(resolve => { posted = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    if (request.method === 'POST') {
      const caps = normalizedSessionCaps(JSON.parse(raw).capabilities.alwaysMatch); posted(); await gate;
      active = [{ id: randomUUID(), created: Date.now(), capabilities: caps }];
      response.end(JSON.stringify({ value: { sessionId: active[0].id, capabilities: caps } }));
    } else if (request.method === 'DELETE') { active = []; response.end('{"value":null}'); }
    else response.end(JSON.stringify({ value: active }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const f = await fixture({ create: false, base: `http://127.0.0.1:${server.address().port}` });
  const module = fileURLToPath(new URL('./session-attempt.mjs', import.meta.url));
  const source = `import {createSessionAttempt} from ${JSON.stringify(module)};
    const args=JSON.parse(process.argv[1]); const attempt=await createSessionAttempt(args);
    await fetch(args.base+'/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({capabilities:{alwaysMatch:attempt.capabilities}})});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify({ output: f.output, scenario: f.scenario,
    capabilities: f.capabilities, targetFingerprint: f.targetFingerprint, base: f.base })], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.race([dispatched, new Promise((_, reject) => { child.once('exit', code => reject(Error(`child_exited_${code}`))); })]);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const inventory = async () => (await (await fetch(f.base + '/appium/sessions')).json()).value;
    const close = async id => (await fetch(f.base + '/session/' + id, { method: 'DELETE' })).ok;
    await assert.rejects(recoverSessionCreations({ ...f, inventory, close }), /still_unconfirmed/);
    release(); for (let i = 0; i < 100 && active.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const result = await recoverSessionCreations({ ...f, inventory, close });
    assert.equal(result.recovered.length, 1); assert.deepEqual(active, []);
    const files = await readdir(resolve(f.output, 'appium-session-attempts'));
    const receipt = JSON.parse(await readFile(resolve(f.output, 'appium-session-attempts', files[0])));
    assert.equal(receipt.owner.pid, child.pid); assert.equal(receipt.phase, 'closed');
  } finally { release(); child.kill('SIGKILL'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.dispose(); }
});
