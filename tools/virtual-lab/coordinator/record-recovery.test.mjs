import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, realpath } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AppiumUI } from './appium-ui.mjs';
import { Journal, ACTIONS, atomicJSON, sha256 } from './journal.mjs';
import { journalIdentity } from './tool-identity.mjs';
import { validateRecordRecoveryReview, validateUntouchedRecorder, recoverFirstRecord } from './record-recovery.mjs';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const runtimeRoot = fileURLToPath(new URL('../', import.meta.url));
const encode = value => Buffer.from(JSON.stringify(value));
function values() {
  const now = Date.now(), runId = 'synthetic-first-record', targetId = randomUUID();
  const visit = { source: 'normal-native-mount-response', runId: uuid(1), workspaceId: uuid(2),
    appointmentRef: 'appointment_01m5q661ryetaa28yxe7vbqrex', revision: uuid(3), requestId: uuid(4) };
  const admission = { ...visit, source: 'normal-native-admission-response', sessionId: uuid(5), consentRecordId: uuid(6),
    browserTimeOriginMs: now - 1000000, observedAtMonotonicMs: 1 };
  const native = { ...admission, source: 'normal-native-recording-response', recorderId: uuid(7), nativeRevision: 620,
    phase: 'ready', busy: false, capturedAudioFrames: 0, recordedChunks: 0, recordedPlaintextBytes: 0, signal: null,
    nativeTiming: { version: 1, clock: 'dispatch-uptime-ns', captureAttempt: 0, droppedEvents: 0 },
    observedAtMonotonicMs: 1, browserTimeOriginMs: now - 1 };
  const descriptor = { runId: visit.runId, observerSHA256: 'a'.repeat(64), pendingObservedReplies: 0 };
  const baseline = { source: 'current-native-cleanup-observation', executionKind: 'live', runId, targetId,
    observedAtEpochMs: now, currentVisit: visit, nativeObservation: native, closedLifecycle: null,
    observerPendingReplies: 0, observers: { visit: descriptor, admission: descriptor, desktop: null } };
  const cleanup = { nativeCaptureProof: baseline, ownedResourcesSettled: true, nativeAppTerminated: false,
    appiumSessionClosed: true, observer: { observerRetainedForRecovery: true }, uncertainNativeMutationCount: 0,
    inputSafetyUncertain: false, observerInstallationUncertain: false, enginePendingOperations: [],
    source: { ownedResourcesSettled: true, sourceOperationsSettled: true, sourceEvidence: { captureTiming: 'NOT_RUN', phases: [] } } };
  const journal = { identity: { runId, implementationSHA256: 'b'.repeat(64) }, status: 'FAIL', pending: 'record', completed: ACTIONS.slice(0,5),
    events: [{ kind: 'action_started', action: 'record' }, { kind: 'failure', code: 'admission_not_observed' },
      { kind: 'capture_quarantined', resourcesSettled: true, targetLeaseRetained: true }] };
  const evidence = { journal: encode(journal), cleanup: encode(cleanup), operator: Buffer.from('explicit synthetic pre-dispatch failure operator'),
    failure: encode({ status: 'FAIL_RETAIN_ACTUAL_JOURNAL_AND_CLEANUP', runId, code: 'admission_not_observed' }),
    intent: encode({ runId, pid: 2147483647 }), lease: encode({ pid:2147483647,host:hostname(),token:uuid(8),uncertain:true,
      runIdentity:{runId,implementationSHA256:journal.identity.implementationSHA256} }) };
  const review = { schema: 1, status: 'APPROVED_FIRST_RECORD_AFTER_PRE_DISPATCH_FAILURE', failureBoundary: 'before-first-record-input',
    independentReviewSHA256: 'c'.repeat(64), runId, targetId, issuedAtEpochMs: now - 1, expiresAtEpochMs: now + 600000,
    failureCode: 'admission_not_observed', process: { pid: 123, start: 'synthetic-process-start', executable: '/synthetic/App',
      bundleSHA256: 'd'.repeat(64), hardwareUUIDSHA256: 'e'.repeat(64) }, accountIdentitySHA256: 'f'.repeat(64),
    ...Object.fromEntries(Object.entries(evidence).map(([key,bytes]) => [key+'SHA256',sha256(bytes)])) };
  return { review, evidence, baseline, admission, native, visit, cleanup, journal };
}
test('review binds failed operator, actual failure shape and unchanged pending Record without converting it to success', () => {
  const f = values(), original = f.evidence.journal.toString();
  assert.equal(validateRecordRecoveryReview(f.review,f.evidence).journal.pending,'record');
  assert.equal(f.evidence.journal.toString(),original);
});
for (const key of ['journal','operator','failure','cleanup','intent','lease']) test('review rejects changed '+key+' bytes', () => {
  const f = values(); f.evidence[key] = Buffer.from('changed'); assert.throws(() => validateRecordRecoveryReview(f.review,f.evidence));
});
for (const [name,mutate] of Object.entries({
  attempted: p => p.nativeObservation.nativeTiming.captureAttempt = 1,
  missingAttempt: p => delete p.nativeObservation.nativeTiming.captureAttempt,
  frames: p => p.nativeObservation.capturedAudioFrames = 1,
  chunks: p => p.nativeObservation.recordedChunks = 1,
  bytes: p => p.nativeObservation.recordedPlaintextBytes = 1,
  busy: p => p.nativeObservation.busy = true,
  sourceSignal: p => p.nativeObservation.signal = {},
  recording: p => p.nativeObservation.phase = 'recording',
  recorder: p => p.nativeObservation.recorderId = uuid(20),
  session: p => p.nativeObservation.sessionId = uuid(20),
  revision: p => p.nativeObservation.nativeRevision--,
  auth: p => p.currentVisit.revision = uuid(20),
  mount: p => p.currentVisit.requestId = uuid(20),
  unknownClose: p => delete p.closedLifecycle,
  pending: p => p.observerPendingReplies = 1,
  observer: p => p.observers.admission.observerSHA256 = '1'.repeat(64),
  stale: p => p.nativeObservation.browserTimeOriginMs -= 20000,
})) test('untouched recorder proof refuses '+name, () => {
  const f = values(), proof = structuredClone(f.baseline); mutate(proof);
  assert.throws(() => validateUntouchedRecorder(proof,f.baseline));
});
for (const [name,mutate] of Object.entries({
  expired: f => f.review.expiresAtEpochMs = Date.now()-1,
  future: f => f.review.issuedAtEpochMs = Date.now()+10000,
  noReview: f => delete f.review.independentReviewSHA256,
  unknownBoundary: f => f.review.failureBoundary = 'probably-no-input',
  missingProcess: f => delete f.review.process,
})) test('authorization refuses '+name, () => { const f=values(); mutate(f); assert.throws(()=>validateRecordRecoveryReview(f.review,f.evidence)); });

async function integration(fn) {
  const f = values(), output = await realpath(await mkdtemp(resolve(tmpdir(),'scribe-first-record-test-')));
  const scenario = { schema:1, syntheticOnly:true, mode:'fixed', executionKind:'live', runId:f.review.runId,
    targetId:f.review.targetId, adapterSHA256:'0'.repeat(64), sourceSHA:'a'.repeat(40),
    build:{bundleId:'synthetic.app',number:'1',sha256:'d'.repeat(64)}, fixture:{sha256:'e'.repeat(64)},
    admissionBinding:{runId:f.visit.runId}, personas:[{id:'a',profile:output+'/a'},{id:'b',profile:output+'/b'}], timeoutMs:1000 };
  const identity = await journalIdentity(scenario), journal = await Journal.load(output+'/run.json',identity,false);
  const observations = {};
  const observe = action => ({ origin:'product-ui', executionKind:'live', action, targetId:scenario.targetId,
    observedAtEpochMs:Date.now(), checks:[{locator:'synthetic-only',kind:'visible',actual:true,expected:true}],
    visitScope:f.visit, admission:f.admission, nativeObservation:{...f.native,phase:'recording'},
    consentReceiptSHA256:sha256(JSON.stringify(f.admission)), elapsedSeconds:1, nativeState:'recording',
    fixtureSHA256:scenario.fixture.sha256, sourceState:'ended', completedSourceFrames:16000,
    ...(action==='finish'?{nativeTerminal:{...f.native,phase:'sealed'}}:{}) });
  for(const action of ACTIONS.slice(0,5)) {
    await journal.begin(action); observations[action]=observe(action); const file=action+'.test.observation.json';
    await atomicJSON(output+'/'+file,observations[action]);
    await journal.finish(action,{observationFile:file,observationSHA256:sha256(JSON.stringify(observations[action]))});
  }
  await journal.begin('record'); await journal.event('failure',{code:'admission_not_observed'});
  await journal.event('capture_quarantined',{resourcesSettled:true,targetLeaseRetained:true});
  journal.state.status='FAIL'; await journal.save(); f.evidence.journal=await readFile(output+'/run.json');
  f.review.journalSHA256=sha256(f.evidence.journal);
  const paths={}; for(const [key,bytes] of Object.entries(f.evidence)){paths[key]=output+'/original-'+key;await writeFile(paths[key],bytes);}
  await atomicJSON(output+'/review.json',f.review);
  const directory=resolve(await realpath(tmpdir()),`scribe-virtual-lab-target-locks-${process.getuid?.()??'user'}`);
  await mkdir(directory,{recursive:true}); const lease=resolve(directory,sha256(scenario.targetId)+'.lock');
  await atomicJSON(lease,{pid:2147483647,host:hostname(),token:randomUUID(),uncertain:true,runIdentity:{
    runId:scenario.runId,scenarioSHA256:identity.scenarioSHA256,implementationSHA256:identity.implementationSHA256,outputCanonical:output}});
  f.evidence.lease=await readFile(lease);f.review.leaseSHA256=sha256(f.evidence.lease);
  await writeFile(paths.lease,f.evidence.lease);await atomicJSON(output+'/review.json',f.review);
  const originals={}, calls=[]; let currentPhase='ready';
  const methods={
    async lockIdentity(){return scenario.targetId;}, async doctor(){return{ready:true,targetId:scenario.targetId,executionKind:'live'};},
    async connect(){this.session='synthetic-session';},
    async recoveryInspect(){this.session='synthetic-inspection';return{...structuredClone(f.baseline),source:'current-native-recovery-observation',
      recoveryStage:'capture',observedAtEpochMs:Date.now(),currentNote:null,unresolvedOwnedResources:[]};},
    async restore(){this.admission=f.admission;this.binding=f.visit;this.config={app:{bundleId:'synthetic.app'},journey:Object.fromEntries(ACTIONS.map(a=>[a,{action:a}]))};},
    async request(){return 4;},
    async readAuth(){return{source:'normal-native-auth-response',phase:'ready',identitySHA256:f.review.accountIdentitySHA256,
      revision:f.visit.revision,observedAtMonotonicMs:1,browserTimeOriginMs:Date.now()-1};},
    async assertVisit(){return f.visit;}, async readAdmission(){return null;},
    async readRecording(){return{...f.native,phase:currentPhase,observedAtMonotonicMs:1,browserTimeOriginMs:Date.now()-1};},
    async captureStateSnapshot(){return{...structuredClone(f.baseline),nativeObservation:await this.readRecording()};},
    async steps(plan){calls.push(plan.action); if(plan.action==='record')currentPhase='recording';if(plan.action==='finish')currentPhase='sealed';},
    async perform(action,s,signal){await this.steps(this.config.journey[action],signal);return observe(action);},
    async cleanup(){return{ownedResourcesSettled:true,nativeAppTerminated:false,nativeCaptureProof:{...structuredClone(f.baseline),
      observedAtEpochMs:Date.now(),nativeObservation:await this.readRecording()}};},
  };
  for(const [name,method] of Object.entries(methods)){originals[name]=AppiumUI.prototype[name];AppiumUI.prototype[name]=method;}
  const target=async({session})=>({source:'current-owned-record-recovery-target',observedAtEpochMs:Date.now(),process:f.review.process,
    previousOwnerPid:2147483647,previousOwnerAbsent:true,controlSessionId:session,foreignControlSessions:[],activeInputClients:[],unresolvedOwnedSourceProcesses:[]});
  const args={runtimeRoot,output,configPath:output+'/unused-config',scenario,labRoot:output,reviewPath:output+'/review.json',
    evidencePaths:paths,signal:new AbortController().signal,inspectTarget:target,beforeRecord:async()=>{}};
  try { await fn({f,args,output,calls,lease,target,originalJournal:JSON.parse(f.evidence.journal)}); }
  finally {
    for(const [name,method] of Object.entries(originals))AppiumUI.prototype[name]=method;
    await rm(lease,{force:true});await rm(lease+'.acquiring',{recursive:true,force:true});await rm(output,{recursive:true,force:true});
  }
}
test('real engine/guard recovery consumes a lease, preserves original FAIL events, and dispatches only first Record onward',()=>integration(async f=>{
  const result=await recoverFirstRecord(f.args); assert.equal(result.status,'RESUMED',JSON.stringify(result));
  assert.deepEqual(f.calls,ACTIONS.slice(5));
  const state=JSON.parse(await readFile(f.output+'/run.json'));
  assert.deepEqual(state.events.slice(0,f.originalJournal.events.length),f.originalJournal.events);
  assert.equal(state.events.filter(e=>e.kind==='action_started'&&e.action==='record').length,1);
  assert.equal(state.events.filter(e=>e.kind==='action_observed'&&e.action==='record').length,1);
  assert.equal(JSON.parse(await readFile(f.output+'/first-record-recovery.intent.json')).qualification,'RECOVERED_ATTEMPT_ONLY');
}));
test('existing durable first-dispatch intent prevents any input and retains lease',()=>integration(async f=>{
  await writeFile(f.output+'/first-record-recovery.intent.json','retained');
  const result=await recoverFirstRecord(f.args); assert.equal(result.status,'RESUME_FAILED',JSON.stringify(result));assert.deepEqual(f.calls,[]);
  assert.equal(await readFile(f.output+'/first-record-recovery.intent.json','utf8'),'retained');assert.equal(result.targetLeaseRetained,true);
}));
test('lost Record reply remains quarantined and is never automatically repeated',()=>integration(async f=>{
  AppiumUI.prototype.steps=async plan=>{f.calls.push(plan.action);throw Error('synthetic_lost_reply');};
  const result=await recoverFirstRecord(f.args);assert.equal(result.status,'RESUME_FAILED',JSON.stringify(result));assert.deepEqual(f.calls,['record']);
  assert.equal(result.targetLeaseRetained,true);assert.equal(JSON.parse(await readFile(f.output+'/run.json')).pending,'record');
  await assert.rejects(recoverFirstRecord(f.args),/journal_changed/);assert.deepEqual(f.calls,['record']);
}));
test('another dead owner or changed lease cannot be adopted using the older review',()=>integration(async f=>{
  const owner=JSON.parse(await readFile(f.lease));owner.token=randomUUID();await atomicJSON(f.lease,owner);
  const result=await recoverFirstRecord(f.args);assert.equal(result.status,'BLOCKED');assert.equal(result.failureCode,'record_recovery_lease_changed');
  assert.deepEqual(f.calls,[]);assert.equal(result.targetLeaseRetained,true);
}));
test('failed current scope check prevents first input and keeps original quarantine',()=>integration(async f=>{
  f.args.beforeRecord=async()=>{throw Error('synthetic_scope_expired');};
  const result=await recoverFirstRecord(f.args);assert.equal(result.status,'RESUME_FAILED');assert.deepEqual(f.calls,[]);
  assert.equal(result.targetLeaseRetained,true);
}));
test('the entire fresh proof refuses a scope read exceeding two seconds',()=>integration(async f=>{
  f.args.beforeRecord=async()=>{await new Promise(resolve=>setTimeout(resolve,2100));};
  const result=await recoverFirstRecord(f.args);assert.equal(result.status,'RESUME_FAILED');assert.deepEqual(f.calls,[]);
  assert.equal(result.targetLeaseRetained,true);
}));
test('changed current consent cannot be replaced by the retained normal receipt',()=>integration(async f=>{
  AppiumUI.prototype.readAdmission=async()=>({...f.f.admission,consentRecordId:uuid(30)});
  const result=await recoverFirstRecord(f.args);assert.equal(result.status,'RESUME_FAILED');assert.deepEqual(f.calls,[]);
}));
test('a second input-boundary invocation cannot dispatch again',()=>integration(async f=>{
  AppiumUI.prototype.perform=async function(action,s,signal){await this.steps(this.config.journey[action],signal);await this.steps(this.config.journey[action],signal);};
  const result=await recoverFirstRecord(f.args);assert.equal(result.status,'RESUME_FAILED');assert.deepEqual(f.calls,['record']);
  assert.equal(result.targetLeaseRetained,true);
}));
test('Save handoff activates only the same existing app before normal reopen',()=>integration(async f=>{
  let state=3;const commands=[];
  AppiumUI.prototype.request=async(_path,_method,body)=>{commands.push(body);if(body.script==='mobile: activateApp')state=4;return state;};
  const result=await recoverFirstRecord(f.args);assert.equal(result.status,'RESUMED');
  assert.deepEqual(commands.map(c=>c.script),['mobile: queryAppState','mobile: activateApp','mobile: queryAppState']);
  assert(commands.every(c=>c.args[0].bundleId==='synthetic.app'));
}));
test('missing app after Save does not authorize a launch or another Record',()=>integration(async f=>{
  const commands=[];AppiumUI.prototype.request=async(_path,_method,body)=>{commands.push(body.script);return 0;};
  const result=await recoverFirstRecord(f.args);assert.equal(result.status,'RESUME_FAILED');
  assert.deepEqual(commands,['mobile: queryAppState']);assert.equal(f.calls.filter(x=>x==='record').length,1);
  assert(!f.calls.includes('reopen'));
}));
for(const [name,mutate] of Object.entries({
  pid:t=>t.process={...t.process,pid:124},start:t=>t.process={...t.process,start:'new'},
  bundle:t=>t.process={...t.process,bundleSHA256:'1'.repeat(64)},
  reader:t=>t.activeInputClients=[{}],foreignSession:t=>t.foreignControlSessions=['foreign'],
  oldOwner:t=>t.previousOwnerAbsent=false,
}))test('current '+name+' change refuses before any dispatch',()=>integration(async f=>{
  f.args.inspectTarget=async options=>{const t=await f.target(options);mutate(t);return t;};
  await assert.rejects(recoverFirstRecord(f.args),/target_changed/);assert.deepEqual(f.calls,[]);
}));
