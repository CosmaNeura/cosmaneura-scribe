import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, readdir, unlink, symlink, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { ENGINEERING_BUDGETS, JOURNEY, nativeCleanupProvesStopped, runJourney, validateScenario } from './engine.mjs';
import { lockTarget, sha256 } from './journal.mjs';

const scenario = () => ({ schema: 1, syntheticOnly: true, runId: 'synthetic-engine-test', mode: 'fixed', executionKind: 'mock',
  targetId: `owned-test-target-${randomUUID()}`, sourceSHA: 'a'.repeat(40), build: { bundleId: 'test.scribe', number: '1', sha256: 'b'.repeat(64) },
  fixture: { sha256: 'c'.repeat(64) }, personas: [{ id: 'clinician-a', profile: 'a' }, { id: 'clinician-b', profile: 'b' }] });
const observation = (action, s) => ({ action, origin: 'product-ui', executionKind: 'mock', targetId: s.targetId,
  observedAtEpochMs: Date.now(), checks: [{ locator: 'test-only', kind: 'text', actual: action, expected: action }],
  nativeState: 'recording', elapsedSeconds: 1, consentReceiptSHA256: 'd'.repeat(64), fixtureSHA256: s.fixture.sha256,
  sourceState: 'ended', completedSourceFrames: 16000 });
function adapter(s, overrides = {}) {
  const calls = [];
  return { calls, lockIdentity: async () => s.targetId, doctor: async () => ({ ready: true, targetId: s.targetId, executionKind: 'mock' }), connect: async () => {},
    perform: async action => { calls.push(action); return observation(action, s); },
    reconcile: async () => { throw Error('reconciliation_required'); }, cleanup: async () => ({ ownedResourcesSettled: true }), ...overrides };
}
test('complete mocked journey is never reported as live acceptance', async () => {
  const output = await mkdtemp(join(tmpdir(), 'scribe-coordinator-')), s = scenario(), driver = adapter(s);
  const state = await runJourney({ scenario: s, adapter: driver, labRoot: output, output });
  assert.equal(state.status, 'MOCK_JOURNEY_PASS'); assert.deepEqual(driver.calls, JOURNEY);
  assert.equal(ENGINEERING_BUDGETS.recordReadyMs, 3000);
});
test('ambiguous Finish is reconciled, never clicked twice after restart', async () => {
  const output = await mkdtemp(join(tmpdir(), 'scribe-coordinator-')), s = scenario();
  const driver = adapter(s, { perform: async action => { driver.calls.push(action); if (action === 'finish') throw Error('reply_lost'); return observation(action, s); } });
  await assert.rejects(runJourney({ scenario: s, adapter: driver, labRoot: output, output }), /reply_lost/);
  assert.equal(JSON.parse(await readFile(join(output, 'run.json'))).pending, 'finish');
  const resumed = adapter(s, { reconcile: async action => observation(action, s) });
  await runJourney({ scenario: s, adapter: resumed, labRoot: output, output, resume: true });
  assert.ok(!resumed.calls.includes('finish')); assert.ok(!resumed.calls.includes('create_visit'));
});
test('an unconfirmed mutation blocks resume and preserves pending action', async () => {
  const output = await mkdtemp(join(tmpdir(), 'scribe-coordinator-')), s = scenario();
  await assert.rejects(runJourney({ scenario: s, adapter: adapter(s, { perform: async () => { throw Error('reply_lost'); } }), labRoot: output, output }));
  const resumed = adapter(s);
  await assert.rejects(runJourney({ scenario: s, adapter: resumed, labRoot: output, output, resume: true }), /reconciliation_required/);
  assert.deepEqual(resumed.calls, []);
});
test('changed manifest, hard-coded observation flags and stale evidence cannot pass', async () => {
  const output = await mkdtemp(join(tmpdir(), 'scribe-coordinator-')), s = scenario();
  await assert.rejects(runJourney({ scenario: s, adapter: adapter(s, { perform: async () => ({ passed: true }) }), labRoot: output, output }), /invalid_observation/);
  const changed = { ...s, sourceSHA: 'e'.repeat(40) };
  await assert.rejects(runJourney({ scenario: changed, adapter: adapter(changed), labRoot: output, output, resume: true }), /run_identity_changed/);
  const fresh = await mkdtemp(join(tmpdir(), 'scribe-coordinator-'));
  await assert.rejects(runJourney({ scenario: s, adapter: adapter(s, { perform: async action => ({ ...observation(action, s), observedAtEpochMs: Date.now() - 10000 }) }), labRoot: fresh, output: fresh }), /invalid_observation/);
});
test('exclusive target lease rejects a competing coordinator', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scribe-lock-'));
  const release = await lockTarget(directory, 'target');
  await assert.rejects(lockTarget(directory, 'target'), /target_locked/); await release();
});
test('adaptive runs require frozen ground truth and distinct persona stores', () => {
  assert.throws(() => validateScenario({ ...scenario(), mode: 'adaptive' }), /adaptive_truth/);
  assert.throws(() => validateScenario({ ...scenario(), personas: [{ id: 'a', profile: 'same' }, { id: 'b', profile: 'same' }] }), /isolated/);
});

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const leasePath = async s => join(await realpath(tmpdir()), `scribe-virtual-lab-target-locks-${process.getuid?.() ?? 'user'}`, `${sha256(s.targetId)}.lock`);
const newOutput = () => mkdtemp(join(tmpdir(), 'scribe-coordinator-'));

test('an actual first-run crash after lease publication already has its durable empty journal', async () => {
  const output = await newOutput(), s = scenario(), lease = await leasePath(s);
  const script = join(output, 'crash-after-lease.mjs'); let child, exited;
  try {
    await writeFile(script, `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
      const [output,raw,lease]=process.argv.slice(2),scenario=JSON.parse(raw),original=fs.link;
      fs.link=async(from,to)=>{const result=await original(from,to);if(to===lease){process.stdout.write('lease-published\\n');setInterval(()=>{},1000);return new Promise(()=>{});}return result;};
      syncBuiltinESMExports();const {runJourney}=await import(${JSON.stringify(new URL('./engine.mjs', import.meta.url).href)});
      await runJourney({scenario,output,labRoot:output,adapter:{lockIdentity:async()=>scenario.targetId,
        doctor:async()=>{throw Error('native_work_must_not_start');}}});`);
    child = spawn(process.execPath, [script, output, JSON.stringify(s), lease], { stdio: ['ignore', 'pipe', 'pipe'] });
    exited = new Promise(resolve => child.once('exit', resolve));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('first_run_crash_test_timeout')), 10000);
      child.stdout.once('data', bytes => { clearTimeout(timer); bytes.toString().includes('lease-published') ? resolve() : reject(Error('lease_marker_missing')); });
      child.once('exit', () => { clearTimeout(timer); reject(Error('first_run_child_exited')); });
    });
    const owner = JSON.parse(await readFile(lease)), journal = JSON.parse(await readFile(join(output, 'run.json')));
    assert.equal(owner.pid, child.pid); assert.equal(owner.uncertain, true);
    assert.equal(journal.identity.runId, owner.runIdentity.runId);
    assert.equal(journal.identity.scenarioSHA256, owner.runIdentity.scenarioSHA256);
    assert.equal(journal.identity.implementationSHA256, owner.runIdentity.implementationSHA256);
    assert.deepEqual(journal.events, []); assert.deepEqual(journal.completed, []); assert.equal(journal.pending, null);
    child.kill('SIGTERM'); await exited;
    assert.deepEqual(JSON.parse(await readFile(join(output, 'run.json'))), journal);
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGTERM');
    await exited;
    await rm(lease, { force: true }); await rm(lease + '.acquiring', { recursive: true, force: true });
    for (const name of await readdir(dirname(lease))) if (name.startsWith(basename(lease) + '.prepared.'))
      await rm(join(dirname(lease), name), { force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test('summary state cannot skip or replay actions under an unchanged event chain', async () => {
  const output=await newOutput(),s=scenario();await runJourney({scenario:s,adapter:adapter(s),output,labRoot:output,stopAfter:'create_visit'});
  const original=JSON.parse(await readFile(join(output,'run.json')));
  for(const changed of [{...original,completed:[...JOURNEY]},{...original,completed:['sign_in','workspace']},{...original,pending:'finish'}]) {
    await writeFile(join(output,'run.json'),JSON.stringify(changed));const driver=adapter(s);
    await assert.rejects(runJourney({scenario:s,adapter:driver,output,labRoot:output,resume:true}),/journal_integrity_failed/);assert.deepEqual(driver.calls,[]);
  }
});

test('resume verifies exact observation bytes and supplies bound objects to restoration', async () => {
  const output=await newOutput(),s=scenario();await runJourney({scenario:s,adapter:adapter(s),output,labRoot:output,stopAfter:'sign_in'});
  const state=JSON.parse(await readFile(join(output,'run.json'))),event=state.events.find(e=>e.kind==='action_observed');
  const path=join(output,event.evidence.observationFile),original=await readFile(path,'utf8');let restored;
  await runJourney({scenario:s,adapter:adapter(s,{restore:async(_state,{observations,signal,output:actual})=>{assert.ok(signal instanceof AbortSignal);assert.equal(actual,output);restored=observations;}}),output,labRoot:output,resume:true});
  assert.equal(restored.sign_in.action,'sign_in');
  await writeFile(path,original.replace('test-only','changed-test-only'));
  await assert.rejects(runJourney({scenario:s,adapter:adapter(s),output,labRoot:output,resume:true}),/observation_integrity_failed/);
  await unlink(path);const elsewhere=join(output,'copy.json');await writeFile(elsewhere,original);await symlink(elsewhere,path);
  await assert.rejects(runJourney({scenario:s,adapter:adapter(s),output,labRoot:output,resume:true}),/observation_integrity_failed/);
});

test('failed assertions preserve their actual observation before rejection', async () => {
  const output=await newOutput(),s=scenario(),bad={...observation('sign_in',s),checks:[{locator:'wrong-state',kind:'text',actual:'failed',expected:'ready'}]};
  await assert.rejects(runJourney({scenario:s,adapter:adapter(s,{perform:async()=>bad}),output,labRoot:output}),/ui_assertion_failed/);
  const files=(await readdir(output)).filter(f=>f.endsWith('.observation.json'));assert.equal(files.length,1);
  assert.deepEqual(JSON.parse(await readFile(join(output,files[0]))),bad);
});

test('same verified target cannot be acquired through different lab and output roots', async () => {
  const output=await newOutput(),other=await newOutput(),s=scenario(),entered=deferred(),gate=deferred();
  const first=runJourney({scenario:s,adapter:adapter(s,{connect:async()=>{entered.resolve();await gate.promise;}}),output,labRoot:output,stopAfter:'sign_in'});
  await entered.promise;
  try { await assert.rejects(runJourney({scenario:s,adapter:adapter(s),output:other,labRoot:other}),/target_locked|target_requires_reconciliation/); }
  finally { gate.resolve();await first; }
});

test('missing, rejected, and negative cleanup retain quarantined ownership and cannot pass', async t => {
  for(const cleanup of [undefined,async()=>{throw Error('cleanup_rejected');},async()=>({ownedResourcesSettled:false})]) {
    const output=await newOutput(),s=scenario(),path=await leasePath(s);t.after(()=>unlink(path).catch(()=>{}));
    await assert.rejects(runJourney({scenario:s,adapter:adapter(s,{cleanup}),output,labRoot:output}),/cleanup_uncertain/);
    assert.equal(JSON.parse(await readFile(path)).uncertain,true);
    assert.equal(JSON.parse(await readFile(join(output,'run.json'))).status,'FAIL');
    await assert.rejects(runJourney({scenario:s,adapter:adapter(s),output:await newOutput(),labRoot:output}),/target_requires_reconciliation/);
  }
});

test('late connect completion is drained and cleanup is reconfirmed before releasing the lease', async () => {
  const output=await newOutput(),s={...scenario(),timeoutMs:1000},events=[];let aborted=false;
  const driver=adapter(s,{connect:async(_s,{signal})=>{signal.addEventListener('abort',()=>{aborted=true;});await new Promise(r=>setTimeout(r,1200));events.push('late-connect');},cleanup:async()=>{events.push('cleanup');return{ownedResourcesSettled:true};}});
  await assert.rejects(runJourney({scenario:s,adapter:driver,output,labRoot:output}),/operation_timeout/);
  assert.equal(aborted,true);assert.deepEqual(events,['cleanup','late-connect','cleanup']);
  await assert.rejects(readFile(await leasePath(s)),{code:'ENOENT'});
});

test('an unsettled action keeps its quarantine despite a prematurely positive cleanup receipt', async t => {
  const output=await newOutput(),s={...scenario(),timeoutMs:1000},path=await leasePath(s);t.after(()=>unlink(path).catch(()=>{}));
  const driver=adapter(s,{connect:async()=>new Promise(()=>{})});
  await assert.rejects(runJourney({scenario:s,adapter:driver,output,labRoot:output}),/operation_timeout/);
  const cleanup=JSON.parse(await readFile(join(output,'cleanup.json')));
  assert.equal(cleanup.ownedResourcesSettled,false);assert.deepEqual(cleanup.enginePendingOperations,['connect']);assert.equal(cleanup.targetLeaseRetained,true);
});

test('restore and reconciliation receive bounded cancellation', async () => {
  const blocked=flags=>async(_state,_scenario,options)=>{const active=(options??_scenario).signal;return new Promise((_,reject)=>active.addEventListener('abort',()=>{flags.aborted=true;reject(Error('aborted'));},{once:true}));};
  const output=await newOutput(),s={...scenario(),timeoutMs:1000},restored={};
  await assert.rejects(runJourney({scenario:s,adapter:adapter(s,{restore:blocked(restored)}),output,labRoot:output}),/operation_timeout/);assert.equal(restored.aborted,true);
  const second=await newOutput(),other={...scenario(),timeoutMs:1000};
  await assert.rejects(runJourney({scenario:other,adapter:adapter(other,{perform:async()=>{throw Error('reply_lost');}}),output:second,labRoot:second}),/reply_lost/);
  const reconciled={};await assert.rejects(runJourney({scenario:other,adapter:adapter(other,{reconcile:blocked(reconciled)}),output:second,labRoot:second,resume:true}),/operation_timeout/);assert.equal(reconciled.aborted,true);
});

test('live scenarios require pinned adapter and real admission identities', () => {
  const live={...scenario(),executionKind:'live'};assert.throws(()=>validateScenario(live),/live_admission/);
  const complete={...live,adapterSHA256:'f'.repeat(64),admissionBinding:{runId:randomUUID(),workspaceId:randomUUID()}};
  assert.equal(validateScenario(complete),complete);
  assert.throws(()=>validateScenario({...complete,admissionBinding:{...complete.admissionBinding,appointmentRef:'invented'}}),/live_admission/);
});

// Unit-only injected adapter exercises the live policy branch; these temporary
// receipts do not come from a native target and are not lab acceptance evidence.
function livePolicyFixture() {
  const s = { ...scenario(), executionKind: 'live', adapterSHA256: 'f'.repeat(64), admissionBinding: { runId: randomUUID() } };
  const visit = { source: 'normal-native-mount-response', runId: s.admissionBinding.runId, workspaceId: randomUUID(), appointmentRef: 'appointment_01m5q8r3kzeng9szb5frh6ppk3' };
  const admission = { ...visit, source: 'normal-native-admission-response', sessionId: randomUUID() };
  const native = () => ({ ...admission, source: 'normal-native-recording-response', nativeRevision: 2, phase: 'sealed', busy: false,
    observedAtMonotonicMs: 1, browserTimeOriginMs: Date.now() - 1 });
  const observe = action => ({ ...observation(action, s), executionKind: 'live',
    ...(action === 'create_visit' ? { visitScope: visit } : {}), ...(action === 'consent' ? { admission } : {}),
    ...(action === 'finish' ? { nativeTerminal: native() } : {}) });
  const proof = () => ({ source: 'current-native-cleanup-observation', executionKind: 'live', runId: s.runId, targetId: s.targetId,
    observedAtEpochMs: Date.now(), currentVisit: visit, nativeObservation: native(), observerPendingReplies: 0 });
  const driver = overrides => adapter(s, { doctor: async () => ({ ready: true, targetId: s.targetId, executionKind: 'live' }),
    perform: async action => observe(action), ...overrides });
  return { s, admission, native, observe, proof, driver };
}

test('live policy retains a resumable paused capture lease even when owned resources settled', async t => {
  const { s, driver } = livePolicyFixture(), output = await newOutput(), path = await leasePath(s);
  t.after(() => unlink(path).catch(() => {}));
  const state = await runJourney({ scenario: s, adapter: driver(), output, labRoot: output, stopAfter: 'record' });
  assert.equal(state.status, 'PAUSED');
  const cleanup = JSON.parse(await readFile(join(output, 'cleanup.json')));
  assert.equal(cleanup.ownedResourcesSettled, true); assert.equal(cleanup.nativeCaptureSafeToRelease, false); assert.equal(cleanup.targetLeaseRetained, true);
  assert.equal(JSON.parse(await readFile(path)).uncertain, true);
  await assert.rejects(runJourney({ scenario: s, adapter: driver(), output: await newOutput(), labRoot: output }), /target_requires_reconciliation/);
});

test('capture quarantine preserves an original failure without misreporting settled resource cleanup', async t => {
  const { s, driver, observe } = livePolicyFixture(), output = await newOutput(), path = await leasePath(s);
  t.after(() => unlink(path).catch(() => {}));
  await assert.rejects(runJourney({ scenario: s, output, labRoot: output, adapter: driver({ perform: async action => {
    if (action === 'finish') throw Error('original_reply_lost'); return observe(action);
  } }) }), /original_reply_lost/);
  const state = JSON.parse(await readFile(join(output, 'run.json'))), cleanup = JSON.parse(await readFile(join(output, 'cleanup.json')));
  assert.equal(state.status, 'FAIL'); assert.equal(state.pending, 'finish'); assert.equal(cleanup.ownedResourcesSettled, true);
  assert(state.events.some(event => event.kind === 'capture_quarantined')); assert(!state.events.some(event => event.kind === 'cleanup_uncertain'));
});

test('fresh same-session stopped proof releases capture ownership only with a recorded Finish for completion', async t => {
  for (const missingFinish of [false, true]) {
    const { s, driver, observe, proof } = livePolicyFixture(), output = await newOutput(), path = await leasePath(s);
    t.after(() => unlink(path).catch(() => {}));
    const run = runJourney({ scenario: s, output, labRoot: output, adapter: driver({
      perform: async action => { const value = observe(action); if (missingFinish && action === 'finish') delete value.nativeTerminal; return value; },
      cleanup: async ({ captureProofAtOrAfterEpochMs }) => { const value = proof(); assert(value.observedAtEpochMs >= captureProofAtOrAfterEpochMs); return { ownedResourcesSettled: true, nativeCaptureProof: value }; },
    }) });
    if (missingFinish) { await assert.rejects(run, /native_capture_release_unconfirmed/); assert.equal(JSON.parse(await readFile(path)).uncertain, true); }
    else { assert.equal((await run).status, 'UI_JOURNEY_PASS'); await assert.rejects(readFile(path), { code: 'ENOENT' }); }
  }
});

test('cleanup policy rejects foreign sessions, pending work, stale proof and paused desktop stop markers', () => {
  const { s, admission, proof } = livePolicyFixture(), start = Date.now(), observations = { consent: { admission } };
  assert.equal(nativeCleanupProvesStopped(proof(), s, observations, start), true);
  for (const change of [value => { value.nativeObservation.sessionId = randomUUID(); }, value => { value.observerPendingReplies = 1; },
    value => { value.observedAtEpochMs = start - 1; }, value => { value.nativeObservation.browserTimeOriginMs -= 16000; },
    value => { value.nativeObservation.busy = true; }, value => { value.nativeObservation = { ...value.nativeObservation,
      source: 'normal-desktop-recording-response', phase: 'stopped', captureState: 'paused', pendingMutation: false }; }]) {
    const value = proof(); change(value); assert.equal(nativeCleanupProvesStopped(value, s, observations, start), false);
  }
});
