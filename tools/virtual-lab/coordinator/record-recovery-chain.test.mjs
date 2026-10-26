import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from './journal.mjs';
import { RECOVERY_SETUP_KEYS, validateRecoverySetupFailure } from './record-recovery-chain.mjs';
const encode = value => Buffer.from(JSON.stringify(value));
function fixture() {
  const identity = { runId: 'synthetic-run', scenarioSHA256: 'a'.repeat(64), implementationSHA256: 'b'.repeat(64), outputCanonical: '/synthetic/output' };
  const oldLease = { pid: 21, host: 'synthetic-host', token: 'old', uncertain: true, runIdentity: identity };
  const oldJournal = { identity, pending: 'record', completed: ['sign_in','workspace','create_visit','prepare','consent'], status: 'FAIL',
    events: [{kind:'action_started',action:'record'},{kind:'failure',code:'admission_not_observed'},{kind:'capture_quarantined',resourcesSettled:true,targetLeaseRetained:true}] };
  const review = { status: 'APPROVED_FIRST_RECORD_AFTER_PRE_DISPATCH_FAILURE', runId: identity.runId, targetId: 'synthetic-target',
    failureCode: 'admission_not_observed', failureBoundary: 'before-first-record-input', accountIdentitySHA256: 'c'.repeat(64), process:{pid:10},
    ...Object.fromEntries(['journal','operator','failure','cleanup','intent','lease'].map((k,i)=>[k+'SHA256',String(i+1).repeat(64)])) };
  const settled = { ownedResourcesSettled:true,appiumSessionClosed:true,nativeAppTerminated:false,uncertainNativeMutationCount:0,
    inputSafetyUncertain:false,observerInstallationUncertain:false,observer:{observerRetainedForRecovery:true} };
  const inspection={source:'current-native-recovery-observation',executionKind:'live',runId:review.runId,targetId:review.targetId,recoveryStage:'capture'};
  const result={schema:1,mode:'resume',status:'RESUME_FAILED',failureCode:'owned_webview_not_ready',targetLeaseRetained:true,nativeAppTerminated:false,
    recoveryGuardRetained:false,pendingRecoveryOperations:0,runJournalSHA256:review.journalSHA256,previousLeaseSHA256:review.leaseSHA256,
    runIdentity:identity,attemptId:'synthetic-attempt',inspection,cleanup:settled,startedAt:'2026-10-26T12:13:17Z',finishedAt:'2026-10-26T12:13:34Z'};
  const values = {
    journal:{...oldJournal,events:[...oldJournal.events,
      {kind:'preflight',evidenceSHA256:'d'.repeat(64),evidenceFile:'preflight.00000000-0000-4000-8000-000000000001.json',at:'2026-10-26T12:13:24Z'},
      {kind:'failure',code:'owned_webview_not_ready',at:'2026-10-26T12:13:27Z'},
      {kind:'capture_quarantined',resourcesSettled:true,targetLeaseRetained:true,at:'2026-10-26T12:13:33Z'}]},
    cleanup:{...settled,targetLeaseRetained:true,enginePendingOperations:[],source:{ownedResourcesSettled:true,sourceOperationsSettled:true,sourceEvidence:{captureTiming:'NOT_RUN',phases:[]}}},
    result:{status:'RECOVERY_FAILED_PRESERVED',originalFailurePreserved:true,maintainedRecovery:result},
    intent:{schema:1,runId:review.runId,pid:22,startedAt:'2026-10-26T12:13:16Z'},
    lease:{...oldLease,pid:22,token:'new',recoveryAttemptId:result.attemptId,recoveryInspectionSHA256:sha256(JSON.stringify(inspection))},
    operator:'synthetic reviewed operator',review:structuredClone(review),
  };
  const original={journal:oldJournal,leaseOwner:oldLease};
  const repin=()=>{const files=Object.fromEntries(RECOVERY_SETUP_KEYS.map(k=>[k,encode(values[k])]));review.recoverySetup={kind:'single-inspector-failure-before-first-dispatch',...Object.fromEntries(RECOVERY_SETUP_KEYS.map(k=>[k+'SHA256',sha256(files[k])]))};return files;};
  return {review,values,original,repin};
}
test('one exact setup failure preserves original prefix and binds the successor lease',()=>{
  const f=fixture(),files=f.repin(),before=files.journal.toString();const current=validateRecoverySetupFailure(f.review,files,f.original);
  assert.equal(current.previousOwnerPid,22);assert.equal(current.currentJournalSHA256,f.review.recoverySetup.journalSHA256);
  assert.equal(files.journal.toString(),before);assert.deepEqual(current.journal.events.slice(0,3),f.original.journal.events);
});
for(const key of RECOVERY_SETUP_KEYS)test('changed setup '+key+' bytes refuse',()=>{
  const f=fixture(),files=f.repin();files[key]=Buffer.from('changed');assert.throws(()=>validateRecoverySetupFailure(f.review,files,f.original),/evidence_changed/);
});
for(const [name,mutate]of Object.entries({
  recordEvent:v=>v.journal.events[3]={kind:'action_started',action:'record'},
  observedRecord:v=>v.journal.events[4]={kind:'action_observed',action:'record'},
  secondFailure:v=>v.journal.events.push(...v.journal.events.slice(-3)),
  changedPrefix:v=>v.journal.events[0]={kind:'action_started',action:'play_source'},
  wrongFailure:v=>v.result.maintainedRecovery.failureCode='unknown',
  anotherBase:v=>v.result.maintainedRecovery.runJournalSHA256='f'.repeat(64),
  anotherLease:v=>v.result.maintainedRecovery.previousLeaseSHA256='f'.repeat(64),
  wrongSuccessor:v=>v.lease.recoveryAttemptId='other',
  wrongInspection:v=>v.lease.recoveryInspectionSHA256='f'.repeat(64),
  wrongOwner:v=>v.lease.pid=23,
  wrongRun:v=>v.lease.runIdentity={...v.lease.runIdentity,runId:'foreign'},
  uncertainInput:v=>v.cleanup.uncertainNativeMutationCount=1,
  unknownContext:v=>v.cleanup.inputSafetyUncertain=true,
  pending:v=>v.cleanup.enginePendingOperations=['restore'],
  pendingInspection:v=>v.result.maintainedRecovery.pendingRecoveryOperations=1,
  activeSource:v=>v.cleanup.source.sourceEvidence.phases=[{}],
  previousRetry:v=>v.review.recoverySetup={},
  changedProcess:v=>v.review.process={pid:11},
}))test('semantic setup refusal: '+name,()=>{
  const f=fixture();mutate(f.values);const files=f.repin();assert.throws(()=>validateRecoverySetupFailure(f.review,files,f.original));
});
