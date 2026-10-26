import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from './journal.mjs';
import { publishExclusiveJSON } from './guard.mjs';
import { readRetainedAdmission } from './retained-admission.mjs';

const prior = ['sign_in', 'workspace', 'create_visit', 'prepare', 'consent'];
const scopeKeys = ['runId', 'workspaceId', 'appointmentRef', 'sessionId'];
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b, keys) => a && b && keys.every(key => a[key] !== undefined && a[key] === b[key]);
const need = (ok, code) => { if (!ok) throw Error(code); };
const timestamp = value => value.browserTimeOriginMs + value.observedAtMonotonicMs;

export function validateRecordRecoveryReview(review, evidence, now = Date.now()) {
  need(review?.schema === 1 && review.status === 'APPROVED_FIRST_RECORD_AFTER_PRE_DISPATCH_FAILURE'
    && review.failureBoundary === 'before-first-record-input' && hash(review.independentReviewSHA256)
    && Number.isFinite(review.issuedAtEpochMs) && Number.isFinite(review.expiresAtEpochMs)
    && review.issuedAtEpochMs <= now && now < review.expiresAtEpochMs
    && review.expiresAtEpochMs - review.issuedAtEpochMs <= 900000, 'record_recovery_review_required');
  for (const key of ['journal', 'operator', 'failure', 'cleanup', 'intent', 'lease'])
    need(hash(review[`${key}SHA256`]) && sha256(evidence[key]) === review[`${key}SHA256`], 'record_recovery_evidence_changed');
  const journal = JSON.parse(evidence.journal), failure = JSON.parse(evidence.failure);
  const cleanup = JSON.parse(evidence.cleanup), intent = JSON.parse(evidence.intent);
  const leaseOwner = JSON.parse(evidence.lease);
  need(journal.identity?.runId === review.runId && journal.status === 'FAIL' && journal.pending === 'record'
    && JSON.stringify(journal.completed) === JSON.stringify(prior)
    && hash(journal.identity.implementationSHA256), 'record_recovery_pending_state_changed');
  // Hash-chain validation is additionally performed by the original Journal.
  const tail = journal.events?.slice(-3);
  need(tail?.length === 3 && tail[0].kind === 'action_started' && tail[0].action === 'record'
    && tail[1].kind === 'failure' && tail[1].code === review.failureCode
    && tail[2].kind === 'capture_quarantined' && tail[2].resourcesSettled === true
    && tail[2].targetLeaseRetained === true
    && journal.events.filter(e => e.kind === 'action_started' && e.action === 'record').length === 1
    && !journal.events.some(e => e.kind === 'action_observed' && !prior.includes(e.action)), 'record_recovery_not_first_dispatch');
  need(review.failureCode === 'admission_not_observed' && failure.code === review.failureCode
    && failure.status === 'FAIL_RETAIN_ACTUAL_JOURNAL_AND_CLEANUP' && failure.runId === review.runId
    && intent.runId === review.runId && Number.isSafeInteger(intent.pid) && intent.pid > 0,
  'record_recovery_failure_unconfirmed');
  need(leaseOwner.pid === intent.pid && leaseOwner.uncertain === true
    && typeof leaseOwner.host === 'string' && typeof leaseOwner.token === 'string'
    && leaseOwner.runIdentity?.runId === review.runId
    && leaseOwner.runIdentity.implementationSHA256 === journal.identity.implementationSHA256,
  'record_recovery_lease_unconfirmed');
  need(cleanup.ownedResourcesSettled === true && cleanup.nativeAppTerminated === false
    && cleanup.appiumSessionClosed === true && cleanup.observer?.observerRetainedForRecovery === true
    && cleanup.uncertainNativeMutationCount === 0 && cleanup.inputSafetyUncertain === false
    && cleanup.observerInstallationUncertain === false && Array.isArray(cleanup.enginePendingOperations)
    && cleanup.enginePendingOperations.length === 0
    && cleanup.source?.ownedResourcesSettled === true && cleanup.source.sourceOperationsSettled === true
    && cleanup.source.sourceEvidence?.captureTiming === 'NOT_RUN'
    && Array.isArray(cleanup.source.sourceEvidence.phases) && cleanup.source.sourceEvidence.phases.length === 0,
  'record_recovery_old_resources_unsettled');
  const baseline = cleanup.nativeCaptureProof;
  need(baseline?.source === 'current-native-cleanup-observation' && baseline.executionKind === 'live'
    && baseline.runId === review.runId && baseline.targetId === review.targetId,
  'record_recovery_old_native_missing');
  validateUntouchedRecorder(baseline, baseline, baseline.observedAtEpochMs);
  need(review.process && Number.isSafeInteger(review.process.pid) && review.process.pid > 0
    && typeof review.process.start === 'string' && review.process.start.length > 0
    && isAbsolute(review.process.executable ?? '') && hash(review.process.bundleSHA256)
    && hash(review.process.hardwareUUIDSHA256) && hash(review.accountIdentitySHA256), 'record_recovery_process_unbound');
  return { journal, baseline, leaseOwner, previousOwnerPid: intent.pid };
}

export function validateUntouchedRecorder(proof, baseline, now = Date.now()) {
  const native = proof?.nativeObservation, before = baseline?.nativeObservation;
  need(proof?.closedLifecycle === null && proof.observerPendingReplies === 0
    && same(proof.currentVisit, baseline.currentVisit, ['runId', 'workspaceId', 'appointmentRef', 'revision', 'requestId'])
    && same(native, before, [...scopeKeys, 'recorderId'])
    && native.source === 'normal-native-recording-response' && native.phase === 'ready' && native.busy === false
    && native.recordedChunks === 0 && native.recordedPlaintextBytes === 0 && native.capturedAudioFrames === 0
    && native.signal === null && native.nativeTiming?.version === 1 && native.nativeTiming.clock === 'dispatch-uptime-ns'
    && native.nativeTiming.captureAttempt === 0 && native.nativeTiming.droppedEvents === 0
    && Number.isSafeInteger(native.nativeRevision) && native.nativeRevision >= before.nativeRevision
    && Number.isFinite(timestamp(native)) && Math.abs(now - timestamp(native)) <= 15000,
  'record_recovery_native_not_untouched');
  need(proof.observers?.desktop === null && baseline.observers?.desktop === null, 'record_recovery_observers_changed');
  for (const kind of ['visit', 'admission']) {
    const current = proof.observers?.[kind], old = baseline.observers?.[kind];
    need(current && old && hash(current.observerSHA256) && current.observerSHA256 === old.observerSHA256
      && current.runId === native.runId && old.runId === native.runId && current.pendingObservedReplies === 0,
    'record_recovery_observers_changed');
  }
  return native;
}

function checkTarget(value, review, previousOwnerPid, session) {
  need(value?.source === 'current-owned-record-recovery-target' && Number.isFinite(value.observedAtEpochMs)
    && Math.abs(Date.now() - value.observedAtEpochMs) <= 5000
    && same(value.process, review.process, ['pid', 'start', 'executable', 'bundleSHA256', 'hardwareUUIDSHA256'])
    && value.previousOwnerPid === previousOwnerPid && value.previousOwnerAbsent === true
    && value.controlSessionId === (session ?? null)
    && Array.isArray(value.foreignControlSessions) && value.foreignControlSessions.length === 0
    && Array.isArray(value.activeInputClients) && value.activeInputClients.length === 0
    && Array.isArray(value.unresolvedOwnedSourceProcesses) && value.unresolvedOwnedSourceProcesses.length === 0,
  'record_recovery_target_changed');
}

async function privateBytes(path, maximum = 32000000) {
  const info = await lstat(path);
  need(info.isFile() && !info.isSymbolicLink() && info.size <= maximum, 'record_recovery_file_invalid');
  return readFile(path);
}

/** Explicit reviewed recovery, never called by ordinary run/resume. The frozen
 * runtime remains authoritative for its journal/lease. Review of the actual
 * operator control flow establishes the old failure preceded input; counters
 * alone are insufficient. Callbacks provide independently reviewed target and
 * current speech-scope checks, not consent. All actual UI/source gates remain
 * in the original AppiumUI.perform implementation. */
export async function recoverFirstRecord({ runtimeRoot, output, configPath, scenario, labRoot, reviewPath,
  evidencePaths, signal, inspectTarget, beforeRecord }) {
  need(signal instanceof AbortSignal && typeof inspectTarget === 'function' && typeof beforeRecord === 'function',
    'record_recovery_contract_required');
  signal.throwIfAborted();
  output = await realpath(output); runtimeRoot = await realpath(runtimeRoot);
  const reviewBytes = await privateBytes(reviewPath, 65536), review = JSON.parse(reviewBytes);
  const evidence = {};
  for (const key of ['journal', 'operator', 'failure', 'cleanup', 'intent', 'lease']) evidence[key] = await privateBytes(evidencePaths[key]);
  const checked = validateRecordRecoveryReview(review, evidence);
  const checkReview = async () => {
    signal.throwIfAborted(); validateRecordRecoveryReview(review, evidence);
    need(sha256(await privateBytes(reviewPath, 65536)) === sha256(reviewBytes), 'record_recovery_review_changed');
  };
  need(scenario.executionKind === 'live' && scenario.runId === review.runId && scenario.targetId === review.targetId,
    'record_recovery_scenario_changed');
  need(sha256(await privateBytes(resolve(output, 'run.json'))) === review.journalSHA256, 'record_recovery_journal_changed');
  const load = name => import(pathToFileURL(resolve(runtimeRoot, 'coordinator', name)).href);
  const [{ AppiumUI }, { recoverRun }, { runJourney }, identity, journalAPI] = await Promise.all([
    load('appium-ui.mjs'), load('recovery.mjs'), load('engine.mjs'), load('tool-identity.mjs'), load('journal.mjs')]);
  need((await identity.implementationReceipt()).sha256 === checked.journal.identity.implementationSHA256,
    'record_recovery_runtime_changed');
  await journalAPI.Journal.load(resolve(output, 'run.json'), await identity.journalIdentity(scenario), true, { readOnly: true });
  await checkReview(); checkTarget(await inspectTarget({ signal, session: null }), review, checked.previousOwnerPid, null);
  let lease, dispatched = false, inputBoundaryConsumed = false;
  class Inspection extends AppiumUI {
    async recoveryInspect(options) {
      const owner = JSON.parse(await privateBytes(options.recoveryAuthority.leasePath, 65536));
      need(JSON.stringify(owner) === JSON.stringify(checked.leaseOwner), 'record_recovery_lease_changed');
      const result = await super.recoveryInspect(options);
      validateUntouchedRecorder(result, checked.baseline);
      checkTarget(await inspectTarget({ signal: options.signal, session: this.session }), review, checked.previousOwnerPid, this.session);
      return result;
    }
  }
  class Continuation extends AppiumUI {
    async perform(action, currentScenario, active) {
      if (action === 'reopen') {
        // A normal Save may hand off to the dashboard. Activate only the same
        // retained application; a missing app never authorizes a new launch.
        checkTarget(await inspectTarget({ signal: active, session: this.session }), review, checked.previousOwnerPid, this.session);
        const options = { bundleId: this.config.app.bundleId };
        const state = await this.request('/execute/sync', 'POST', { script: 'mobile: queryAppState', args: [options] }, active);
        need([2, 3, 4].includes(state), 'saved_native_app_not_running');
        if (state !== 4) await this.request('/execute/sync', 'POST', { script: 'mobile: activateApp', args: [options] }, active);
        need(await this.request('/execute/sync', 'POST', { script: 'mobile: queryAppState', args: [options] }, active) === 4,
          'saved_native_app_not_foreground');
        checkTarget(await inspectTarget({ signal: active, session: this.session }), review, checked.previousOwnerPid, this.session);
      }
      return super.perform(action, currentScenario, active);
    }
    async restore(state, options) {
      need(state.pending === 'record' && JSON.stringify(state.completed) === JSON.stringify(prior)
        && JSON.stringify(state.events.slice(0, checked.journal.events.length)) === JSON.stringify(checked.journal.events),
      'record_recovery_journal_changed');
      await super.restore(state, options);
    }
    async proveReady(active) {
      const started = performance.now();
      active = AbortSignal.any([active, AbortSignal.timeout(2000)]);
      await checkReview(); active.throwIfAborted();
      const auth = await this.readAuth(active), visit = await this.assertVisit(active);
      const retained = await readRetainedAdmission(this, active), snapshot = await this.captureStateSnapshot(active);
      const native = validateUntouchedRecorder(snapshot, checked.baseline);
      need(auth.phase === 'ready' && auth.source === 'normal-native-auth-response'
        && auth.identitySHA256 === review.accountIdentitySHA256 && auth.revision === checked.baseline.currentVisit.revision
        && Number.isFinite(timestamp(auth)) && Math.abs(Date.now() - timestamp(auth)) <= 15000
        && same(visit, checked.baseline.currentVisit, ['runId', 'workspaceId', 'appointmentRef', 'revision', 'requestId'])
        && same(retained.admission, native, scopeKeys) && retained.admission.revision === auth.revision
        && same(retained.native, native, [...scopeKeys, 'recorderId']) && retained.native.nativeRevision <= native.nativeRevision,
      'record_recovery_current_consent_changed');
      checkTarget(await inspectTarget({ signal: active, session: this.session }), review, checked.previousOwnerPid, this.session);
      await beforeRecord({ signal: active, admission: retained.admission, native });
      active.throwIfAborted(); await checkReview();
      active.throwIfAborted();
      need(performance.now() - started <= 2000, 'record_recovery_proof_expired');
      return { admissionEvidence: retained.admissionEvidence, admission: retained.admission, native };
    }
    async reconcile(action, currentScenario, { signal: active }) {
      need(action === 'record' && !dispatched && journalAPI.targetLeaseConsumed(lease), 'record_recovery_not_authorized');
      const proof = await this.proveReady(active);
      // Exclusive fsynced intent is permanent even if the subsequent check,
      // click or reply fails. Another process can never silently retry it.
      dispatched = true;
      await publishExclusiveJSON(resolve(output, 'first-record-recovery.intent.json'), {
        schema: 1, source: 'reviewed-first-record-dispatch-intent', runId: review.runId, pid: process.pid,
        createdAtEpochMs: Date.now(), reviewSHA256: sha256(reviewBytes), originalJournalSHA256: review.journalSHA256,
        originalOperatorSHA256: review.operatorSHA256, proof, qualification: 'RECOVERED_ATTEMPT_ONLY' });
      active.throwIfAborted();
      return super.perform('record', currentScenario, active);
    }
    async steps(plan, active) {
      if (plan === this.config.journey.record) {
        need(dispatched && !inputBoundaryConsumed, 'record_recovery_not_authorized'); inputBoundaryConsumed = true;
        await this.proveReady(active);
      }
      return super.steps(plan, active);
    }
  }
  return recoverRun({ scenario, output, signal, mode: 'resume', adapter: new Inspection(configPath),
    resumeWithLease: async ownedLease => {
      lease = ownedLease; await checkReview();
      return runJourney({ scenario, output, labRoot, signal, resume: true,
        preacquiredLease: lease, adapter: new Continuation(configPath) });
    } });
}
