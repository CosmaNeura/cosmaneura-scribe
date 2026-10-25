import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIONS, Journal, atomicJSON, sha256 } from './journal.mjs';
import { loadAccountMatrix, runAccountMatrix, validateNativeAccountObservations } from './matrix.mjs';
import { journalIdentity } from './tool-identity.mjs';

const save = (path, value) => writeFile(path, JSON.stringify(value));
test('native account identity must match all normal pre-visit stages, independently of dashboard identity', () => {
  const runId = '11111111-1111-4111-8111-111111111111', identity = 'a'.repeat(64), at = Date.now();
  const scenario = { admissionBinding: { runId } };
  const observations = Object.fromEntries(['sign_in', 'workspace', 'create_visit'].map(action => [action, {
    observedAtEpochMs: at, nativeAuth: { source: 'normal-native-auth-response', runId, phase: 'ready', revision: runId,
      identitySHA256: identity, browserTimeOriginMs: at - 1, observedAtMonotonicMs: 1 } }]));
  validateNativeAccountObservations(observations, scenario, identity);
  for (const action of Object.keys(observations)) for (const patch of [{ identitySHA256: 'b'.repeat(64) }, { source: 'label-only' },
    { runId: '22222222-2222-4222-8222-222222222222' }, { observedAtMonotonicMs: -16000 }, { phase: 'signedOut' }]) {
    const changed = structuredClone(observations); Object.assign(changed[action].nativeAuth, patch);
    assert.throws(() => validateNativeAccountObservations(changed, scenario, identity), /account_native_identity_unconfirmed/);
  }
  const missing = structuredClone(observations); delete missing.workspace.nativeAuth;
  assert.throws(() => validateNativeAccountObservations(missing, scenario, identity), /account_native_identity_unconfirmed/);
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'scribe-matrix-')), accounts = [];
  for (const [index, id] of ['a', 'b'].entries()) {
    const storageState = join(root, `${id}.storage.json`); await save(storageState, { cookies: [], origins: [], syntheticAccount: id });
    const dashboard = { syntheticOnly: true, apiOrigin: 'https://staging-api.cosmaneura.com', playwrightPath: '/unused',
      storageState, storageStateSHA256: sha256(await readFile(storageState)), identitySHA256: id.repeat(64), expectedVisiblePhrases: ['Synthetic edit'] };
    const binding = { runId: `${index + 1}1111111-1111-4111-8111-111111111111` };
    const native = { targetId: 'owned-test-target', accountIdentitySHA256: dashboard.identitySHA256, admissionBinding: binding, dashboard };
    const nativeConfigPath = join(root, `${id}.native.json`); await save(nativeConfigPath, native);
    const scenario = { schema: 1, runId: `synthetic-${id}`, syntheticOnly: true, executionKind: 'mock', mode: 'fixed',
      targetId: native.targetId, sourceSHA: 'a'.repeat(40), build: { bundleId: 'synthetic', number: '1', sha256: 'b'.repeat(64) },
      fixture: { sha256: 'c'.repeat(64) }, admissionBinding: binding, adapterSHA256: sha256(await readFile(nativeConfigPath)),
      personas: [{ id: 'clinician', profile: join(root, `${id}-clinician`) }, { id: 'patient', profile: join(root, `${id}-patient`) }] };
    const scenarioPath = join(root, `${id}.scenario.json`); await save(scenarioPath, scenario);
    accounts.push({ id, nativeConfigPath, scenarioPath });
  }
  const manifestPath = join(root, 'manifest.json');
  await save(manifestPath, { schema: 1, runId: 'synthetic-matrix', syntheticOnly: true, executionKind: 'mock', accounts });
  return { root, accounts, manifestPath, output: join(root, 'results') };
}
async function recordMockJourney({ accountId, scenario, output }, { cleanupSettled = true } = {}) {
  const identity = await journalIdentity(scenario);
  const journal = await Journal.load(join(output, 'run.json'), identity, false);
  const binding = { appointmentRef: 'mock-appointment-' + accountId, nativeSessionId: 'mock-session-' + accountId,
    noteRef: 'mock-note-' + accountId, transcriptRef: 'mock-transcript-' + accountId };
  for (const action of ACTIONS) {
    await journal.begin(action);
    const observation = { origin: 'product-ui', executionKind: 'mock', targetId: scenario.targetId, action,
      identitySHA256: accountId.repeat(64), checks: [{ locator: 'mock-only', kind: 'text', actual: 'observed', expected: 'observed' }],
      detail: { binding }, reopenedDetail: { binding }, cleanup: { ownedResourcesSettled: true }, savedPassagePlayback: { status: 'NOT_RUN' } };
    const observationFile = action + '.test.observation.json'; await atomicJSON(join(output, observationFile), observation);
    await journal.finish(action, { observationFile, observationSHA256: sha256(JSON.stringify(observation)) });
  }
  journal.state.status = 'MOCK_JOURNEY_PASS'; await journal.save();
  await atomicJSON(join(output, 'cleanup.json'), { ownedResourcesSettled: cleanupSettled, targetLeaseRetained: !cleanupSettled, enginePendingOperations: [] });
}

test('matrix runs isolated A then B and keeps mock receipts separate from live acceptance', async () => {
  const f = await fixture(), events = []; let active = 0, maximum = 0;
  try {
    const result = await runAccountMatrix({ ...f, signal: new AbortController().signal, runAccount: async args => {
      active++; maximum = Math.max(maximum, active); events.push('start-' + args.accountId);
      await recordMockJourney(args); events.push('settled-' + args.accountId); active--;
    } });
    assert.equal(result.status, 'MOCK_MATRIX_PASS'); assert.equal(result.fullAcceptance, 'NOT_RUN'); assert.equal(maximum, 1);
    assert.deepEqual(events, ['start-a', 'settled-a', 'start-b', 'settled-b']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('a returned pass without actual journal observations cannot advance to B', async () => {
  const f = await fixture(), calls = [];
  try {
    const result = await runAccountMatrix({ ...f, signal: new AbortController().signal, runAccount: async args => { calls.push(args.accountId); return { status: 'UI_JOURNEY_PASS' }; } });
    assert.equal(result.status, 'FAIL'); assert.deepEqual(calls, ['a']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('uncertain cleanup or a shared hosted account fails before another native run', async () => {
  const f = await fixture(), calls = [];
  try {
    const result = await runAccountMatrix({ ...f, signal: new AbortController().signal, runAccount: async args => {
      calls.push(args.accountId); await recordMockJourney(args, { cleanupSettled: false });
    } });
    assert.equal(result.failureCode, 'account_cleanup_unconfirmed'); assert.deepEqual(calls, ['a']);
    const a = JSON.parse(await readFile(f.accounts[0].nativeConfigPath)), b = JSON.parse(await readFile(f.accounts[1].nativeConfigPath));
    b.accountIdentitySHA256 = b.dashboard.identitySHA256 = a.dashboard.identitySHA256;
    await save(f.accounts[1].nativeConfigPath, b);
    const s = JSON.parse(await readFile(f.accounts[1].scenarioPath)); s.adapterSHA256 = sha256(await readFile(f.accounts[1].nativeConfigPath)); await save(f.accounts[1].scenarioPath, s);
    await assert.rejects(loadAccountMatrix(f.manifestPath), /accounts_not_isolated/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('all immutable account configs are checked before A and changed B is never started', async () => {
  const f = await fixture(), calls = [];
  try {
    const result = await runAccountMatrix({ ...f, signal: new AbortController().signal, runAccount: async args => {
      calls.push(args.accountId); await recordMockJourney(args); await writeFile(f.accounts[1].nativeConfigPath, '{}');
    } });
    assert.equal(result.failureCode, 'account_inputs_changed'); assert.deepEqual(calls, ['a']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('resume verifies completed A receipts and starts only the interrupted B account', async () => {
  const f = await fixture(), calls = [];
  try {
    const first = await runAccountMatrix({ ...f, signal: new AbortController().signal, runAccount: async args => {
      if (args.accountId === 'b') throw Error('test_interruption_before_start');
      await recordMockJourney(args);
    } });
    assert.equal(first.status, 'FAIL'); assert.equal(first.accounts.length, 1);
    const second = await runAccountMatrix({ ...f, resume: true, signal: new AbortController().signal, runAccount: async args => {
      calls.push([args.accountId, args.resume]); await recordMockJourney(args);
    } });
    assert.equal(second.status, 'MOCK_MATRIX_PASS'); assert.deepEqual(calls, [['b', false]]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('an abort after A settles never starts B', async () => {
  const f = await fixture(), calls = [], controller = new AbortController();
  try {
    const result = await runAccountMatrix({ ...f, signal: controller.signal, runAccount: async args => {
      calls.push(args.accountId); await recordMockJourney(args); controller.abort();
    } });
    assert.equal(result.failureCode, 'matrix_aborted'); assert.deepEqual(calls, ['a']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('live matrix ownership cannot be stolen by resume and initial publication never overwrites state', async () => {
  const f = await fixture(); let entered, settle;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const settledPromise = new Promise(resolve => { settle = resolve; });
  const first = runAccountMatrix({ ...f, signal: new AbortController().signal, runAccount: async args => {
    if (args.accountId === 'a') { entered(); await settledPromise; }
    await recordMockJourney(args);
  } });
  try {
    await enteredPromise;
    const before = await readFile(join(f.output, 'matrix.json'));
    const unexpected = async () => { throw Error('competing_native_work'); };
    await assert.rejects(runAccountMatrix({ ...f, signal: new AbortController().signal, runAccount: unexpected }), /matrix_exists_or_changed/);
    await assert.rejects(runAccountMatrix({ ...f, resume: true, signal: new AbortController().signal, runAccount: unexpected }), /recovery_guard_owner_alive/);
    assert.deepEqual(await readFile(join(f.output, 'matrix.json')), before);
  } finally { settle(); await first; await rm(f.root, { recursive: true, force: true }); }
});

test('actual matrix crash after guard publication retains complete binding and exact-run resume can recover', async () => {
  const f = await fixture(), script = join(f.root, 'matrix-crash.mjs'); let child, exited;
  try {
    await writeFile(script, `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
      const [manifestPath,output]=process.argv.slice(2),original=fs.open;
      fs.open=async(path,...args)=>{const result=await original(path,...args);
        if(path===output&&args[0]==='r') {let present=false;try{await fs.readFile(output+'/.matrix-lock/recovery-owner.json');present=true;}catch{}
          if(present){process.stdout.write('guard-published\\n');setInterval(()=>{},1000);return new Promise(()=>{});}}
        return result;};syncBuiltinESMExports();
      const {runAccountMatrix}=await import(${JSON.stringify(new URL('./matrix.mjs', import.meta.url).href)});
      await runAccountMatrix({manifestPath,output,signal:new AbortController().signal,runAccount:async()=>{throw Error('native_work_must_not_start');}});`);
    // runAccountMatrix canonicalizes output before guard publication.
    const output = join(await realpath(f.root), 'results');
    child = spawn(process.execPath, [script, f.manifestPath, output], { stdio: ['ignore', 'pipe', 'pipe'] });
    exited = new Promise(resolve => child.once('exit', resolve));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('matrix_crash_test_timeout')), 10000);
      child.stdout.once('data', bytes => { clearTimeout(timer); bytes.toString().includes('guard-published') ? resolve() : reject(Error('matrix_guard_marker_missing')); });
      child.once('exit', () => { clearTimeout(timer); reject(Error('matrix_crash_child_exited')); });
    });
    const statePath = join(output, 'matrix.json'), bytes = await readFile(statePath), state = JSON.parse(bytes);
    const owner = JSON.parse(await readFile(join(output, '.matrix-lock/recovery-owner.json')));
    assert.equal(state.status, 'INITIALIZING'); assert.deepEqual(state.accounts, []);
    assert.deepEqual(owner.runIdentity, state.runIdentity); assert.equal(owner.pid, child.pid);
    assert.equal(owner.runIdentity.outputCanonical, output); assert.equal(owner.runIdentity.scenarioSHA256, state.manifestSHA256);
    await assert.rejects(runAccountMatrix({ ...f, resume: true, signal: new AbortController().signal, runAccount: recordMockJourney }), /recovery_guard_owner_alive/);
    child.kill('SIGTERM'); await exited;
    for (const changed of [{ ...state, runIdentity: undefined },
      { ...state, runIdentity: { ...state.runIdentity, outputCanonical: output + '-other' } },
      { ...state, runIdentity: { ...state.runIdentity, implementationSHA256: 'f'.repeat(64) } }]) {
      await save(statePath, changed);
      await assert.rejects(runAccountMatrix({ ...f, resume: true, signal: new AbortController().signal, runAccount: recordMockJourney }), /matrix_exists_or_changed/);
    }
    await writeFile(statePath, bytes);
    const calls = [], resumed = await runAccountMatrix({ ...f, resume: true, signal: new AbortController().signal,
      runAccount: async args => { calls.push([args.accountId, args.resume]); await recordMockJourney(args); } });
    assert.equal(resumed.status, 'MOCK_MATRIX_PASS'); assert.deepEqual(calls, [['a', false], ['b', false]]);
    assert.deepEqual(resumed.runIdentity, state.runIdentity);
    await assert.rejects(readFile(join(output, '.matrix-lock/recovery-owner.json')), { code: 'ENOENT' });
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGTERM');
    await exited; await rm(f.root, { recursive: true, force: true });
  }
});

test('an initial caller cannot overwrite a resumer that finished between publication and guard acquisition', async () => {
  const f = await fixture(), script = join(f.root, 'matrix-publication-race.mjs'); let child, exited, stdout = '';
  try {
    await writeFile(script, `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
      const [manifestPath,output]=process.argv.slice(2),original=fs.open;let held=false;
      fs.open=async(path,...args)=>{const result=await original(path,...args);
        if(!held&&path===output&&args[0]==='r'){held=true;process.stdout.write('initial-published\\n');
          await new Promise(resolve=>{const timer=setInterval(()=>{},1000);process.once('SIGUSR1',()=>{clearInterval(timer);resolve();});});}
        return result;};syncBuiltinESMExports();
      const {runAccountMatrix}=await import(${JSON.stringify(new URL('./matrix.mjs', import.meta.url).href)});
      try{await runAccountMatrix({manifestPath,output,signal:new AbortController().signal,runAccount:async()=>{throw Error('duplicate_native_work');}});throw Error('race_not_refused');}
      catch(error){if(error.message!=='matrix_changed_during_acquisition')throw error;process.stdout.write('race-refused\\n');}`);
    const output = join(await realpath(f.root), 'results');
    child = spawn(process.execPath, [script, f.manifestPath, output], { stdio: ['ignore', 'pipe', 'pipe'] });
    exited = new Promise(resolve => child.once('exit', resolve));
    child.stdout.on('data', bytes => { stdout += bytes; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('matrix_publication_test_timeout')), 10000);
      child.stdout.once('data', bytes => { clearTimeout(timer); bytes.toString().includes('initial-published') ? resolve() : reject(Error('matrix_publication_marker_missing')); });
      child.once('exit', () => { clearTimeout(timer); reject(Error('matrix_publication_child_exited')); });
    });
    const result = await runAccountMatrix({ ...f, resume: true, signal: new AbortController().signal, runAccount: recordMockJourney });
    assert.equal(result.status, 'MOCK_MATRIX_PASS');
    const retained = await readFile(join(output, 'matrix.json'));
    child.kill('SIGUSR1'); await exited;
    assert.equal(child.exitCode, 0); assert.match(stdout, /race-refused/);
    assert.deepEqual(await readFile(join(output, 'matrix.json')), retained);
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGTERM');
    await exited; await rm(f.root, { recursive: true, force: true });
  }
});
