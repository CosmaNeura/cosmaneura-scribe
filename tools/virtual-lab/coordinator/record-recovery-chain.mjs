import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256 } from './journal.mjs';

export const RECOVERY_SETUP_KEYS = ['journal', 'cleanup', 'result', 'intent', 'lease', 'operator', 'review'];
const need = (ok, code) => { if (!ok) throw Error(code); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const identityKeys = ['runId', 'scenarioSHA256', 'implementationSHA256', 'outputCanonical'];
const sameIdentity = (a, b) => a && b && identityKeys.every(key => a[key] !== undefined && a[key] === b[key]);

export async function requireNoFirstRecordIntent(output) {
  try { await lstat(resolve(output, 'first-record-recovery.intent.json')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw Error('first_record_intent_already_present');
}

/** One reviewed inspector failure may follow the original pre-dispatch failure.
 * This does not authorize a retry loop. The entire original prefix, the exact
 * successor lease and the original recovery code/review remain evidence. The
 * caller additionally verifies absence of the permanent input intent under
 * the maintained recovery guard and obtains fresh native/target proof. */
export function validateRecoverySetupFailure(review, files, original) {
  const pins = review.recoverySetup;
  need(pins?.kind === 'single-inspector-failure-before-first-dispatch', 'record_recovery_setup_review_required');
  for (const key of RECOVERY_SETUP_KEYS)
    need(hash(pins[key + 'SHA256']) && sha256(files[key]) === pins[key + 'SHA256'], 'record_recovery_setup_evidence_changed');
  const journal = JSON.parse(files.journal), cleanup = JSON.parse(files.cleanup);
  const envelope = JSON.parse(files.result), intent = JSON.parse(files.intent);
  const lease = JSON.parse(files.lease), previousReview = JSON.parse(files.review), result = envelope.maintainedRecovery;
  need(previousReview.status === 'APPROVED_FIRST_RECORD_AFTER_PRE_DISPATCH_FAILURE'
    && previousReview.recoverySetup === undefined && previousReview.runId === review.runId
    && previousReview.targetId === review.targetId && previousReview.failureCode === review.failureCode
    && previousReview.failureBoundary === review.failureBoundary
    && previousReview.accountIdentitySHA256 === review.accountIdentitySHA256
    && equal(previousReview.process, review.process), 'record_recovery_setup_prior_review_changed');
  for (const key of ['journal', 'operator', 'failure', 'cleanup', 'intent', 'lease'])
    need(previousReview[key + 'SHA256'] === review[key + 'SHA256'], 'record_recovery_setup_original_changed');
  need(equal(journal.identity, original.journal.identity) && journal.status === 'FAIL' && journal.pending === 'record'
    && equal(journal.completed, original.journal.completed) && Array.isArray(journal.events)
    && journal.events.length === original.journal.events.length + 3
    && equal(journal.events.slice(0, original.journal.events.length), original.journal.events),
  'record_recovery_setup_prefix_changed');
  const tail = journal.events.slice(-3);
  need(tail[0].kind === 'preflight' && hash(tail[0].evidenceSHA256)
    && /^preflight\.[a-f0-9-]{36}\.json$/.test(tail[0].evidenceFile ?? '')
    && tail[1].kind === 'failure' && tail[1].code === 'owned_webview_not_ready'
    && tail[2].kind === 'capture_quarantined' && tail[2].resourcesSettled === true && tail[2].targetLeaseRetained === true,
  'record_recovery_setup_not_before_dispatch');
  need(envelope.status === 'RECOVERY_FAILED_PRESERVED' && envelope.originalFailurePreserved === true
    && result?.schema === 1 && result.mode === 'resume' && result.status === 'RESUME_FAILED'
    && result.failureCode === 'owned_webview_not_ready' && result.targetLeaseRetained === true
    && result.nativeAppTerminated === false && result.recoveryGuardRetained === false
    && result.pendingRecoveryOperations === 0 && result.runJournalSHA256 === review.journalSHA256
    && result.previousLeaseSHA256 === review.leaseSHA256,
  'record_recovery_setup_result_changed');
  need(intent.schema === 1 && intent.runId === review.runId && Number.isSafeInteger(intent.pid) && intent.pid > 0
    && Number.isFinite(Date.parse(intent.startedAt)) && Number.isFinite(Date.parse(result.startedAt))
    && Number.isFinite(Date.parse(result.finishedAt)) && Date.parse(intent.startedAt) <= Date.parse(result.startedAt)
    && Date.parse(result.startedAt) <= Date.parse(tail[0].at) && Date.parse(tail[2].at) <= Date.parse(result.finishedAt),
  'record_recovery_setup_owner_unconfirmed');
  need(lease.pid === intent.pid && lease.host === original.leaseOwner.host && lease.uncertain === true
    && typeof lease.token === 'string' && lease.token !== original.leaseOwner.token
    && sameIdentity(lease.runIdentity, original.leaseOwner.runIdentity)
    && sameIdentity(result.runIdentity, lease.runIdentity) && lease.recoveryAttemptId === result.attemptId
    && hash(lease.recoveryInspectionSHA256) && lease.recoveryInspectionSHA256 === sha256(JSON.stringify(result.inspection)),
  'record_recovery_setup_lease_unconfirmed');
  const settled = value => value?.ownedResourcesSettled === true && value.appiumSessionClosed === true
    && value.nativeAppTerminated === false && value.uncertainNativeMutationCount === 0
    && value.inputSafetyUncertain === false && value.observerInstallationUncertain === false
    && value.observer?.observerRetainedForRecovery === true;
  need(settled(cleanup) && settled(result.cleanup) && cleanup.targetLeaseRetained === true
    && Array.isArray(cleanup.enginePendingOperations) && cleanup.enginePendingOperations.length === 0
    && cleanup.source?.ownedResourcesSettled === true && cleanup.source.sourceOperationsSettled === true
    && cleanup.source.sourceEvidence?.captureTiming === 'NOT_RUN'
    && Array.isArray(cleanup.source.sourceEvidence.phases) && cleanup.source.sourceEvidence.phases.length === 0,
  'record_recovery_setup_resources_unsettled');
  need(result.inspection?.source === 'current-native-recovery-observation' && result.inspection.executionKind === 'live'
    && result.inspection.runId === review.runId && result.inspection.targetId === review.targetId
    && result.inspection.recoveryStage === 'capture', 'record_recovery_setup_inspection_missing');
  return { journal, currentJournalSHA256: pins.journalSHA256, leaseOwner: lease,
    previousOwnerPid: intent.pid, setupInspection: result.inspection };
}
