import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ACTIONS, Journal, atomicJSON, sha256 } from './journal.mjs';
import { runJourney } from './engine.mjs';
import { recoverRun, recoveryStage, validateRecoveryInspection } from './recovery.mjs';
import { journalIdentity } from './tool-identity.mjs';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ref = 'appointment_01m5q661ryetaa28yxe7vbqrex';
async function fixture({ pendingFinish = false, completedCount = pendingFinish ? 7 : 6 } = {}) {
  const output = await mkdtemp(resolve(tmpdir(), 'scribe-recovery-'));
  const scenario = { schema: 1, runId: 'recovery-test', mode: 'fixed', executionKind: 'mock', syntheticOnly: true,
    sourceSHA: 'a'.repeat(40), build: { bundleId: 'mock.app', number: '1', sha256: 'b'.repeat(64) }, fixture: { sha256: 'c'.repeat(64) },
    targetId: randomUUID(), admissionBinding: { runId: uuid(1) }, personas: [{ id: 'a', profile: output + '/a' }, { id: 'b', profile: output + '/b' }] };
  const identity = await journalIdentity(scenario);
  const runIdentity = { runId: scenario.runId, scenarioSHA256: identity.scenarioSHA256,
    implementationSHA256: identity.implementationSHA256, outputCanonical: await realpath(output) };
  const visit = { source: 'normal-native-mount-response', runId: uuid(1), workspaceId: uuid(2), appointmentRef: ref };
  const admission = { ...visit, source: 'normal-native-admission-response', sessionId: uuid(3) };
  const native = { ...admission, source: 'normal-native-recording-response', nativeRevision: 3, phase: 'recording', busy: false,
    observedAtMonotonicMs: 1, browserTimeOriginMs: Date.now() - 1 };
  const journal = await Journal.load(resolve(output, 'run.json'), identity, false);
  const observe = action => ({ origin: 'product-ui', executionKind: 'mock', action, targetId: scenario.targetId,
    observedAtEpochMs: Date.now(), checks: [{ locator: 'mock-only', kind: 'text', actual: 'observed', expected: 'observed' }],
    ...(action === 'create_visit' ? { visitScope: visit } : {}), ...(action === 'consent' ? { admission } : {}),
    ...(['record', 'play_source'].includes(action) ? { nativeObservation: native, nativeState: 'recording', elapsedSeconds: 1,
      consentReceiptSHA256: sha256(JSON.stringify(admission)) } : {}),
    ...(action === 'play_source' ? { sourceState: 'ended', fixtureSHA256: scenario.fixture.sha256, completedSourceFrames: 16000 } : {}) });
  const observations = {};
  for (const action of ACTIONS.slice(0, completedCount)) {
    await journal.begin(action); const value = observe(action), file = action + '.test.observation.json';
    observations[action] = value;
    await atomicJSON(resolve(output, file), value); await journal.finish(action, { observationFile: file, observationSHA256: sha256(JSON.stringify(value)) });
  }
  if (pendingFinish) await journal.begin('finish');
  const directory = resolve(await realpath(tmpdir()), `scribe-virtual-lab-target-locks-${process.getuid?.() ?? 'user'}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const leasePath = resolve(directory, sha256(scenario.targetId) + '.lock');
  const owner = { pid: 2147483647, host: hostname(), token: randomUUID(), runIdentity, uncertain: true };
  await atomicJSON(leasePath, owner);
  const events = [];
  const inspection = () => ({ source: 'current-native-recovery-observation', executionKind: 'mock', runId: scenario.runId,
    recoveryStage: 'capture', targetId: scenario.targetId, observedAtEpochMs: Date.now(), currentVisit: visit, currentNote: null,
    nativeObservation: { ...admission, source: 'normal-native-recording-response', nativeRevision: 4, phase: 'sealed', busy: false,
      observedAtMonotonicMs: 1, browserTimeOriginMs: Date.now() - 1 }, observerPendingReplies: 0, unresolvedOwnedResources: [] });
  const adapter = { lockIdentity: async () => scenario.targetId,
    doctor: async () => ({ ready: true, executionKind: 'mock', targetId: scenario.targetId }),
    recoveryInspect: async args => { events.push('inspect'); assert.equal(args.output, await realpath(output)); assert(!JSON.stringify(args).includes('2147483647')); return inspection(); },
    recoveryCleanup: async args => { events.push(['cleanup', args.preserveForRecovery]); return { ownedResourcesSettled: true, nativeAppTerminated: false }; } };
  return { output, scenario, runIdentity, owner, leasePath, events, inspection, adapter, observe, journal, observations,
    dispose: async () => { await rm(leasePath, { force: true }); await rm(leasePath + '.acquiring', { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); } };
}
const signal = () => new AbortController().signal;

test('pre-Record journal permits observed absence and releases only known settled control resources', async () => {
  for (const completedCount of [0, 1, 2, 3, 5]) {
    const f = await fixture({ completedCount });
    try {
      f.adapter.recoveryInspect = async args => {
        assert.equal(args.recoveryStage, 'pre-record');
        return { ...f.inspection(), recoveryStage: 'pre-record', observers: { visit: null, admission: null, desktop: null },
          ...(completedCount >= 3 ? { observers: { visit: { runId: uuid(1), observerSHA256: 'a'.repeat(64), pendingObservedReplies: 0 }, admission: null, desktop: null } } : {}),
          currentVisit: completedCount >= 3 ? f.observations.create_visit.visitScope : null, nativeObservation: null };
      };
      const result = await recoverRun({ ...f, signal: signal() });
      assert.equal(result.status, 'CLEANED'); assert.equal(result.capture.captureStopped, null);
      assert.equal(result.capture.noRecordAttempt, true); assert.equal(result.targetLeaseRetained, false);
      assert.deepEqual(f.events, [['cleanup', false]]);
    } finally { await f.dispose(); }
  }
});

test('pre-Record absent or retained observer metadata must be freshly explicit, bound and settled', async () => {
  const f = await fixture({ completedCount: 0 });
  try {
    const base = () => ({ ...f.inspection(), recoveryStage: 'pre-record', currentVisit: null, nativeObservation: null,
      observers: { visit: null, admission: null, desktop: null } });
    const good = base(); good.observers.visit = { runId: uuid(1), observerSHA256: 'a'.repeat(64), pendingObservedReplies: 0 };
    assert.equal(validateRecoveryInspection(good, f.scenario, f.observations, f.journal.state).canReleaseWithoutCapture, true);
    for (const mutate of [value => { delete value.observers; }, value => { delete value.observers.admission; },
      value => { value.observers.visit = undefined; },
      value => { value.observers.visit = { ...good.observers.visit, runId: uuid(99) }; },
      value => { value.observers.visit = { ...good.observers.visit, pendingObservedReplies: 1 }; },
      value => { value.observers.visit = { ...good.observers.visit, observerSHA256: null }; },
      value => { value.unresolvedOwnedResources = [{ kind: 'participant-browser' }]; }]) {
      const value = base(); mutate(value);
      assert.throws(() => validateRecoveryInspection(value, f.scenario, f.observations, f.journal.state), /unconfirmed/);
    }
  } finally { await f.dispose(); }
});

test('any Record attempt requires strict capture proof and an unexpectedly active pre-Record capture stays quarantined', async () => {
  const f = await fixture({ completedCount: 5 });
  try {
    assert.equal(recoveryStage(f.journal.state, f.observations), 'pre-record');
    const descriptor = { runId: uuid(1), observerSHA256: 'a'.repeat(64), pendingObservedReplies: 0 };
    const value = { ...f.inspection(), recoveryStage: 'pre-record', observers: { visit: descriptor, admission: descriptor, desktop: null } };
    value.nativeObservation.phase = 'recording';
    f.adapter.recoveryInspect = async () => value;
    const result = await recoverRun({ ...f, signal: signal() });
    assert.equal(result.status, 'CLEANED_CAPTURE_PRESERVED'); assert.equal(result.targetLeaseRetained, true);
    await f.journal.begin('record'); assert.equal(recoveryStage(f.journal.state, f.observations), 'capture');
    assert.throws(() => validateRecoveryInspection(value, f.scenario, f.observations, f.journal.state), /stage_mismatch/);
    value.recoveryStage = 'capture'; value.nativeObservation = null;
    assert.throws(() => validateRecoveryInspection(value, f.scenario, f.observations, f.journal.state), /native_state_unavailable/);
  } finally { await f.dispose(); }
});

test('recovery rejects a lower native revision or different source than recorded Record and Finish', async () => {
  const f = await fixture();
  try {
    for (const prior of [{ nativeRevision: 5 }, { source: 'normal-desktop-recording-response' }]) {
      const observations = { ...f.observations, record: { nativeObservation: { ...f.observations.record.nativeObservation, ...prior } } };
      assert.throws(() => validateRecoveryInspection(f.inspection(), f.scenario, observations, f.journal.state), /native_revision_regressed/);
    }
    const observations = { ...f.observations, finish: { nativeTerminal: { ...f.inspection().nativeObservation, nativeRevision: 7 } } };
    assert.throws(() => validateRecoveryInspection(f.inspection(), f.scenario, observations, f.journal.state), /native_revision_regressed/);
    const latest = f.inspection(); latest.nativeObservation.nativeRevision = 7;
    assert.equal(validateRecoveryInspection(latest, f.scenario, observations, f.journal.state).captureStopped, true);
  } finally { await f.dispose(); }
});

test('pre-Record resume reconciles a pending visit creation without issuing another Create', async () => {
  const f = await fixture({ completedCount: 2 }), performed = [], reconciled = [];
  try {
    await f.journal.begin('create_visit');
    f.adapter.recoveryInspect = async () => ({ ...f.inspection(), recoveryStage: 'pre-record', nativeObservation: null,
      observers: { visit: { runId: uuid(1), observerSHA256: 'a'.repeat(64), pendingObservedReplies: 0 }, admission: null, desktop: null } });
    const adapter = { ...f.adapter, connect: async () => {}, restore: async () => {},
      perform: async action => { performed.push(action); return f.observe(action); },
      reconcile: async action => { reconciled.push(action); return f.observe(action); }, cleanup: async () => ({ ownedResourcesSettled: true }) };
    const result = await recoverRun({ ...f, mode: 'resume', signal: signal(), resumeWithLease: preacquiredLease =>
      runJourney({ scenario: f.scenario, adapter, output: f.output, labRoot: f.output, resume: true, preacquiredLease }) });
    assert.equal(result.status, 'RESUMED', JSON.stringify(result)); assert.equal(result.resumeStatus, 'MOCK_JOURNEY_PASS');
    assert.deepEqual(reconciled, ['create_visit']); assert(!performed.includes('create_visit'));
    assert.equal(performed.filter(action => action === 'finish').length, 1);
  } finally { await f.dispose(); }
});

test('explicit same-run cleanup inspects first and releases only a proved stopped capture', async () => {
  const f = await fixture();
  try {
    const before = await readFile(resolve(f.output, 'run.json'));
    const result = await recoverRun({ ...f, signal: signal() });
    assert.equal(result.status, 'CLEANED'); assert.equal(result.targetLeaseRetained, false);
    assert.deepEqual(f.events, ['inspect', ['cleanup', false]]);
    assert.deepEqual(await readFile(resolve(f.output, 'run.json')), before);
    await assert.rejects(readFile(f.leasePath), { code: 'ENOENT' });
  } finally { await f.dispose(); }
});
test('live owner and unbound or different-run quarantines cannot be stolen', async () => {
  const f = await fixture();
  try {
    for (const [patch, expected] of [[{ pid: process.pid }, 'recovery_owner_still_alive'],
      [{ runIdentity: undefined }, 'recovery_lease_run_mismatch'], [{ runIdentity: { ...f.runIdentity, runId: 'other-run' } }, 'recovery_lease_run_mismatch']]) {
      await atomicJSON(f.leasePath, { ...f.owner, ...patch }); const before = await readFile(f.leasePath);
      const result = await recoverRun({ ...f, signal: signal() });
      assert.equal(result.failureCode, expected); assert.deepEqual(await readFile(f.leasePath), before);
    }
    assert.equal(f.events.length, 0);
  } finally { await f.dispose(); }
});
test('active capture cleanup preserves quarantine and never issues Finish', async () => {
  const f = await fixture();
  try {
    f.adapter.recoveryInspect = async () => { const value = f.inspection(); value.nativeObservation.phase = 'recording'; return value; };
    const result = await recoverRun({ ...f, signal: signal() });
    assert.equal(result.status, 'CLEANED_CAPTURE_PRESERVED'); assert.equal(result.targetLeaseRetained, true);
    assert.equal(JSON.parse(await readFile(f.leasePath)).uncertain, true);
    assert.deepEqual(f.events, [['cleanup', true]]);
  } finally { await f.dispose(); }
});
test('missing, stale or unresolved native evidence retains quarantine after closing fresh handles', async () => {
  const f = await fixture();
  try {
    for (const mutate of [value => { value.unresolvedOwnedResources = [{ kind: 'source-browser', reason: 'ownership_unknown' }]; },
      value => { value.nativeObservation.sessionId = uuid(99); }, value => { value.nativeObservation.browserTimeOriginMs -= 16000; },
      value => { value.observerPendingReplies = 1; }]) {
      f.adapter.recoveryInspect = async () => { const value = f.inspection(); mutate(value); return value; };
      const result = await recoverRun({ ...f, signal: signal() });
      assert.equal(result.status, 'BLOCKED'); assert.equal(result.targetLeaseRetained, true);
      assert.equal(JSON.parse(await readFile(f.leasePath)).uncertain, true);
    }
    assert.equal(f.events.filter(Array.isArray).length, 4);
  } finally { await f.dispose(); }
});
test('corrupt hash-bound observations stop recovery before native inspection', async () => {
  const f = await fixture();
  try {
    await atomicJSON(resolve(f.output, 'consent.test.observation.json'), {});
    await assert.rejects(recoverRun({ ...f, signal: signal() }), /observation_integrity_failed/);
    assert.equal(f.events.length, 0);
  } finally { await f.dispose(); }
});
test('a journal from different tooling cannot be recovered by the current implementation', async () => {
  const f = await fixture();
  try {
    const path = resolve(f.output, 'run.json'), value = JSON.parse(await readFile(path));
    value.identity.implementationSHA256 = 'f'.repeat(64); await atomicJSON(path, value);
    await assert.rejects(recoverRun({ ...f, signal: signal() }), /run_identity_changed/);
    assert.equal(f.events.length, 0);
  } finally { await f.dispose(); }
});
test('same-process recovery hands the exact lease to resume and reconciles Finish without repeating it', async () => {
  const f = await fixture({ pendingFinish: true }), performed = [], reconciled = [];
  try {
    const adapter = { ...f.adapter, connect: async () => {}, restore: async () => {},
      perform: async action => { performed.push(action); return f.observe(action); },
      reconcile: async action => { reconciled.push(action); return f.observe(action); }, cleanup: async () => ({ ownedResourcesSettled: true }) };
    const result = await recoverRun({ ...f, mode: 'resume', signal: signal(), resumeWithLease: preacquiredLease =>
      runJourney({ scenario: f.scenario, adapter, output: f.output, labRoot: f.output, resume: true, preacquiredLease }) });
    assert.equal(result.status, 'RESUMED'); assert.equal(result.resumeStatus, 'MOCK_JOURNEY_PASS');
    assert.deepEqual(reconciled, ['finish']); assert(!performed.includes('finish'));
    assert.equal(result.targetLeaseRetained, false);
  } finally { await f.dispose(); }
});
test('unsettled late inspection retains both guard and target quarantine', async () => {
  const f = await fixture(); let settle;
  try {
    f.adapter.recoveryInspect = () => new Promise(resolve => { settle = () => resolve(f.inspection()); });
    const result = await recoverRun({ ...f, signal: signal(), timeoutMs: 30 });
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.recoveryGuardRetained, true); assert.equal(result.targetLeaseRetained, true);
    settle(); await new Promise(resolve => setImmediate(resolve));
  } finally { await f.dispose(); }
});
test('a late settled inspection gets another fresh-resource cleanup confirmation', async () => {
  const f = await fixture();
  try {
    f.adapter.recoveryInspect = () => new Promise(resolve => setTimeout(() => resolve(f.inspection()), 45));
    const result = await recoverRun({ ...f, signal: signal(), timeoutMs: 30 });
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.recoveryGuardRetained, false);
    assert.equal(f.events.filter(Array.isArray).length, 2);
  } finally { await f.dispose(); }
});
test('a complete dead same-run guard can be claimed once, without stealing a live successor', async () => {
  const f = await fixture(); let releaseInspection;
  try {
    const guard = f.leasePath + '.acquiring'; await mkdir(guard);
    await atomicJSON(resolve(guard, 'recovery-owner.json'), { attemptId: randomUUID(), pid: 2147483647, host: hostname(), runIdentity: f.runIdentity });
    let inspected;
    const entered = new Promise(resolve => { inspected = resolve; });
    f.adapter.recoveryInspect = () => new Promise(resolve => { releaseInspection = () => resolve(f.inspection()); inspected(); });
    const first = recoverRun({ ...f, signal: signal() }); await entered;
    try { await assert.rejects(recoverRun({ ...f, signal: signal() }), /recovery_guard_owner_alive/); }
    finally { releaseInspection(); }
    const result = await first;
    assert.equal(result.status, 'CLEANED'); assert.equal(result.recoveredGuardDepth, 1);
    await assert.rejects(readFile(resolve(guard, 'recovery-owner.json')), { code: 'ENOENT' });
  } finally { await f.dispose(); }
});
test('unbound and foreign acquiring guards stay untouched', async () => {
  const f = await fixture();
  try {
    const guard = f.leasePath + '.acquiring'; await mkdir(guard);
    await assert.rejects(recoverRun({ ...f, signal: signal() }), { code: 'ENOENT' });
    const path = resolve(guard, 'recovery-owner.json');
    await atomicJSON(path, { attemptId: randomUUID(), pid: 2147483647, host: hostname(), runIdentity: { ...f.runIdentity, runId: 'foreign' } });
    const before = await readFile(path);
    await assert.rejects(recoverRun({ ...f, signal: signal() }), /recovery_guard_identity_unconfirmed/);
    assert.deepEqual(await readFile(path), before); assert.equal(f.events.length, 0);
  } finally { await f.dispose(); }
});
test('simultaneous recovery attempts admit one claimant of a dead guard chain', async () => {
  const f = await fixture(); let releaseInspection;
  try {
    const guard = f.leasePath + '.acquiring'; await mkdir(guard);
    const predecessor = resolve(guard, 'recovery-owner.json');
    await atomicJSON(predecessor, { attemptId: randomUUID(), pid: 2147483647, host: hostname(), runIdentity: f.runIdentity });
    const next = resolve(guard, `claim.${sha256(await readFile(predecessor))}.json`);
    await atomicJSON(next, { attemptId: randomUUID(), pid: 2147483647, host: hostname(), runIdentity: f.runIdentity });
    let inspected; const entered = new Promise(resolve => { inspected = resolve; });
    f.adapter.recoveryInspect = () => new Promise(resolve => { releaseInspection = () => resolve(f.inspection()); inspected(); });
    const jobs = [recoverRun({ ...f, signal: signal() }), recoverRun({ ...f, signal: signal() })];
    const firstResult = Promise.race(jobs.map(job => job.then(value => ({ value }), error => ({ error }))));
    await entered;
    try { assert.match((await firstResult).error?.message ?? '', /recovery_guard_owner_alive/); }
    finally { releaseInspection(); }
    const results = await Promise.allSettled(jobs);
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(results.find(value => value.status === 'fulfilled').value.recoveredGuardDepth, 2);
  } finally { await f.dispose(); }
});
test('normal crashes before and after atomic lease publication leave only complete recoverable ownership', async () => {
  for (const boundary of ['before', 'after']) {
  const f = await fixture(); let child;
  try {
    await rm(f.leasePath);
    const script = resolve(f.output, 'interrupted-normal-lock.mjs');
    await writeFile(script, `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
      const [directory,target,identity,leasePath,boundary]=process.argv.slice(2),original=fs.link;
      const stop=()=>{process.stdout.write('guard-published\\n');setInterval(()=>{},1000);return new Promise(()=>{});};
      fs.link=async(from,to)=>{if(to===leasePath&&boundary==='before')return stop();const value=await original(from,to);if(to===leasePath&&boundary==='after')return stop();return value;};
      syncBuiltinESMExports();const {lockTarget}=await import(${JSON.stringify(new URL('./journal.mjs', import.meta.url).href)});
      await lockTarget(directory,target,{runIdentity:JSON.parse(identity)});`);
    child = spawn(process.execPath, [script, resolve(f.leasePath, '..'), f.scenario.targetId, JSON.stringify(f.runIdentity), f.leasePath, boundary], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise(resolve => child.once('exit', resolve));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('normal_guard_test_timeout')), 10000);
      child.stdout.once('data', bytes => { clearTimeout(timer); bytes.toString().includes('guard-published') ? resolve() : reject(Error('normal_guard_marker_missing')); });
      child.once('exit', code => { clearTimeout(timer); reject(Error(`normal_guard_child_exited_${code}`)); });
    });
    const marker = JSON.parse(await readFile(f.leasePath + '.acquiring/recovery-owner.json'));
    assert.equal(marker.pid, child.pid); assert.deepEqual(marker.runIdentity, f.runIdentity);
    if (boundary === 'before') await assert.rejects(readFile(f.leasePath), { code: 'ENOENT' });
    else { const lease = JSON.parse(await readFile(f.leasePath)); assert.equal(lease.pid, child.pid); assert.deepEqual(lease.runIdentity, f.runIdentity); }
    child.kill('SIGTERM'); await exited;
    const result = await recoverRun({ ...f, signal: signal() });
    assert.equal(result.status, 'CLEANED'); assert.equal(result.recoveredGuardDepth, 1);
  } finally { child?.kill('SIGTERM'); await f.dispose(); }
  }
});
