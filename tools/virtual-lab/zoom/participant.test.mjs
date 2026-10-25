import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openFixtureRegistry, hash, requireValidatedFixture} from './fixture.mjs';
import {checkMeetingUrl, validateProductObservation} from './participant-session.mjs';
import {syntheticMedia} from './synthetic-media.mjs';

async function fixture(t, alter = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'scribe-fixture-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const folder = join(root, 'case-one'); await mkdir(folder);
  const consent = {case_id:'case-one', consent_record_id:'synthetic-consent-1', synthetic_only:true, all_parties_consented:true};
  const pcm = Buffer.alloc(6400 * 2);
  for (let n = 1600; n < 6400; n++) pcm.writeInt16LE(n % 2 ? 2000 : -2000, n * 2);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  alter({consent, wav});
  const consentBytes = JSON.stringify(consent);
  const manifestBytes = JSON.stringify({case_id:'case-one', synthetic_only:true, all_parties_consented:true,
    consent_record_id: 'synthetic-consent-1', consent_sha256:hash(consentBytes),
    files:{'visit.wav':{sha256:hash(wav),frames:6400,nonzero_frames:4800,peak_pcm16:2000}}});
  const registry = JSON.stringify({schema:1,cases:{'case-one':hash(manifestBytes)}});
  const registryPath = join(root,'registry.json');
  await writeFile(join(folder,'consent.json'),consentBytes); await writeFile(join(folder,'manifest.json'),manifestBytes);
  await writeFile(join(folder,'visit.wav'),wav); await writeFile(registryPath,registry);
  return {root,folder,registryPath,registrySha256:hash(registry)};
}
test('portable registry verifies consent, format, hash, signal and lead silence', async t => {
  const input = await fixture(t), registry = await openFixtureRegistry(input), value = await registry.load({caseId:'case-one'});
  assert.equal(value.frames,6400); assert.equal(value.firstSignalFrame,1600); assert.equal(value.nonzeroFrames,4800);
  assert.equal(value.consentRecordId,'synthetic-consent-1');
  assert.equal(requireValidatedFixture(value),value);
  assert.throws(()=>requireValidatedFixture({...value}),/fixture-not-validated/);
  await assert.rejects(registry.load({caseId:'../case-one'}),/fixture-not-allowed/);
  await assert.rejects(registry.load({caseId:'case-one',file:'../../visit.wav'}),/fixture-not-allowed/);
  await assert.rejects(openFixtureRegistry({...input,registrySha256:'0'.repeat(64)}),/registry-mismatch/);
  await writeFile(join(input.folder,'visit.wav'),'changed');
  await assert.rejects(registry.load({caseId:'case-one'}),/wav-invalid/);
});
test('denied consent fails before an audio file need exist', async t => {
  const input = await fixture(t, ({consent}) => {consent.all_parties_consented = false;});
  await rm(join(input.folder,'visit.wav'));
  await assert.rejects((await openFixtureRegistry(input)).load({caseId:'case-one'}),/consent-invalid/);
});
test('zero signal and malformed byte rate cannot pass with freshly pinned hashes', async t => {
  const zero = await fixture(t, ({wav}) => wav.fill(0,44));
  await assert.rejects((await openFixtureRegistry(zero)).load({caseId:'case-one'}),/signal-invalid/);
  const format = await fixture(t, ({wav}) => wav.writeUInt32LE(16000,28));
  await assert.rejects((await openFixtureRegistry(format)).load({caseId:'case-one'}),/pcm-invalid/);
});
test('symlinked audio is rejected', async t => {
  const input = await fixture(t); await rm(join(input.folder,'visit.wav'));
  await symlink(input.registryPath,join(input.folder,'visit.wav'));
  await assert.rejects((await openFixtureRegistry(input)).load({caseId:'case-one'}),/invalid-file/);
});
const observation = {scope:'product-ui',targetId:'owned-test-target',sessionId:'synthetic-session',observedAtEpochMs:1000,
  consent:{sessionId:'synthetic-session',state:'granted'},capture:{sessionId:'synthetic-session',state:'recording',nativeState:'recording',elapsedSeconds:1}};
test('recording requires fresh coherent product state, not legacy verification flags', () => {
  assert.equal(validateProductObservation(observation,'recording',1500),observation);
  for (const value of [
    {recordingObserved:true,normalConsentObserved:true,syntheticOnly:true},
    {...observation,scope:'mock'}, {...observation,observedAtEpochMs:-2000},
    {...observation,observedAtEpochMs:4000}, {...observation,consent:{sessionId:'other',state:'granted'}},
    {...observation,capture:{...observation.capture,nativeState:undefined}},
    {...observation,capture:{...observation.capture,state:'paused'}},
  ]) assert.throws(() => validateProductObservation(value,'recording',1500));
  assert.throws(() => validateProductObservation(observation,'idle',1500),/idle-required/);
});
test('only Zoom guests or separately labeled loopback self-tests may navigate', () => {
  assert.equal(checkMeetingUrl('https://app.zoom.us/wc/123','live'),'https://app.zoom.us/wc/123');
  assert.equal(checkMeetingUrl('http://127.0.0.1:9000','loopback'),'http://127.0.0.1:9000/');
  for (const url of ['http://zoom.us','https://zoom.us.example.org','https://u:p@zoom.us','http://127.0.0.1:9000']) assert.throws(()=>checkMeetingUrl(url,'live'));
});
test('scheduler never rewinds a completed source and resumes a valid paused offset', async t => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis,'window');
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis,'navigator');
  let context, lastSource;
  class MockAudio {
    constructor() { context = this; this.currentTime = 0; this.state = 'running'; }
    createBuffer(_channels,frames,rate) { return {duration:frames/rate,getChannelData:()=>new Float32Array(frames)}; }
    createMediaStreamDestination() { return {stream:{id:'mock-stream'}}; }
    createAnalyser() { return {fftSize:256,getFloatTimeDomainData:data=>data.fill(0)}; }
    createGain() { return {gain:{value:0},connect:()=>{}}; }
    createBufferSource() { lastSource = {connect:()=>{},disconnect:()=>{},start:()=>{},stop:()=>{}}; return lastSource; }
    async resume() {} async close() {}
  }
  Object.defineProperty(globalThis,'window',{configurable:true,value:{AudioContext:MockAudio}});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>{}}}});
  t.after(()=>{
    if(oldWindow) Object.defineProperty(globalThis,'window',oldWindow); else delete globalThis.window;
    if(oldNavigator) Object.defineProperty(globalThis,'navigator',oldNavigator); else delete globalThis.navigator;
  });
  syntheticMedia({base64:Buffer.alloc(32000).toString('base64'),sampleRate:16000,frames:16000,sha256:'a'.repeat(64)});
  const api=globalThis.window.__scribeSyntheticMedia, epoch=()=>performance.timeOrigin+performance.now();
  t.after(()=>api.close());
  await assert.rejects(api.schedule({fixtureSha256:'a'.repeat(64),startAtEpochMs:epoch()+500,restart:false}),/not-paused/);
  const first=await api.schedule({fixtureSha256:'a'.repeat(64),startAtEpochMs:epoch()+500,restart:true});
  await assert.rejects(api.schedule({fixtureSha256:'a'.repeat(64),startAtEpochMs:epoch()+500,restart:true}),/already-playing/);
  context.currentTime=first.scheduledClock.startAtContextSeconds+0.25;
  const paused=api.pause(); assert.ok(Math.abs(paused.offsetSeconds-0.25)<1e-12);
  await assert.rejects(api.schedule({fixtureSha256:'a'.repeat(64),startAtEpochMs:epoch()+500,restart:true}),/already-started/);
  const resumed=await api.schedule({fixtureSha256:'a'.repeat(64),startAtEpochMs:epoch()+500,restart:false});
  assert.equal(resumed.scheduledClock.sourceOffsetSeconds,paused.offsetSeconds);
  context.currentTime=resumed.scheduledClock.startAtContextSeconds+1;
  lastSource.onended(); assert.equal(api.report().completed,true);
  await assert.rejects(api.schedule({fixtureSha256:'a'.repeat(64),startAtEpochMs:epoch()+500,restart:false}),/not-paused/);
  await assert.rejects(api.schedule({fixtureSha256:'a'.repeat(64),startAtEpochMs:epoch()+500,restart:true}),/already-started/);
});

test('participant factory closes browsers after setup failure and exposes uncertain cleanup ownership', async t => {
  const input = await fixture(t), validated = await (await openFixtureRegistry(input)).load({caseId:'case-one'});
  const {createParticipant} = await import('./participant-session.mjs');
  const {pathToFileURL} = await import('node:url');
  for (const stage of ['context', 'script', 'page', 'cleanup']) {
    const modulePath = join(input.root, `playwright-${stage}.mjs`);
    await writeFile(modulePath, `export const state={closed:0}; export const chromium={launch:async()=>({
      close:async()=>{state.closed++;if(${JSON.stringify(stage)}==='cleanup'&&state.closed===1)throw Error('close_failed');},
      newContext:async()=>{if(${JSON.stringify(stage)}==='context'||${JSON.stringify(stage)}==='cleanup')throw Error('setup_failed');return {
        addInitScript:async()=>{if(${JSON.stringify(stage)}==='script')throw Error('setup_failed');},newPage:async()=>{throw Error('setup_failed');}};}})};`);
    const {state} = await import(pathToFileURL(modulePath).href);
    let failure;
    try { await createParticipant({fixture:validated,playwrightPath:modulePath,executionKind:'loopback',observeProduct:async()=>null}); }
    catch(error) { failure=error; }
    assert.equal(state.closed,1);
    assert.equal(failure.message,stage==='cleanup'?'participant_initialization_cleanup_failed':'setup_failed');
    if(stage==='cleanup') { await failure.closeParticipant(); assert.equal(state.closed,2); }
  }
});

test('participant close remains retryable until browser close succeeds', async t => {
  const input=await fixture(t),validated=await(await openFixtureRegistry(input)).load({caseId:'case-one'});
  const modulePath=join(input.root,'playwright-retry-close.mjs');
  await writeFile(modulePath,`export const state={closes:0};const frame={evaluate:async()=>{}};const page={mainFrame:()=>frame,frames:()=>[frame]};
    export const chromium={launch:async()=>({close:async()=>{if(++state.closes===1)throw Error('close_failed');},newContext:async()=>({addInitScript:async()=>{},newPage:async()=>page,pages:()=>[page]})})};`);
  const {pathToFileURL}=await import('node:url'),{state}=await import(pathToFileURL(modulePath).href);
  const {createParticipant}=await import('./participant-session.mjs');
  const participant=await createParticipant({fixture:validated,playwrightPath:modulePath,executionKind:'loopback',observeProduct:async()=>null});
  await assert.rejects(participant.close(),/close_failed/);await participant.close();assert.equal(state.closes,2);
});

test('mock bot participant never schedules fixture audio from a native receipt or absent bot proof', async t => {
  const input = await fixture(t), validated = await (await openFixtureRegistry(input)).load({caseId: 'case-one'});
  const modulePath = join(input.root, 'playwright-bot-admission.mjs');
  await writeFile(modulePath, `export const state={schedules:0,closed:0};
    const media={fixtureSha256:${JSON.stringify(validated.sha256)},playing:false,audioRequests:1,tracks:[{state:'live',enabled:true}]};
    const frame={isDetached:()=>false,evaluate:async(fn)=>{if(String(fn).includes('.schedule('))state.schedules++;return media;}};
    const page={mainFrame:()=>frame,frames:()=>[frame],isClosed:()=>false};
    export const chromium={launch:async()=>({close:async()=>{state.closed++;},newContext:async()=>({addInitScript:async()=>{},newPage:async()=>page,pages:()=>[page]})})};`);
  const {pathToFileURL} = await import('node:url'), {randomUUID} = await import('node:crypto');
  const {createParticipant} = await import('./participant-session.mjs'), {state} = await import(pathToFileURL(modulePath).href);
  const expected = {runId: randomUUID(), collectorSHA256: 'a'.repeat(64), startedAtEpochMs: Date.now() - 1000,
    accountIdentitySHA256: 'b'.repeat(64), doctorRef: `doctor_${'0'.repeat(26)}`, patientRefSHA256: 'c'.repeat(64),
    hostIdSHA256: 'd'.repeat(64), meetingRecordRef: `zmtg_${'0'.repeat(26)}`, meetingIdSHA256: 'e'.repeat(64),
    appointmentRef: `appointment_${'0'.repeat(26)}`, occurrenceDigest: 'f'.repeat(64)};
  for (const returned of [null, {...observation, observedAtEpochMs: Date.now()}]) {
    let request;
    const participant = await createParticipant({fixture: validated, playwrightPath: modulePath, executionKind: 'loopback',
      captureProof: {kind: 'zoom-bot', expected}, observeProduct: async value => {request = value; return returned;}});
    await assert.rejects(participant.schedule({fixtureSha256: validated.sha256, startAtEpochMs: Date.now() + 500, restart: true}), /bot_observer_identity_invalid/);
    assert.equal(request.kind, 'zoom-bot'); assert.match(request.requestNonce, /^[a-f0-9-]{36}$/);
    assert.equal(state.schedules, 0);
    await assert.rejects(participant.load(validated), /bot_fixture_reload_requires_new_participant/);
    await participant.close();
  }
  assert.equal(state.closed, 2);
});

// Metadata-only proof for the independent review's actual participant-path
// regression. The Playwright/media adapter below is mocked; no audio is emitted.
function botProof(expected, actionId) {
  const {runId, collectorSHA256, startedAtEpochMs: start, ...scope} = expected;
  const at = offset => new Date(start + offset).toISOString();
  Object.assign(scope, {botIdSHA256: '1'.repeat(64), recordingIdSHA256: '2'.repeat(64)});
  const correspondence = {readSequence: 1, scope, meetingStatus: 'started',
    authorization: {occurrenceDigest: scope.occurrenceDigest, consumedAt: at(6000), expiresAt: at(300000)},
    meetingRuntime: {botIdSHA256: scope.botIdSHA256, occurrenceDigest: scope.occurrenceDigest},
    recordingMapping: {doctorRef: scope.doctorRef, appointmentRef: scope.appointmentRef, patientRefSHA256: scope.patientRefSHA256}};
  return {schema: 1, kind: 'zoom-bot', source: 'normal-zoom-ui-and-scoped-recall-observation', executionKind: 'live',
    runId, collectorSHA256, scope,
    consent: {source: 'normal-zoom-host-consent-ui', action: 'approve_recording', actionId, artifactSHA256: '3'.repeat(64),
      hostIdSHA256: scope.hostIdSHA256, meetingIdSHA256: scope.meetingIdSHA256, occurrenceDigest: scope.occurrenceDigest,
      observedAtEpochMs: start + 12000},
    core: {source: 'scoped-staging-zoom-recording-correspondence', before: correspondence, after: {...correspondence, readSequence: 3}},
    provider: {source: 'scoped-recall-get-response', httpStatus: 200, readSequence: 2, botIdSHA256: scope.botIdSHA256,
      meetingIdSHA256: scope.meetingIdSHA256, statusChanges: [
        {code: 'joining_call', subCode: null, createdAt: at(5000)},
        {code: 'recording_permission_allowed', subCode: null, createdAt: at(13000)},
        {code: 'in_call_recording', subCode: null, createdAt: at(14000)},
      ], recordings: [{idSHA256: scope.recordingIdSHA256, botIdSHA256: scope.botIdSHA256, statusCode: 'processing',
        startedAt: at(14000), completedAt: null}]}, teardown: null};
}

test('mock participant latches a bot collector failure after admission; native retry behavior is unchanged', async t => {
  const input = await fixture(t), validated = await (await openFixtureRegistry(input)).load({caseId: 'case-one'});
  const {pathToFileURL} = await import('node:url'), {randomUUID} = await import('node:crypto');
  const {createParticipant} = await import('./participant-session.mjs');
  for (const kind of ['zoom-bot', 'native']) {
    const modulePath = join(input.root, `playwright-collector-failure-${kind}.mjs`);
    await writeFile(modulePath, `export const state={schedules:0,closed:0};
      const media={fixtureSha256:${JSON.stringify(validated.sha256)},playing:false,audioRequests:1,tracks:[{state:'live',enabled:true}]};
      const frame={isDetached:()=>false,evaluate:async(fn)=>{if(String(fn).includes('.schedule('))state.schedules++;return media;}};
      const page={mainFrame:()=>frame,frames:()=>[frame],isClosed:()=>false};
      export const chromium={launch:async()=>({close:async()=>{state.closed++;},newContext:async()=>({addInitScript:async()=>{},newPage:async()=>page,pages:()=>[page]})})};`);
    const {state} = await import(pathToFileURL(modulePath).href);
    const expected = {runId: randomUUID(), collectorSHA256: 'a'.repeat(64), startedAtEpochMs: Date.now() - 60000,
      accountIdentitySHA256: 'b'.repeat(64), doctorRef: `doctor_${'0'.repeat(26)}`, patientRefSHA256: 'c'.repeat(64),
      hostIdSHA256: 'd'.repeat(64), meetingRecordRef: `zmtg_${'0'.repeat(26)}`, meetingIdSHA256: 'e'.repeat(64),
      appointmentRef: `appointment_${'0'.repeat(26)}`, occurrenceDigest: 'f'.repeat(64)};
    const proof = botProof(expected, randomUUID()), failure = Error('synthetic_collector_timeout'); let calls = 0;
    const participant = await createParticipant({fixture: validated, playwrightPath: modulePath, executionKind: 'loopback',
      captureProof: kind === 'zoom-bot' ? {kind, expected} : {kind}, observeProduct: async request => {
        if (++calls === 1 || calls === 3) throw failure;
        return kind === 'zoom-bot' ? {...structuredClone(proof), requestNonce: request.requestNonce}
          : {...observation, observedAtEpochMs: Date.now()};
      }});
    try {
      const options = {fixtureSha256: validated.sha256, startAtEpochMs: Date.now() + 1000, restart: true};
      await assert.rejects(participant.schedule(options), error => error === failure);
      assert.equal(state.schedules, 0);
      await participant.schedule(options); // A pre-admission failure does not manufacture an admitted capture.
      assert.equal(state.schedules, 1); await participant.pause();
      if (kind === 'zoom-bot') await assert.rejects(participant.verifyRecording({signal:new AbortController().signal}), error => error === failure);
      else await assert.rejects(participant.resume(), error => error === failure);
      if (kind === 'zoom-bot') await assert.rejects(participant.resume(), /bot_recording_restart_forbidden/);
      else await participant.resume();
      assert.equal(state.schedules, kind === 'zoom-bot' ? 1 : 2); assert.equal(calls, 4);
    } finally { await participant.close(); }
    assert.equal(state.closed, 1);
  }
});
