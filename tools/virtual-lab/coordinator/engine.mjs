import { mkdir, realpath, lstat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve, basename } from 'node:path';
import { ACTIONS, atomicJSON, consumeTargetLease, Journal, lockTarget, sha256 } from './journal.mjs';
import { implementationReceipt, journalIdentity } from './tool-identity.mjs';
import { publishExclusiveJSON } from './guard.mjs';
import { closedLifecycleProvesStopped } from './closed-lifecycle.mjs';

export const JOURNEY = ACTIONS;
export const ENGINEERING_BUDGETS = Object.freeze({ coldLaunchMs: 10000, warmLaunchMs: 3000,
  workspaceMs: 10000, preparationMs: 15000, recordReadyMs: 3000 });
// Provisional engineering goals, fixed before runs: short interactive feedback for
// warm/Record paths; bounded cold setup/network work. They are not user-agreed SLAs.
// 3s Record is stricter than the historical single 4185.9ms sample; that sample is
// not a valid current baseline. Native timestamp comparison is a separate gate.

export async function bounded(operation, milliseconds, abort) {
  let timer;
  const task = Promise.resolve().then(operation);
  try { return await Promise.race([task, new Promise((_, reject) => {
    timer = setTimeout(() => { abort?.(); const error = Error('operation_timeout');
      error.pendingWork = task.then(() => undefined, () => undefined); reject(error); }, milliseconds);
  })]); } finally { clearTimeout(timer); }
}

export function validateScenario(scenario) {
  if (scenario.schema !== 1 || scenario.syntheticOnly !== true || !/^[a-z][a-z0-9-]{2,80}$/.test(scenario.runId)
      || !['fixed', 'adaptive'].includes(scenario.mode) || !['live', 'mock'].includes(scenario.executionKind)) throw Error('invalid_scenario');
  if (scenario.executionKind === 'live') {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if (!/^[a-f0-9]{64}$/.test(scenario.adapterSHA256 ?? '') || !uuid.test(scenario.admissionBinding?.runId ?? '')
        || scenario.admissionBinding?.workspaceId !== undefined && !uuid.test(scenario.admissionBinding.workspaceId)
        || scenario.admissionBinding?.appointmentRef !== undefined && !/^appointment_[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(scenario.admissionBinding.appointmentRef)) throw Error('missing_live_admission_identity');
  }
  if (!scenario.targetId || !/^[a-f0-9]{40}$/.test(scenario.sourceSHA) || !scenario.build?.bundleId
      || !scenario.build?.number || !/^[a-f0-9]{64}$/.test(scenario.build?.sha256)) throw Error('missing_build_identity');
  if (!Array.isArray(scenario.personas) || scenario.personas.length < 2
      || new Set(scenario.personas.map(p => p.id)).size !== scenario.personas.length
      || new Set(scenario.personas.map(p => p.profile)).size !== scenario.personas.length) throw Error('personas_not_isolated');
  if (!scenario.fixture?.sha256 || !/^[a-f0-9]{64}$/.test(scenario.fixture.sha256)) throw Error('fixture_not_frozen');
  if (scenario.mode === 'adaptive' && !/^[a-f0-9]{64}$/.test(scenario.fixture.truthSHA256 ?? '')) throw Error('adaptive_truth_not_archived');
  if (scenario.timeoutMs !== undefined && (!Number.isInteger(scenario.timeoutMs) || scenario.timeoutMs < 1000 || scenario.timeoutMs > 900000)) throw Error('invalid_deadline');
  return scenario;
}

/** UI adapters return observations, not a caller-supplied passed flag. */
export function assertObservation(action, observation, scenario) {
  if (!observation || observation.origin !== 'product-ui' || observation.targetId !== scenario.targetId
      || observation.action !== action || observation.executionKind !== scenario.executionKind
      || !Number.isFinite(observation.observedAtEpochMs) || Math.abs(Date.now() - observation.observedAtEpochMs) > 5000
      || !Array.isArray(observation.checks) || observation.checks.length === 0) throw Error('invalid_observation');
  for (const check of observation.checks) {
    if (!check.locator || !['text', 'attribute', 'visible', 'count', 'audio-clock'].includes(check.kind)
        || !Object.hasOwn(check, 'actual') || !Object.hasOwn(check, 'expected') || check.expected === undefined
        || check.actual !== check.expected) throw Error('ui_assertion_failed');
  }
  if (['record', 'play_source'].includes(action) && (!/^[a-f0-9]{64}$/.test(observation.consentReceiptSHA256 ?? '')
      || !Number.isFinite(observation.elapsedSeconds) || observation.elapsedSeconds < 0 || observation.nativeState !== 'recording')) throw Error('native_recording_not_observed');
  if (action === 'play_source' && (observation.fixtureSHA256 !== scenario.fixture.sha256
      || observation.sourceState !== 'ended' || !Number.isSafeInteger(observation.completedSourceFrames)
      || observation.completedSourceFrames <= 0)) throw Error('source_completion_not_observed');
  // Only metadata and digests enter the journal. Synthetic text/screenshots remain
  // in private evidence files, never in stdout, actions or Git history.
  return { observationSHA256: sha256(JSON.stringify(observation)), checks: observation.checks.length,
    observedAtEpochMs: observation.observedAtEpochMs, ...(observation.elapsedSeconds !== undefined ? { elapsedSeconds: observation.elapsedSeconds } : {}) };
}

/** Restore only exact, immutable private objects bound by observed-action events.
 * Historical timestamps are not treated as fresh UI observations. */
export async function loadObservations(output, state) {
  const observations = {};
  for (const event of state.events.filter(e => e.kind === 'action_observed')) {
    const evidence = event.evidence, file = evidence?.observationFile;
    if (typeof file !== 'string' || basename(file) !== file || !file.startsWith(`${event.action}.`)
        || !file.endsWith('.observation.json') || !/^[a-f0-9]{64}$/.test(evidence?.observationSHA256 ?? '')) throw Error('observation_integrity_failed');
    const path = resolve(output, file);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32000000) throw Error('observation_integrity_failed');
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (sha256(JSON.stringify(value)) !== evidence.observationSHA256 || value.action !== event.action
          || value.origin !== 'product-ui' || value.executionKind !== state.identity.executionKind) throw Error('observation_integrity_failed');
      observations[event.action] = value;
    } catch { throw Error('observation_integrity_failed'); }
  }
  return observations;
}

/** Resource shutdown and capture settlement are separate facts. A receipt read
 * during this cleanup may justify release only for the exact admitted session. */
export function nativeCleanupProvesStopped(proof, scenario, observations, notBeforeEpochMs) {
  if (proof?.closedLifecycle) return proof.source === 'current-native-cleanup-observation' && proof.executionKind === 'live'
    && proof.runId === scenario.runId && proof.targetId === scenario.targetId
    && Number.isFinite(notBeforeEpochMs) && proof.observedAtEpochMs >= notBeforeEpochMs
    && proof.observedAtEpochMs <= Date.now() + 50 && closedLifecycleProvesStopped(proof, scenario, observations);
  const admitted = observations.consent?.admission, visit = proof?.currentVisit, native = proof?.nativeObservation;
  const fields = ['runId', 'workspaceId', 'appointmentRef', 'sessionId'];
  if (!Number.isFinite(notBeforeEpochMs) || proof?.source !== 'current-native-cleanup-observation' || proof.executionKind !== 'live'
      || proof.runId !== scenario.runId || proof.targetId !== scenario.targetId || !admitted
      || admitted.source !== 'normal-native-admission-response' || admitted.runId !== scenario.admissionBinding?.runId
      || !Number.isFinite(proof.observedAtEpochMs) || proof.observedAtEpochMs < notBeforeEpochMs
      || proof.observedAtEpochMs > Date.now() + 50 || proof.observerPendingReplies !== 0
      || visit?.source !== 'normal-native-mount-response'
      || fields.slice(0,3).some(key => !admitted[key] || visit[key] !== admitted[key])
      || fields.some(key => !admitted[key] || native?.[key] !== admitted[key])
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(native?.recorderId ?? '')
      || !Number.isSafeInteger(native.nativeRevision) || native.nativeRevision < 0
      || !Number.isFinite(native.observedAtMonotonicMs) || !Number.isFinite(native.browserTimeOriginMs)
      || Math.abs(proof.observedAtEpochMs - native.browserTimeOriginMs - native.observedAtMonotonicMs) > 15000) return false;
  for (const prior of [observations.record?.nativeObservation, observations.finish?.nativeTerminal].filter(Boolean)) {
    if (prior.source !== native.source || prior.recorderId !== native.recorderId || fields.some(key => prior[key] !== native[key])
        || !Number.isSafeInteger(prior.nativeRevision) || prior.nativeRevision > native.nativeRevision) return false;
  }
  return native.source === 'normal-native-recording-response' ? native.busy === false && native.phase === 'sealed'
    : native.source === 'normal-desktop-recording-response' && native.pendingMutation === false && native.phase === 'stopped'
      && ['uploading', 'processing', 'complete'].includes(native.captureState);
}

export const validNativeCleanupProof = (proof, { scenario, observations, captureProofAtOrAfterEpochMs }) =>
  nativeCleanupProvesStopped(proof, scenario, observations, captureProofAtOrAfterEpochMs);

function recordedFinishMatches(observations, state) {
  const admitted = observations.consent?.admission, terminal = observations.finish?.nativeTerminal;
  return state?.completed.includes('finish') && admitted && terminal
    && ['runId', 'workspaceId', 'appointmentRef', 'sessionId'].every(key => admitted[key] && terminal[key] === admitted[key])
    && Number.isSafeInteger(terminal.nativeRevision) && terminal.nativeRevision >= 0
    && Number.isFinite(terminal.observedAtMonotonicMs) && Number.isFinite(terminal.browserTimeOriginMs)
    && (terminal.source === 'normal-native-recording-response' ? terminal.phase === 'sealed' && terminal.busy === false
      : terminal.source === 'normal-desktop-recording-response' && terminal.phase === 'stopped' && terminal.pendingMutation === false
        && ['uploading', 'processing', 'complete'].includes(terminal.captureState));
}

export async function runJourney({ scenario, adapter, output, labRoot = process.env.SCRIBE_LAB_ROOT, resume = false, stopAfter, signal, preacquiredLease }) {
  signal?.throwIfAborted();
  validateScenario(scenario);
  if (!labRoot) throw Error('canonical_lab_root_required');
  await realpath(labRoot);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const identity = await journalIdentity(scenario);
  const runIdentity = { runId: identity.runId, scenarioSHA256: identity.scenarioSHA256,
    implementationSHA256: identity.implementationSHA256, outputCanonical: await realpath(output) };
  const targetFingerprint = await bounded(() => adapter.lockIdentity(scenario), 30000);
  if (typeof targetFingerprint !== 'string' || !targetFingerprint) throw Error('target_identity_missing');
  // All runs by this OS user share target ownership, even with different lab or
  // output roots. The fingerprint comes from verified host/device/app identity.
  const locks = resolve(await realpath(tmpdir()), `scribe-virtual-lab-target-locks-${process.getuid?.() ?? 'user'}`);
  if (preacquiredLease && !resume) throw Error('recovery_requires_resume');
  const runPath = resolve(output, 'run.json');
  if (!resume) {
    // A crash must never leave a target lease whose run has no durable journal.
    // Exclusive publication cannot overwrite an existing or concurrent run.
    const initial = await Journal.load(runPath, identity, false, { readOnly: true });
    try { await publishExclusiveJSON(runPath, initial.state); }
    catch (error) { if (error.code === 'EEXIST') throw Error('run_exists_use_resume'); throw error; }
  }
  const release = await consumeTargetLease(preacquiredLease ?? await lockTarget(locks, targetFingerprint, { runIdentity }), targetFingerprint, runIdentity);
  let journal, outcome, failure, observations = {};
  const pending = new Set(), deadline = scenario.timeoutMs ?? 600000;
  async function tracked(name, operation, milliseconds) {
    const controller = new AbortController();
    const linkAbort = () => controller.abort();
    const parent = ['cleanup', 'cleanup_confirm', 'failure_artifact'].includes(name) ? null : signal;
    parent?.addEventListener('abort', linkAbort, { once: true });
    if (parent?.aborted) controller.abort();
    const work = { name, controller, settled: false };
    work.promise = Promise.resolve().then(() => operation(controller.signal));
    pending.add(work);
    work.promise.then(() => {}, () => {}).finally(() => { work.settled = true; pending.delete(work); parent?.removeEventListener('abort', linkAbort); });
    return bounded(() => work.promise, milliseconds, () => controller.abort());
  }
  async function observe(action, operation) {
    const observation = await operation();
    const observationFile = `${action}.${randomUUID()}.observation.json`;
    // Preserve a failed assertion's actual observation as well as successful ones.
    // Unique names prevent reconciliation from overwriting previous failure data.
    await atomicJSON(resolve(output, observationFile), observation ?? { missingObservation: true });
    const evidence = assertObservation(action, observation, scenario);
    observations[action] = observation;
    return { ...evidence, observationFile };
  }
  try {
    journal = await Journal.load(runPath, identity, true);
    const implementation = await implementationReceipt();
    if (implementation.sha256 !== identity.implementationSHA256) throw Error('tool_implementation_changed');
    await atomicJSON(resolve(output, `implementation.${implementation.sha256}.json`), implementation);
    observations = await loadObservations(output, journal.state);
    const preflight = await tracked('doctor', signal => adapter.doctor(scenario, { signal }), Math.min(deadline, 30000));
    const preflightFile = `preflight.${randomUUID()}.json`;
    await atomicJSON(resolve(output, preflightFile), preflight);
    if (preflight.targetId !== scenario.targetId || preflight.executionKind !== scenario.executionKind || preflight.ready !== true) throw Error('preflight_blocked');
    await journal.event('preflight', { evidenceSHA256: sha256(JSON.stringify(preflight)), evidenceFile: preflightFile, budgets: ENGINEERING_BUDGETS });
    await tracked('connect', signal => adapter.connect(scenario, { signal, output: runIdentity.outputCanonical }), Math.min(deadline, 180000));
    if (adapter.restore) await tracked('restore', signal => adapter.restore(journal.state, { output, signal, observations }), Math.min(deadline, 30000));
    if (journal.state.pending) {
      const action = journal.state.pending;
      const evidence = await tracked('reconcile', signal => observe(action, () => adapter.reconcile(action, scenario, { signal })), Math.min(deadline, 30000));
      await journal.finish(action, evidence);
    }
    for (const action of JOURNEY) {
      signal?.throwIfAborted();
      if (journal.state.completed.includes(action)) continue;
      await journal.begin(action);
      const evidence = await tracked(action, signal => observe(action, () => adapter.perform(action, scenario, signal)), deadline);
      await journal.finish(action, evidence);
      if (stopAfter === action) { outcome = 'PAUSED'; break; }
    }
    outcome ??= scenario.executionKind === 'live' ? 'UI_JOURNEY_PASS' : 'MOCK_JOURNEY_PASS';
  } catch (error) {
    failure = error;
    if (pending.size) await release.quarantine();
    if (journal) {
      journal.state.status = error.message === 'preflight_blocked' ? 'BLOCKED' : 'FAIL';
      await journal.event('failure', { code: /^[a-z_]{1,80}$/.test(error.message) ? error.message : 'adapter_failure' });
      if (adapter.failureArtifact) {
        try { await tracked('failure_artifact', signal => adapter.failureArtifact(resolve(output, 'failure'), { signal }), Math.min(deadline, 10000)); }
        catch { /* Diagnostics cannot erase the original failure. */ }
      }
    }
  } finally {
    // A process exit during cleanup must leave an uncertain lease, not a
    // reclaimable dead-PID lock over potentially active native work.
    await release.quarantine();
    const cleanupDeadline = Math.min(deadline, 30000), hadPending = pending.size > 0;
    for (const work of pending) work.controller.abort();
    const captureMayBeActive = scenario.executionKind === 'live' && Boolean(journal?.state.events.some(event => event.kind === 'action_started' && event.action === 'record'));
    let cleanup, cleanupAccepted = false, drained = false, captureProofAtOrAfterEpochMs;
    try {
      if (typeof adapter.cleanup !== 'function') throw Error('cleanup_missing');
      const preserveForRecovery = Boolean(failure) || !['UI_JOURNEY_PASS', 'MOCK_JOURNEY_PASS'].includes(outcome);
      captureProofAtOrAfterEpochMs = Date.now();
      cleanup = await tracked('cleanup', signal => adapter.cleanup({ signal, preserveForRecovery, captureMayBeActive, captureProofAtOrAfterEpochMs }), cleanupDeadline);
      cleanupAccepted = cleanup?.ownedResourcesSettled === true;
      if (!cleanupAccepted) throw Error('cleanup_unconfirmed');
      await bounded(() => Promise.allSettled([...pending].map(work => work.promise)), cleanupDeadline);
      drained = pending.size === 0;
      // Reinspect cleanup after any late adapter call has returned. A snapshot
      // taken before a late connect/restore mutation cannot release ownership.
      if (hadPending && drained) {
        captureProofAtOrAfterEpochMs = Date.now();
        cleanup = await tracked('cleanup_confirm', signal => adapter.cleanup({ signal, preserveForRecovery, captureMayBeActive, captureProofAtOrAfterEpochMs }), cleanupDeadline);
        cleanupAccepted = cleanup?.ownedResourcesSettled === true;
        drained = pending.size === 0;
      }
    } catch { cleanupAccepted = false; }
    const settled = cleanupAccepted && drained && pending.size === 0;
    const captureSafe = !captureMayBeActive || nativeCleanupProvesStopped(cleanup?.nativeCaptureProof, scenario, observations, captureProofAtOrAfterEpochMs)
      && (outcome !== 'UI_JOURNEY_PASS' || recordedFinishMatches(observations, journal?.state));
    await atomicJSON(resolve(output, 'cleanup.json'), { ...(cleanup ?? {}), ownedResourcesSettled: settled,
      nativeCaptureSafeToRelease: Boolean(captureSafe),
      enginePendingOperations: [...pending].map(work => work.name), targetLeaseRetained: !settled || !captureSafe });
    if (settled && captureSafe) await release();
    else if (settled) {
      await release.quarantine();
      if (journal) await journal.event('capture_quarantined', { targetLeaseRetained: true, resourcesSettled: true });
      // A deliberate pause is still resumable. A previous failure keeps its
      // original cause; only a claimed completed journey gains a new failure.
      if (!failure && outcome === 'UI_JOURNEY_PASS') {
        failure = Error('native_capture_release_unconfirmed');
        journal.state.status = 'FAIL'; await journal.event('failure', { code: failure.message });
      }
    }
    else {
      await release.quarantine();
      if (journal) { journal.state.status = 'FAIL'; await journal.event('cleanup_uncertain', { targetLeaseRetained: true }); }
      failure ??= Error('cleanup_uncertain');
    }
  }
  if (failure) throw failure;
  journal.state.status = outcome;
  await journal.save();
  return journal.state;
}
