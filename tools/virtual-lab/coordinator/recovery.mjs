import { mkdir, lstat, readFile, realpath, unlink } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Journal, atomicJSON, sameRunIdentity, sha256, targetLeaseConsumed, targetLeaseHandle } from './journal.mjs';
import { bounded, loadObservations, validateScenario } from './engine.mjs';
import { journalIdentity } from './tool-identity.mjs';
import { acquireGuard, releaseGuard } from './guard.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const appointment = value => typeof value === 'string' && /^appointment_[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(value);
const code = error => /^[a-z_]{1,100}$/.test(error?.message) ? error.message : 'recovery_inspection_failed';
const sameScope = (a, b) => a && b && ['runId', 'workspaceId', 'appointmentRef'].every(key => a[key] === b[key]);
const epoch = value => value?.browserTimeOriginMs + value?.observedAtMonotonicMs;

export function validateRecoveryInspection(value, scenario, observations) {
  if (value?.source !== 'current-native-recovery-observation' || value.executionKind !== scenario.executionKind
      || value.runId !== scenario.runId || value.targetId !== scenario.targetId
      || !Number.isFinite(value.observedAtEpochMs) || Math.abs(Date.now() - value.observedAtEpochMs) > 5000
      || !Number.isSafeInteger(value.observerPendingReplies) || value.observerPendingReplies !== 0
      || !Array.isArray(value.unresolvedOwnedResources) || value.unresolvedOwnedResources.length) throw Error('recovery_resources_unconfirmed');
  const visit = value.currentVisit, native = value.nativeObservation, expectedVisit = observations.create_visit?.visitScope;
  if (visit?.source !== 'normal-native-mount-response' || visit.runId !== scenario.admissionBinding?.runId
      || !uuid(visit.workspaceId) || !appointment(visit.appointmentRef) || expectedVisit && !sameScope(visit, expectedVisit)) throw Error('recovery_current_visit_mismatch');
  if (!sameScope(native, visit) || !uuid(native.sessionId) || !Number.isSafeInteger(native.nativeRevision) || native.nativeRevision < 0
      || !['normal-native-recording-response', 'normal-desktop-recording-response'].includes(native.source)
      || !Number.isFinite(epoch(native)) || Math.abs(Date.now() - epoch(native)) > 15000) throw Error('recovery_native_state_unavailable');
  const desktop = native.source === 'normal-desktop-recording-response';
  if (desktop ? native.pendingMutation !== false : native.busy !== false) throw Error('recovery_native_mutation_pending');
  const admitted = observations.consent?.admission;
  if (admitted && (!sameScope(native, admitted) || native.sessionId !== admitted.sessionId)) throw Error('recovery_session_changed');
  if (value.currentNote && (!sameScope(value.currentNote, visit) || value.currentNote.source !== 'normal-core-note-response'
      || value.currentNote.session_id !== native.sessionId)) throw Error('recovery_note_session_changed');
  return { captureStopped: desktop ? native.phase === 'stopped' && ['uploading', 'processing', 'complete'].includes(native.captureState)
    : native.phase === 'sealed', sessionId: native.sessionId, nativePhase: native.phase };
}

async function privateFile(path, maximum = 32000000) {
  const value = await lstat(path);
  if (!value.isFile() || value.isSymbolicLink() || value.size > maximum) throw Error('recovery_file_identity_invalid');
  return readFile(path);
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw Error('recovery_owner_state_unknown'); }
}

/** Explicit same-run recovery. No historical PID, tab or Appium session is ever
 * passed to the adapter. Its fresh inspection may create only new control
 * handles and read actual native state; recoveryCleanup closes those handles.
 * No steps/perform/reconcile method is called here. */
export async function recoverRun({ scenario, adapter, output, signal, mode = 'cleanup', resumeWithLease, timeoutMs = 30000 }) {
  if (!(signal instanceof AbortSignal) || !['cleanup', 'resume'].includes(mode)
      || mode === 'resume' && typeof resumeWithLease !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) throw Error('invalid_recovery_request');
  signal.throwIfAborted(); validateScenario(scenario);
  const outputCanonical = await realpath(output), runPath = resolve(outputCanonical, 'run.json');
  const before = await privateFile(runPath);
  const identity = await journalIdentity(scenario);
  const runIdentity = { runId: scenario.runId, scenarioSHA256: identity.scenarioSHA256,
    implementationSHA256: identity.implementationSHA256, outputCanonical };
  const journal = await Journal.load(runPath, identity, true, { readOnly: true });
  const observations = await loadObservations(outputCanonical, journal.state);
  if (sha256(await privateFile(runPath)) !== sha256(before)) throw Error('recovery_journal_changed');
  const targetFingerprint = await bounded(() => adapter.lockIdentity(scenario), timeoutMs);
  if (typeof targetFingerprint !== 'string' || !targetFingerprint) throw Error('target_identity_missing');
  const locks = resolve(await realpath(tmpdir()), `scribe-virtual-lab-target-locks-${process.getuid?.() ?? 'user'}`);
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const leasePath = resolve(locks, `${sha256(targetFingerprint)}.lock`), guardPath = leasePath + '.acquiring';
  const attemptId = randomUUID(), attemptPath = resolve(outputCanonical, `recovery.${attemptId}.json`);
  const guard = await acquireGuard(guardPath, { attemptId, pid: process.pid, host: hostname(), runIdentity }, { recoverDeadOwner: true });
  let guardOwned = true, leaseOwned = false, expectedLeaseSHA256, inspectionAccepted = false, analysis, pendingUnsettled = false;
  const result = { schema: 1, attemptId, mode, executionKind: scenario.executionKind, runIdentity,
    runJournalSHA256: sha256(before), targetFingerprintSHA256: sha256(targetFingerprint),
    recoveredGuardDepth: guard.depth,
    startedAt: new Date().toISOString(), status: 'BLOCKED', targetLeaseRetained: true, nativeAppTerminated: false };
  const pending = new Set();
  async function tracked(operation, cleanup = false) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (!cleanup) { signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) controller.abort(); }
    const item = { controller };
    item.promise = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation(controller.signal); }); pending.add(item);
    item.promise.then(() => {}, () => {}).finally(() => { pending.delete(item); signal.removeEventListener('abort', abort); });
    return bounded(() => item.promise, timeoutMs, abort);
  }
  async function assertLeaseUnchanged() {
    if (sha256(await privateFile(leasePath, 65536)) !== expectedLeaseSHA256) throw Error('recovery_lease_changed');
  }
  async function writeLease(owner) { await atomicJSON(leasePath, owner); expectedLeaseSHA256 = sha256(await privateFile(leasePath, 65536)); leaseOwned = true; }
  async function removeGuard() {
    if (!guardOwned) return;
    await releaseGuard(guard); guardOwned = false;
  }
  let owner, preflight, inspection, cleanup;
  try {
    let prior;
    try { prior = JSON.parse(await privateFile(leasePath, 65536)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (prior) {
      if (prior.host !== hostname() || !Number.isSafeInteger(prior.pid) || prior.pid <= 0 || !uuid(prior.token)) throw Error('recovery_lease_owner_invalid');
      if (processAlive(prior.pid)) throw Error('recovery_owner_still_alive');
      if (!sameRunIdentity(prior.runIdentity, runIdentity)) throw Error('recovery_lease_run_mismatch');
      result.previousLeaseSHA256 = sha256(await privateFile(leasePath, 65536));
    }
    owner = prior ?? { pid: process.pid, host: hostname(), token: randomUUID(), runIdentity };
    // A crash from this point onward must retain quarantine, including a run
    // whose earlier cleanup removed its original lease.
    await writeLease({ ...owner, uncertain: true });
    preflight = await tracked(active => adapter.doctor(scenario, { signal: active }));
    result.preflight = preflight;
    if (preflight?.ready !== true || preflight.targetId !== scenario.targetId || preflight.executionKind !== scenario.executionKind) throw Error('recovery_preflight_failed');
    if (typeof adapter.recoveryInspect !== 'function') throw Error('recovery_inspector_required');
    inspection = await tracked(active => adapter.recoveryInspect({ scenario, state: journal.state, observations, output: outputCanonical, signal: active }));
    result.inspection = inspection;
    await atomicJSON(attemptPath, result);
    analysis = validateRecoveryInspection(inspection, scenario, observations); inspectionAccepted = true;
    result.capture = analysis;
  } catch (error) { result.failureCode = signal.aborted ? 'recovery_aborted' : code(error); }
  finally {
    if (leaseOwned) {
      for (const item of pending) item.controller.abort();
      const hadPending = pending.size > 0;
      try {
        if (typeof adapter.recoveryCleanup !== 'function') throw Error('recovery_cleanup_required');
        const preserveForRecovery = mode === 'resume' || !analysis?.captureStopped;
        cleanup = await tracked(active => adapter.recoveryCleanup({ signal: active, preserveForRecovery }), true);
        await bounded(() => Promise.allSettled([...pending].map(item => item.promise)), timeoutMs);
        if (hadPending && pending.size === 0) cleanup = await tracked(active => adapter.recoveryCleanup({ signal: active, preserveForRecovery }), true);
      } catch (error) { result.failureCode ??= code(error); }
      pendingUnsettled = pending.size > 0;
      result.cleanup = cleanup;
      result.pendingRecoveryOperations = pending.size;
      if (cleanup?.ownedResourcesSettled !== true || cleanup.nativeAppTerminated !== false || pendingUnsettled) {
        result.failureCode ??= 'recovery_cleanup_unconfirmed'; inspectionAccepted = false;
      }
    }
  }
  try {
    if (signal.aborted) result.failureCode ??= 'recovery_aborted';
    if (inspectionAccepted && !result.failureCode && !signal.aborted) {
      await assertLeaseUnchanged();
      if (sha256(await privateFile(runPath)) !== result.runJournalSHA256) throw Error('recovery_journal_changed');
      if (mode === 'cleanup') {
        if (analysis.captureStopped) { await unlink(leasePath); result.targetLeaseRetained = false; result.status = 'CLEANED'; }
        else result.status = 'CLEANED_CAPTURE_PRESERVED';
      } else {
        const next = { pid: process.pid, host: hostname(), token: randomUUID(), runIdentity, uncertain: true,
          recoveryAttemptId: attemptId, recoveryInspectionSHA256: sha256(JSON.stringify(inspection)) };
        await writeLease(next);
        const lease = targetLeaseHandle(leasePath, next, targetFingerprint);
        await removeGuard();
        // The engine consumes this opaque same-process capability, rechecks
        // identity, then reconciles the pending action without replaying it.
        try {
          const resumed = await resumeWithLease(lease);
          if (!targetLeaseConsumed(lease)) throw Error('recovery_resume_lease_not_consumed');
          result.resumeStatus = resumed?.status;
          try { await lstat(leasePath); throw Error('recovery_resume_lease_unsettled'); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          result.targetLeaseRetained = false; result.status = 'RESUMED';
        } catch (error) {
          result.status = 'RESUME_FAILED'; result.failureCode = code(error);
          try { await lstat(leasePath); } catch (missing) { if (missing.code === 'ENOENT') result.targetLeaseRetained = false; }
        }
      }
    }
  } catch (error) { result.failureCode = code(error); result.status = 'BLOCKED'; }
  finally {
    // An unsettled late factory/transport keeps the guard as well as quarantine.
    // Its owner marker makes that condition inspectable; no blind stale unlink.
    if (guardOwned && !pendingUnsettled) await removeGuard();
    result.recoveryGuardRetained = guardOwned;
    result.finishedAt = new Date().toISOString();
    await atomicJSON(attemptPath, result);
  }
  return result;
}
