import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { randomUUID, createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { installDesktopMainObserver, missingDesktopObserver, validateInspectorEndpoint } from './desktop-observer.mjs';
import { projectNoteObservation } from '../native/note-observation.mjs';
import { snapshotSaveFields, SAVE_UI_SCRIPT } from './save-completion.mjs';

const workspaceChannel='scribe:provider:workspace:v1',recorderChannel='scribe:provider:recorder:v1';
const appointment='appointment_01m5q661ryetaa28yxe7vbqrex',otherAppointment='appointment_01m5q661ryetaa28yxe7vbqrey';
const bindingRef='scribe_capture_binding_01m5q661ryetaa28yxe7vbqrex',operationRef='scribe_admission_01m5q661ryetaa28yxe7vbqrex';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
async function setup({ profile = null } = {}) {
  let sessionListener,recorderListener,subscriptionRequests=0;
  const performance={now:()=>Date.now()-1000,timeOrigin:1000};
  const renderer=vm.createContext({performance,TextEncoder,crypto:webcrypto,window:{scribeProvider:{subscribe:fn=>{sessionListener=fn;return()=>{sessionListener=null;};},request:()=>{subscriptionRequests++;}},
    scribeRecorder:{subscribe:fn=>{recorderListener=fn;return()=>{recorderListener=null;};},request:()=>{subscriptionRequests++;}}}});
  const replies=new Map(),calls=[];
  const original=function(_event,request){calls.push(request.requestId);return replies.get(request.requestId);};
  const handlers=new Map([[workspaceChannel,original]]);
  const target={id:41,getURL:()=> 'app://cosmas/index.html',isDestroyed:()=>false,executeJavaScript:async script=>vm.runInContext(script,renderer)};
  const owner={runId:randomUUID(),observerSHA256:createHash('sha256').update(installDesktopMainObserver.toString()).digest('hex'),pid:123,executablePath:'/owned/App/Contents/MacOS/Scribe',appPath:'/owned/App/Contents/Resources/app',webContentsId:41};
  const electron={app:{getAppPath:()=>owner.appPath,getPath:()=>profile},webContents:{getAllWebContents:()=>[target]},ipcMain:{_invokeHandlers:handlers}};
  const context=vm.createContext({Map,performance,Date,Buffer,process:{pid:owner.pid,execPath:owner.executablePath,versions:{electron:'44.4.3'},getuid:()=>process.getuid(),hrtime:process.hrtime},
    require:name=>name==='node:fs'?fs:name==='node:path'?path:name==='node:crypto'?{createHash}:name==='node:os'?os:electron});
  await vm.runInContext(`(${installDesktopMainObserver.toString()})`,context)(owner, projectNoteObservation, snapshotSaveFields, SAVE_UI_SCRIPT);
  const api=context.__scribeLabDesktopMainObserver,revision=randomUUID(),connectionId=randomUUID(),workspaceId=randomUUID(),encounterId=randomUUID(),sessionId=randomUUID(),consentRecordId=randomUUID();
  async function call(method,result,options={}) {
    const request={requestId:randomUUID(),method,connectionId,encounterId:null,payload:{},...options};
    const reply={requestId:request.requestId,ok:true,result};const promise=Promise.resolve(reply);replies.set(request.requestId,promise);
    assert.equal(handlers.get(workspaceChannel)({sender:{id:41}},request),promise);assert.equal(await promise,reply);await tick();return request;
  }
  async function open(reference=appointment) {return call('open',{encounterId,encounter:{appointmentRef:reference,patientName:'must-not-be-retained'},scope:{workspaceId,appointmentRef:reference,bindingRef}},{payload:{appointmentRef:reference}});}
  async function admit() {
    const nonce=randomUUID();await call('core',{status:200,body:{status:'admitted',appointment_ref:appointment,workspace_id:workspaceId,binding_ref:bindingRef,
      request_nonce:nonce,session_id:sessionId,consent_record_id:consentRecordId,operation_ref:operationRef,privateText:'must-not-be-retained'}},
    {encounterId,payload:{path:'/service/v1/agent/scribe/capture-admissions',body:{workspace_id:workspaceId,binding_ref:bindingRef,request_nonce:nonce,privateToken:'must-not-be-retained'}}});
  }
  async function connected() {await call('connect',{connectionId,revision},{connectionId:null});}
  async function prepared() {await connected();await call('encounter_setup',{appointmentRef:appointment,patientName:'must-not-be-retained'},{payload:{action:'submit',draft:{name:'must-not-be-retained'}}});await open();await api.bindVisit({runId:owner.runId,workspaceId,appointmentRef:appointment});await admit();}
  const snapshot=(phase='recording')=>({recorderId:randomUUID(),revision:1,snapshot:{sessionId,state:phase,desktop:{phase:phase==='paused'?'stopped':phase},elapsedSeconds:3,recordedChunks:0,queuedChunks:0,transcript:'must-not-be-retained'}});
  return {api,owner,handlers,original,replies,calls,target,renderer,context,revision,connectionId,workspaceId,encounterId,sessionId,consentRecordId,call,open,admit,connected,prepared,snapshot,
    subscriptionRequests:()=>subscriptionRequests,sessionEvent:value=>sessionListener(value),recorderEvent:value=>recorderListener(value)};
}

test('desktop observer preserves promises and retains only normal bound metadata',async()=>{
  const h=await setup();await h.prepared();
  const created=await h.api.read('created'),current=await h.api.read('current'),admission=await h.api.read('admission');
  assert.equal(created.workspaceId,h.workspaceId);assert.equal(current.appointmentRef,appointment);assert.equal(admission.consentRecordId,h.consentRecordId);
  assert.equal(h.subscriptionRequests(),0);assert.ok(!JSON.stringify({created,current,admission}).includes('must-not-be-retained'));
  assert.ok(!JSON.stringify(admission).includes('bindingRef'));assert.ok(!JSON.stringify(admission).includes('privateToken'));
  assert.equal((await h.api.uninstall()).ownedResourcesSettled,true);assert.equal(h.handlers.get(workspaceChannel),h.original);
});

test('admission requires explicit current visit arming and rejects wrong visit binding',async()=>{
  const h=await setup();await h.connected();await h.open();await h.admit();assert.equal(await h.api.read('admission'),null);
  await assert.rejects(h.api.bindVisit({runId:h.owner.runId,workspaceId:h.workspaceId,appointmentRef:otherAppointment}),/binding_mismatch/);
  await h.api.bindVisit({runId:h.owner.runId,workspaceId:h.workspaceId,appointmentRef:appointment});await h.admit();assert.ok(await h.api.read('admission'));await h.api.uninstall();
});

test('a new visit and late old replies cannot preserve old consent or current identity',async()=>{
  const h=await setup();await h.prepared();
  const held=deferred(),request={requestId:randomUUID(),method:'open',connectionId:h.connectionId,encounterId:null,payload:{appointmentRef:appointment}};
  h.replies.set(request.requestId,held.promise);h.handlers.get(workspaceChannel)({sender:{id:41}},request);
  assert.equal(await h.api.read('current'),null);assert.equal(await h.api.read('admission'),null);
  await h.open(otherAppointment);held.resolve({requestId:request.requestId,ok:true,result:{encounterId:h.encounterId,encounter:{appointmentRef:appointment},scope:{workspaceId:h.workspaceId,appointmentRef:appointment,bindingRef}}});await tick();
  assert.equal((await h.api.read('current')).appointmentRef,otherAppointment);assert.equal(await h.api.read('admission'),null);await h.api.uninstall();
});

test('asynchronous auth change clears current visit, created visit and admission',async()=>{
  const h=await setup();await h.prepared();h.sessionEvent({kind:'session',state:{phase:'ready',revision:randomUUID(),providerDisplayName:'must-not-be-retained'}});
  assert.equal(await h.api.read('current'),null);assert.equal(await h.api.read('created'),null);assert.equal(await h.api.read('admission'),null);await h.api.uninstall();
});

test('desktop auth proof observes the normal hashed ready reply without raw identity or requests', async () => {
  const h = await setup(), digest = 'a'.repeat(64);
  assert.equal(await h.api.readAuth(), null);
  await h.call('session_read', { phase: 'ready', revision: h.revision, accountIdentitySHA256: digest,
    identity: { userId: 'never-retained', sessionId: 'never-retained' }, token: 'never-retained' }, { connectionId: null });
  const proof = await h.api.readAuth();
  assert.equal(proof.source, 'normal-desktop-auth-response'); assert.equal(proof.identitySHA256, digest);
  assert.deepEqual(Object.keys(proof).sort(), ['source', 'runId', 'phase', 'revision', 'identitySHA256', 'observedAtMonotonicMs', 'browserTimeOriginMs'].sort());
  assert(!JSON.stringify(proof).includes('never-retained')); assert.equal(h.subscriptionRequests(), 0);
  h.context.Date = { now: () => Date.now() + 15001 };
  assert.equal(await h.api.readAuth(), null); await h.api.uninstall();
});

test('desktop auth proof requires a well-formed hash from a ready helper and accepts legacy state without proof', async () => {
  const h = await setup();
  for (const accountIdentitySHA256 of [undefined, null, false, 'user_offline', 'A'.repeat(64), 'a'.repeat(63)]) {
    await h.call('session_read', { phase: 'ready', revision: h.revision, accountIdentitySHA256 }, { connectionId: null });
    assert.equal(await h.api.readAuth(), null);
  }
  h.sessionEvent({ kind: 'session', state: { phase: 'ready', revision: h.revision, accountIdentitySHA256: 'a'.repeat(64) } });
  assert.equal((await h.api.readAuth()).identitySHA256, 'a'.repeat(64));
  h.sessionEvent({ kind: 'session', state: { phase: 'signedOut', revision: randomUUID(), accountIdentitySHA256: 'a'.repeat(64) } });
  assert.equal(await h.api.readAuth(), null); await h.api.uninstall();
});

test('pending desktop sign out excludes old ready replies and blocks premature observer teardown', async () => {
  const h = await setup(), digest = 'a'.repeat(64), old = deferred(), logout = deferred();
  await h.call('session_read', { phase: 'ready', revision: h.revision, accountIdentitySHA256: digest }, { connectionId: null });
  const poll = { requestId: randomUUID(), method: 'session_read', connectionId: null, encounterId: null, payload: {} };
  h.replies.set(poll.requestId, old.promise); h.handlers.get(workspaceChannel)({ sender: { id: 41 } }, poll);
  const request = { ...poll, requestId: randomUUID(), method: 'sign_out' };
  h.replies.set(request.requestId, logout.promise);
  assert.equal(h.handlers.get(workspaceChannel)({ sender: { id: 41 } }, request), logout.promise);
  assert.equal(await h.api.readAuth(), null); assert.equal((await h.api.uninstall()).ownedResourcesSettled, false);
  old.resolve({ requestId: poll.requestId, ok: true, result: { phase: 'ready', revision: h.revision, accountIdentitySHA256: digest } }); await tick();
  assert.equal(await h.api.readAuth(), null);
  h.sessionEvent({ kind: 'session', state: { phase: 'ready', revision: h.revision, accountIdentitySHA256: digest } });
  assert.equal(await h.api.readAuth(), null);
  logout.resolve({ requestId: request.requestId, ok: true, result: { phase: 'signedOut', revision: randomUUID() } }); await tick();
  assert.equal(await h.api.readAuth(), null);
  await h.call('session_read', { phase: 'ready', revision: randomUUID(), accountIdentitySHA256: 'b'.repeat(64) }, { connectionId: null });
  assert.equal((await h.api.readAuth()).identitySHA256, 'b'.repeat(64)); await h.api.uninstall();
});

test('delayed desktop auth polls and older renderer events cannot overwrite a newer account', async () => {
  const h = await setup(), held = deferred();
  const old = { requestId: randomUUID(), method: 'session_read', connectionId: null, encounterId: null, payload: {} };
  h.replies.set(old.requestId, held.promise); h.handlers.get(workspaceChannel)({ sender: { id: 41 } }, old);
  h.renderer.performance = { now: () => Date.now() - 2000, timeOrigin: 1000 };
  h.sessionEvent({ kind: 'session', state: { phase: 'ready', revision: h.revision, accountIdentitySHA256: 'a'.repeat(64) } });
  await h.call('session_read', { phase: 'ready', revision: randomUUID(), accountIdentitySHA256: 'b'.repeat(64) }, { connectionId: null });
  held.resolve({ requestId: old.requestId, ok: true, result: { phase: 'ready', revision: h.revision, accountIdentitySHA256: 'a'.repeat(64) } }); await tick();
  assert.equal((await h.api.readAuth()).identitySHA256, 'b'.repeat(64));
  const failed = { ...old, requestId: randomUUID() }; h.replies.set(failed.requestId, Promise.resolve({ requestId: failed.requestId, ok: false, result: null }));
  await h.handlers.get(workspaceChannel)({ sender: { id: 41 } }, failed); await tick();
  assert.equal(await h.api.readAuth(), null); await h.api.uninstall();
});

test('actual recorder responses bind sessions and hide old Recording during pending pause',async()=>{
  const h=await setup();await h.prepared();const state=h.snapshot(),held=deferred();
  const normal=(_event,request)=>request.kind==='pause'?held.promise:Promise.resolve({requestId:request.requestId,ok:true,state});h.handlers.set(recorderChannel,normal);
  await h.api.read('admission');
  const initial={requestId:randomUUID(),kind:'read',recorderId:null};await h.handlers.get(recorderChannel)({sender:{id:41}},initial);await tick();
  const before=await h.api.read('recording');assert.equal(before.source,'normal-desktop-recording-response');assert.equal(before.phase,'recording');assert.equal(before.nativeRevision,1);
  const pause={requestId:randomUUID(),kind:'pause',recorderId:state.recorderId};assert.equal(h.handlers.get(recorderChannel)({sender:{id:41}},pause),held.promise);
  assert.equal(await h.api.read('recording'),null);
  h.recorderEvent(state);assert.equal(await h.api.read('recording'),null);
  held.resolve({requestId:pause.requestId,ok:true,state:{...state,revision:2,snapshot:{...state.snapshot,state:'paused',desktop:{phase:'stopped'}}}});await tick();
  const after=await h.api.read('recording');assert.equal(after.phase,'stopped');assert.equal(after.captureState,'paused');assert.equal(after.nativeRevision,2);
  await h.api.uninstall();assert.equal(h.handlers.get(recorderChannel),normal);
});

test('cleanup restores only owned handlers and reports outstanding observed replies',async()=>{
  const h=await setup(),held=deferred(),request={requestId:randomUUID(),method:'connect',connectionId:null,encounterId:null,payload:{}};
  h.replies.set(request.requestId,held.promise);h.handlers.get(workspaceChannel)({sender:{id:41}},request);
  const replacement=()=>{};h.handlers.set(workspaceChannel,replacement);const receipt=await h.api.uninstall();
  assert.equal(receipt.ownedResourcesSettled,false);assert.equal(receipt.pendingObservedReplies,1);assert.equal(h.handlers.get(workspaceChannel),replacement);
  held.resolve({requestId:request.requestId,ok:false,result:null});await tick();
});

test('failed pending teardown preserves the desktop observer until its real reply settles', async () => {
  const h = await setup(); await h.prepared();
  const held = deferred(), request = { requestId: randomUUID(), method: 'session_read', connectionId: null, encounterId: null, payload: {} };
  h.replies.set(request.requestId, held.promise);
  const wrapper = h.handlers.get(workspaceChannel);
  wrapper({ sender: { id: 41 } }, request);
  const blocked = await h.api.uninstall();
  assert.equal(blocked.observerRemoved, false); assert.equal(blocked.ownedResourcesSettled, false);
  assert.equal(h.handlers.get(workspaceChannel), wrapper);
  assert.equal((await h.api.read('admission')).sessionId, h.sessionId);
  held.resolve({ requestId: request.requestId, ok: true, result: { phase: 'ready', revision: h.revision } });
  await tick();
  assert.equal((await h.api.uninstall()).ownedResourcesSettled, true);
  assert.equal(h.handlers.get(workspaceChannel), h.original);
});

test('inspector endpoint accepts explicit loopback only',()=>{
  assert.equal(validateInspectorEndpoint('http://127.0.0.1:9330').port,'9330');
  for(const url of ['http://localhost:9330','http://0.0.0.0:9330','https://127.0.0.1:9330','http://127.0.0.1:80','http://u:p@127.0.0.1:9330','http://127.0.0.1:9330/other'])assert.throws(()=>validateInspectorEndpoint(url),/endpoint/);
});

test('read-only absent desktop observer proves fresh absence without installing or removing handlers', async () => {
  const commands = []; let closed = false;
  const client = { targetId: 'owned-inspector', evaluate: async script => { commands.push(script); return null; },
    close: () => { closed = true; }, uncertain: () => false };
  const observer = missingDesktopObserver(client, 'a'.repeat(64));
  assert.equal(observer.observerSHA256, 'a'.repeat(64));
  assert.deepEqual(await observer.recoverySnapshot(), { descriptor: null, currentVisit: null, nativeObservation: null, currentNote: null });
  assert.equal((await observer.close()).ownedResourcesSettled, true); assert.equal(closed, true);
  assert(commands.every(script => script === 'globalThis.__scribeLabDesktopMainObserver?.describe() ?? null'));
});

test('a newly present desktop observer or failed passive lookup cannot become absence proof', async () => {
  for (const response of [{ runId: randomUUID() }, Error('transport lost')]) {
    let closed = false;
    const client = { targetId: 'owned-inspector', evaluate: async () => { if (response instanceof Error) throw response; return response; },
      close: () => { closed = true; }, uncertain: () => response instanceof Error };
    const observer = missingDesktopObserver(client, 'a'.repeat(64));
    await assert.rejects(observer.recoverySnapshot());
    const result = await observer.close(); assert.equal(result.ownedResourcesSettled, false);
    assert.equal(result.observerRemoved, false); assert.equal(result.observerAbsent, false); assert.equal(closed, true);
  }
});

test('stale recorder events cannot be retimestamped into fresh native evidence',async()=>{
  const h=await setup();await h.prepared();
  h.renderer.performance={now:()=>Date.now()-18000,timeOrigin:1000};
  h.recorderEvent(h.snapshot());assert.equal(await h.api.read('recording'),null);await h.api.uninstall();
});

test('a next visit can attach its new native recorder without claiming the previous handler',async()=>{
  const h=await setup();await h.prepared();const first=()=>Promise.resolve(null);h.handlers.set(recorderChannel,first);await h.api.read('admission');
  assert.notEqual(h.handlers.get(recorderChannel),first);
  await h.open(otherAppointment);assert.equal(h.handlers.get(recorderChannel),first);
  const next=()=>Promise.resolve(null);h.handlers.set(recorderChannel,next);await h.api.read('current');assert.notEqual(h.handlers.get(recorderChannel),next);
  await h.api.uninstall();assert.equal(h.handlers.get(recorderChannel),next);
});

test('same-run crash reattachment reuses ownership without duplicate wrappers',async()=>{
  const h=await setup();await h.prepared();const wrapper=h.handlers.get(workspaceChannel);
  const install=vm.runInContext(`(${installDesktopMainObserver.toString()})`,h.context);
  assert.equal((await install(h.owner)).runId,h.owner.runId);assert.equal(h.handlers.get(workspaceChannel),wrapper);
  assert.equal((await h.api.read('admission')).sessionId,h.sessionId);
  await assert.rejects(install({...h.owner,runId:randomUUID()}),/owner_mismatch/);await h.api.uninstall();
});

test('recovery detach drains observed work and retains bounded same-run callbacks',async()=>{
  const h=await setup();await h.prepared();const held=deferred(),request={requestId:randomUUID(),method:'session_read',connectionId:null,encounterId:null,payload:{}};
  h.replies.set(request.requestId,held.promise);h.handlers.get(workspaceChannel)({sender:{id:41}},request);
  let settled=false;const recovery=h.api.retainForRecovery().then(value=>{settled=true;return value;});await tick();assert.equal(settled,false);
  held.resolve({requestId:request.requestId,ok:true,result:{phase:'ready',revision:h.revision}});const result=await recovery;
  assert.equal(result.observerRetainedForRecovery,true);assert.equal(result.ownedResourcesSettled,true);assert.ok(await h.api.read('admission'));
  assert.notEqual(h.handlers.get(workspaceChannel),h.original);assert.equal(h.subscriptionRequests(),0);
  const install=vm.runInContext(`(${installDesktopMainObserver.toString()})`,h.context);
  await assert.rejects(install({...h.owner,observerSHA256:'0'.repeat(64)}),/owner_mismatch/);await h.api.uninstall();
});

test('a latest native event for another session invalidates prior Recording evidence',async()=>{
  const h=await setup();await h.prepared();const state=h.snapshot();h.recorderEvent(state);
  assert.equal((await h.api.read('recording')).sessionId,h.sessionId);
  h.recorderEvent({...state,revision:2,snapshot:{...state.snapshot,sessionId:randomUUID()}});
  assert.equal(await h.api.read('recording'),null);await h.api.uninstall();
});
test('native stopped while paused is not a terminal Finish receipt', async () => {
  const h = await setup(); await h.prepared(); const state = h.snapshot('paused'); h.recorderEvent(state);
  assert.equal(await h.api.read('terminal'), null);
  h.recorderEvent({ ...state, revision: 2, snapshot: { ...state.snapshot, state: 'uploading' } });
  const stopped = await h.api.read('terminal'); assert.equal(stopped.sessionId, h.sessionId);
  h.renderer.performance = { now: () => Date.now() - 970, timeOrigin: 1000 };
  h.recorderEvent({ ...state, revision: 3, snapshot: { ...state.snapshot, state: 'processing' } });
  assert((await h.api.read('recording')).observedAtMonotonicMs > stopped.observedAtMonotonicMs);
  assert.equal((await h.api.read('terminal')).observedAtMonotonicMs, stopped.observedAtMonotonicMs);
  h.recorderEvent({ ...state, revision: 3, snapshot: { ...state.snapshot, sessionId: randomUUID() } });
  assert.equal(await h.api.read('terminal'), null); await h.api.uninstall();
});
test('normal desktop saved note response retains only the actual session/version tuple', async () => {
  const h = await setup(); await h.prepared(); const nonce = randomUUID(), suffix = '01m5q661ryetaa28yxe7vbqrex';
  await h.call('core', { status: 200, body: { contract_version: '1', binding_ref: bindingRef,
    workspace_id: h.workspaceId, request_nonce: nonce, action: 'save', receipt: { status: 'draft', session_id: h.sessionId,
      note_ref: `visit_note_${suffix}`, transcript_ref: `ai_visit_transcript_${suffix}`, schema_ref: `doctor_note_schema_${suffix}`,
      note_sha256: 'a'.repeat(64), source_sha256: 'b'.repeat(64), field_order: ['HPI'], fields: { private: 'must-not-be-retained' } } } },
  { encounterId: h.encounterId, payload: { path: '/service/v1/agent/scribe/capture-notes', body: {
    binding_ref: bindingRef, workspace_id: h.workspaceId, request_nonce: nonce, expected_session_id: h.sessionId, action: 'save' } } });
  const note = await h.api.readNote('save'); assert.equal(note.session_id, h.sessionId);
  assert(!JSON.stringify(note).includes('must-not-be-retained')); assert(!JSON.stringify(note).includes('binding_ref'));
  await h.open(otherAppointment); assert.equal(await h.api.readNote('save'), null); await h.api.uninstall();
});

async function saveHarness() {
  const h = await setup(); await h.prepared();
  await h.call('session_read', { phase: 'ready', revision: h.revision, accountIdentitySHA256: 'd'.repeat(64) }, { connectionId: null });
  h.note = async (action = 'prepare') => {
    const nonce = randomUUID(), suffix = '01m5q661ryetaa28yxe7vbqrex';
    await h.call('core', { status: 200, body: { contract_version: '1', binding_ref: bindingRef,
      workspace_id: h.workspaceId, request_nonce: nonce, action, receipt: { status: 'draft', session_id: h.sessionId,
        note_ref: `visit_note_${suffix}`, transcript_ref: `ai_visit_transcript_${suffix}`, schema_ref: `doctor_note_schema_${suffix}`,
        note_sha256: 'a'.repeat(64), source_sha256: 'b'.repeat(64), field_order: ['HPI'], privateText: 'must-not-be-retained' } } },
    { encounterId: h.encounterId, payload: { path: '/service/v1/agent/scribe/capture-notes', body: {
      binding_ref: bindingRef, workspace_id: h.workspaceId, request_nonce: nonce, expected_session_id: h.sessionId, action } } });
    return h.api.readCurrentNote();
  };
  h.preparedNote = await h.note();
  h.openCoreRequest = () => ({ requestId: randomUUID(), method: 'open_core', connectionId: h.connectionId,
    encounterId: h.encounterId, payload: { noteRef: h.preparedNote.note_ref } });
  h.openCore = () => h.call('open_core', null, { encounterId: h.encounterId, payload: { noteRef: h.preparedNote.note_ref } });
  return h;
}

test('actual NoteAutosave clean flush issues no save; normal open_core retains the real prepare receipt', async () => {
  const source = readFileSync(new URL('../../../apps/capture/src/provider/note-autosave.ts', import.meta.url), 'utf8');
  const { NoteAutosave } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source, { mode: 'transform' }))}`);
  const h = await saveHarness(), before = await h.api.read('current'); let saves = 0;
  const autosave = new NoteAutosave({ active: () => true, dirty: () => false, save: async () => { saves++; return true; }, failed: () => assert.fail('unexpected failure') });
  assert.equal(await autosave.flush(), true); const request = await h.openCore();
  const observed = await h.api.readSaveHandoff();
  assert.equal(saves, 0); assert.equal(observed.source, 'normal-desktop-open-core-response');
  assert.equal(observed.openCoreRequestId, request.requestId); assert.equal(observed.mountRequestId, before.requestId);
  assert.equal(observed.note.action, 'prepare'); assert.equal(observed.note.requestNonce, h.preparedNote.requestNonce);
  assert.equal(observed.accountIdentitySHA256, 'd'.repeat(64)); assert.equal(observed.pendingObservedReplies, 0);
  assert.equal((await h.api.read('current')).requestId, before.requestId);
  assert(!JSON.stringify(observed).includes('must-not-be-retained')); assert(!JSON.stringify(observed).includes('binding_ref'));
  assert.equal(h.subscriptionRequests(), 0); autosave.dispose(); await h.api.uninstall();
});

for (const [name, mutate] of [
  ['wrong note', r => { r.payload.noteRef = 'visit_note_01m5q661ryetaa28yxe7vbqrey'; }],
  ['foreign encounter', r => { r.encounterId = randomUUID(); }],
  ['foreign connection', r => { r.connectionId = randomUUID(); }],
  ['extra payload key', r => { r.payload.privateText = 'must-not-be-retained'; }],
  ['missing note', r => { r.payload.noteRef = null; }],
]) test(`open_core ${name} cannot create or retain a completion`, async () => {
  const h = await saveHarness(); await h.openCore(); assert(await h.api.readSaveHandoff());
  const request = h.openCoreRequest(); mutate(request);
  await h.call('open_core', null, request); assert.equal(await h.api.readSaveHandoff(), null); await h.api.uninstall();
});

for (const [name, alter] of [
  ['failed response', reply => { reply.ok = false; }],
  ['wrong request ID', reply => { reply.requestId = randomUUID(); }],
  ['unexpected result', reply => { reply.result = {}; }],
  ['extra reply key', reply => { reply.extra = true; }],
]) test(`open_core ${name} is not navigation completion`, async () => {
  const h = await saveHarness(), request = h.openCoreRequest(), reply = { requestId: request.requestId, ok: true, result: null };
  alter(reply); const promise = Promise.resolve(reply); h.replies.set(request.requestId, promise);
  assert.equal(h.handlers.get(workspaceChannel)({ sender: { id: 41 } }, request), promise);
  await promise; await tick(); assert.equal(await h.api.readSaveHandoff(), null); await h.api.uninstall();
});

for (const change of ['note', 'auth', 'visit', 'newer open_core']) test(`pending open_core cannot survive a ${change} change`, async () => {
  const h = await saveHarness(), held = deferred(), request = h.openCoreRequest();
  h.replies.set(request.requestId, held.promise); h.handlers.get(workspaceChannel)({ sender: { id: 41 } }, request);
  assert.equal((await h.api.uninstall()).ownedResourcesSettled, false);
  if (change === 'note') await h.note('save');
  if (change === 'auth') { h.sessionEvent({ kind: 'session', state: { phase: 'ready', revision: randomUUID(), accountIdentitySHA256: 'e'.repeat(64) } }); await h.api.readAuth(); }
  if (change === 'visit') await h.open(otherAppointment);
  if (change === 'newer open_core') await h.openCore();
  held.resolve({ requestId: request.requestId, ok: true, result: null }); await tick();
  const value = await h.api.readSaveHandoff();
  if (change === 'newer open_core') assert.notEqual(value.openCoreRequestId, request.requestId);
  else assert.equal(value, null);
  assert.equal((await h.api.uninstall()).ownedResourcesSettled, true);
});

test('fixed renderer reads return only field digest and actual completion, and reject a page change', async () => {
  const h = await saveHarness(), action = { disabled: false, isConnected: true };
  const field = { name: 'note-0', value: 'synthetic only', disabled: false, readOnly: false, isConnected: true };
  const buttons = ['encounters', 'core'].map(workspaceAction => ({ disabled: false, dataset: { workspaceAction } }));
  h.renderer.document = { visibilityState: 'visible', querySelectorAll: query => query.includes('finish-note') ? [action] : [field],
    querySelector: () => ({ querySelectorAll: () => buttons, querySelector: () => ({ textContent: 'Saved for review' }) }) };
  const fields = await h.api.readSaveFields(['HPI']); assert.equal(fields.source, 'normal-note-editor-fields');
  assert(!JSON.stringify(fields).includes(field.value)); assert.equal(await h.api.readSaveFields(['wrong']), null);
  h.renderer.document.querySelectorAll = () => [];
  assert.equal((await h.api.readSaveUI()).heading, 'Saved for review');
  const execute = h.target.executeJavaScript;
  h.target.executeJavaScript = async script => {
    const result = await execute(script);
    if (script.includes('provider-completion')) h.sessionEvent({ kind: 'session', state: { phase: 'signedOut', revision: randomUUID() } });
    return result;
  };
  assert.equal(await h.api.readSaveUI(), null); await h.api.uninstall();
});

async function closedHarness() {
  const h = await setup(); await h.prepared();
  h.handlers.set(recorderChannel, h.original);
  const state = h.snapshot('paused'); state.revision = 8; state.snapshot.state = 'complete';
  h.recorderEvent(state); await h.api.read('recording');
  function command(kind, reply) {
    const request = { requestId: randomUUID(), recorderId: state.recorderId, kind };
    const promise = Promise.resolve(typeof reply === 'function' ? reply(request) : reply);
    h.replies.set(request.requestId, promise);
    assert.equal(h.handlers.get(recorderChannel)({ sender: { id: 41 } }, request), promise);
    return { request, promise };
  }
  return { ...h, state, command };
}

test('exact desktop deactivate success survives same-scope saved-note remount without refreshing its close timestamp', async () => {
  const h = await closedHarness(), held = deferred();
  const close = h.command('deactivate', held.promise);
  h.sessionEvent({ kind: 'encounter_closed', id: h.encounterId });
  assert.equal(await h.api.readClosed(), null); assert.equal((await h.api.uninstall()).ownedResourcesSettled, false);
  held.resolve({ requestId: close.request.requestId, ok: true, state: null }); await close.promise; await tick();
  const closed = await h.api.readClosed();
  assert.equal(closed.source, 'normal-desktop-recorder-close-response'); assert.equal(closed.phase, 'closed');
  assert.equal(closed.nativeRevisionBeforeClose, 8); assert.equal(closed.sessionId, h.sessionId);
  assert.equal(closed.closeMethod, 'deactivate'); assert.equal(closed.pendingObservedReplies, 0);
  await h.open(); await new Promise(resolve => setTimeout(resolve, 2));
  const after = await h.api.readClosed(); assert.equal(after.observedAtMonotonicMs, closed.observedAtMonotonicMs);
  assert(after.inspectedAtMonotonicMs > closed.inspectedAtMonotonicMs);
  assert.equal(after.captureMutationSequence, after.currentCaptureMutationSequence);
  assert.equal((await h.api.recoverySnapshot()).closedLifecycle.recorderId, h.state.recorderId);
  assert.equal(await h.api.read('recording'), null); assert.equal(await h.api.read('admission'), null);
  const nonce = randomUUID(), suffix = '01m5q661ryetaa28yxe7vbqrex';
  await h.call('core', { status: 200, body: { contract_version: '1', binding_ref: bindingRef,
    workspace_id: h.workspaceId, request_nonce: nonce, operation: 'note_opening', receipt: { session_id: h.sessionId,
      review: {}, templates: [], note: { status: 'draft', session_id: h.sessionId, note_ref: `visit_note_${suffix}`,
        transcript_ref: `ai_visit_transcript_${suffix}`, schema_ref: `doctor_note_schema_${suffix}`,
        note_sha256: 'a'.repeat(64), source_sha256: 'b'.repeat(64), field_order: ['HPI'] } } } },
  { encounterId: h.encounterId, payload: { path: '/service/v1/agent/scribe/note-opening', body: {
    binding_ref: bindingRef, workspace_id: h.workspaceId, request_nonce: nonce, expected_session_id: h.sessionId } } });
  assert.equal((await h.api.readNote('read')).transportAction, 'note_opening');
  await h.open(otherAppointment); assert.equal(await h.api.readClosed(), null); await h.api.uninstall();
});

test('premature desktop closed events and failed transition replies cannot replace awaited recorder disposal', async () => {
  for (const succeeds of [false, true]) {
    const h = await closedHarness(), held = deferred();
    const request = { requestId: randomUUID(), method: 'list', connectionId: h.connectionId, encounterId: null, payload: {} };
    h.replies.set(request.requestId, held.promise); h.handlers.get(workspaceChannel)({ sender: { id: 41 } }, request);
    h.sessionEvent({ kind: 'encounter_closed', id: h.encounterId });
    assert.equal(await h.api.readClosed(), null);
    held.resolve({ requestId: request.requestId, ok: succeeds, result: [] }); await held.promise; await tick();
    const closed = await h.api.readClosed();
    if (succeeds) { assert.equal(closed.closeMethod, 'workspace_list'); assert.equal(closed.recorderId, h.state.recorderId); }
    else assert.equal(closed, null);
    await h.api.uninstall();
  }
});

test('malformed or uncorrelated desktop list/open replies cannot qualify recorder closure', async () => {
  for (const method of ['list', 'open']) for (const patch of [{ requestId: randomUUID() }, { result: null }, { unexpected: true }]) {
    const h = await closedHarness(), request = { requestId: randomUUID(), method, connectionId: h.connectionId,
      encounterId: null, payload: method === 'open' ? { appointmentRef: appointment } : {} };
    const result = method === 'list' ? [] : { encounterId: h.encounterId, encounter: { appointmentRef: appointment },
      scope: { workspaceId: h.workspaceId, appointmentRef: appointment, bindingRef } };
    h.replies.set(request.requestId, Promise.resolve({ requestId: request.requestId, ok: true, result, ...patch }));
    await h.handlers.get(workspaceChannel)({ sender: { id: 41 } }, request); await tick();
    assert.equal(await h.api.readClosed(), null); await h.api.uninstall();
  }
});

test('desktop failed or uncorrelated deactivation and superseding native mutations cannot qualify closure', async () => {
  for (const patch of [{ ok: false }, { requestId: randomUUID() }, { state: {} }, { unexpected: true }]) {
    const h = await closedHarness();
    const { promise } = h.command('deactivate', request => ({ requestId: request.requestId, ok: true, state: null, ...patch }));
    await promise; await tick(); assert.equal(await h.api.readClosed(), null); await h.api.uninstall();
  }
  for (const mutation of ['start', 'recorder', 'auth']) {
    const h = await closedHarness(), held = deferred(), close = h.command('deactivate', held.promise);
    if (mutation === 'start') { await h.command('start', request => ({ requestId: request.requestId, ok: false, state: h.state })).promise; }
    else if (mutation === 'recorder') await h.call('recorder', null, { encounterId: h.encounterId, payload: { sessionId: h.sessionId } });
    else h.sessionEvent({ kind: 'session', state: { phase: 'signedOut', revision: randomUUID() } });
    await h.api.readClosed();
    held.resolve({ requestId: close.request.requestId, ok: true, state: null }); await close.promise; await tick();
    assert.equal(await h.api.readClosed(), null); await h.api.uninstall();
  }
});

test('idempotent desktop deactivation preserves the first correlated physical-close timestamp', async () => {
  const h = await closedHarness();
  const reply = request => ({ requestId: request.requestId, ok: true, state: null });
  await h.command('deactivate', reply).promise; await tick();
  const first = await h.api.readClosed(); await new Promise(resolve => setTimeout(resolve, 2));
  await h.command('deactivate', reply).promise; await tick();
  const repeated = await h.api.readClosed();
  assert.equal(repeated.observedAtMonotonicMs, first.observedAtMonotonicMs);
  assert.equal(repeated.closeRequestId, first.closeRequestId);
  assert(repeated.captureMutationSequence > first.captureMutationSequence);
  assert.equal(repeated.captureMutationSequence, repeated.currentCaptureMutationSequence);
  await h.api.uninstall();
});

test('performance reads only fixed current-process metadata and issues no product request',async()=>{
  const profile=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'scribe-desktop-timing-test-')));
  const file=path.join(profile,'runtime-diagnostics-v1.jsonl');
  const rows=[{utc:new Date().toISOString(),pid:123,event:'host_open',monotonic_ns:'1',capture_attempt:0},
    {utc:new Date().toISOString(),pid:999,event:'host_open',monotonic_ns:'2',capture_attempt:0,private:'not retained'},
    {pid:123,event:'not_an_allowed_timing',private:'not retained'}];
  fs.writeFileSync(file,rows.map(v=>JSON.stringify(v)).join('\n')+'\n',{mode:0o600});
  const h=await setup({profile});
  try{
    const r=await h.api.readPerformance();assert.equal(r.pid,123);assert.equal(r.profile,profile);
    assert.equal(r.diagnostics.events.length,1);assert.equal(r.diagnostics.events[0].event,'host_open');
    assert.equal(JSON.stringify(r).includes('not retained'),false);assert.equal(h.subscriptionRequests(),0);assert.equal(h.calls.length,0);
    fs.appendFileSync(file,'{"pid":123');await assert.rejects(h.api.readPerformance(),/partial_line/);
    fs.writeFileSync(file,JSON.stringify({...rows[0],duration_ms:'wrong'})+'\n');await assert.rejects(h.api.readPerformance(),/event_invalid/);
    fs.chmodSync(file,0o644);await assert.rejects(h.api.readPerformance(),/file_invalid/);
  }finally{await h.api.uninstall();fs.rmSync(profile,{recursive:true});}
});
