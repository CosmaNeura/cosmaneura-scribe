import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, openFixtureRegistry } from '../zoom/fixture.mjs';
import { createBotMicrophoneAdmission, createMicrophoneSource, MicrophoneChild, requireMicrophoneRecording, verifyMicrophoneExecutable } from './microphone-source.mjs';

const active = () => new AbortController().signal;
function child(mode) {
  const code = `let buffer=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', bytes => {
    buffer+=bytes; for(;;) {const at=buffer.indexOf('\\n');if(at<0)break;const request=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
      if(request.command==='close'){process.stdout.write(JSON.stringify({id:request.id,ok:true,media:{state:'closed'}})+'\\n');process.exit(0);}
      if(${JSON.stringify(mode)}==='held')continue;
      if(${JSON.stringify(mode)}==='invalid'){process.stdout.write('not json\\n');continue;}
      process.stdout.write(JSON.stringify({id:request.id,ok:true,media:{state:'silent',command:request.command}})+'\\n');
    }
  }); process.stdin.on('end',()=>process.exit(0));`;
  return spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'ignore'] });
}
test('actual owned child protocol closes cleanly and excludes unsolicited malformed metadata', async () => {
  for (const mode of ['ordinary', 'invalid']) {
    const port = new MicrophoneChild(child(mode));
    try {
      if (mode === 'invalid') await assert.rejects(port.request('status', {}, { signal: active() }), /reply_invalid/);
      else assert.equal((await port.request('status', {}, { signal: active() })).state, 'silent');
    } finally { await port.close(); assert.equal(port.closed, true); }
  }
});
test('abort and timeout keep held child work tracked until the owned child actually exits', async () => {
  const port = new MicrophoneChild(child('held')), controller = new AbortController();
  try {
    const result = port.request('schedule', {}, { signal: controller.signal }); controller.abort();
    await assert.rejects(result, /aborted/); assert.equal(port.pending.size, 1); assert.equal(port.closed, false);
    await assert.rejects(port.request('status', {}, { timeoutMs: 20 }), /timeout/); assert.equal(port.pending.size, 2);
  } finally { await port.close(); assert.equal(port.pending.size, 0); assert.equal(port.closed, true); }
});
test('microphone fixture scheduling requires fresh actual Recording/consent for the same bound session', () => {
  const good = { scope: 'product-ui', targetId: 'owned', sessionId: 'session-a', observedAtEpochMs: Date.now(),
    capture: { sessionId: 'session-a', state: 'recording', nativeState: 'recording', elapsedSeconds: 1 },
    nativeObservation: { source: 'normal-native-recording-response', sessionId: 'session-a', phase: 'recording', busy: false,
      nativeRevision: 1, observedAtMonotonicMs: 1, browserTimeOriginMs: Date.now() - 1 },
    consent: { sessionId: 'session-a', state: 'granted' } };
  assert.equal(requireMicrophoneRecording(good, 'session-a'), good);
  assert.throws(() => requireMicrophoneRecording(good, 'session-b'), /session_changed/);
  for (const patch of [{ scope: 'fixture' }, { observedAtEpochMs: Date.now() - 2001 },
    { capture: { ...good.capture, nativeState: undefined } }, { consent: { sessionId: 'other', state: 'granted' } },
    { nativeObservation: undefined }, { nativeObservation: { ...good.nativeObservation, busy: true } }]) {
    assert.throws(() => requireMicrophoneRecording({ ...good, ...patch }));
  }
});
test('helper verification refuses default or physical outputs and changed/outside executables', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'scribe-mic-helper-'));
  try {
    const executable = resolve(root, 'owned-helper'), marker = resolve(root, 'target.json'), bytes = Buffer.from('offline hash fixture; never executed');
    await writeFile(executable, bytes); await writeFile(marker, JSON.stringify({ purpose: 'scribe-synthetic-virtual-lab', role: 'owned-ios-simulator', hostname: hostname(), udid: 'owned-fixture' }));
    const target = { root, marker, role: 'owned-ios-simulator', hostname: hostname(), udid: 'owned-fixture' };
    const output = { executable, sha256: hash(bytes), deviceUID: 'BlackHole2ch_UID' };
    assert.equal(await verifyMicrophoneExecutable(output, target), await realpath(executable));
    for (const deviceUID of ['default', 'BuiltInMicrophoneDevice', undefined]) await assert.rejects(verifyMicrophoneExecutable({ ...output, deviceUID }, target));
    await assert.rejects(verifyMicrophoneExecutable({ ...output, executable: process.execPath }, target), /outside/);
    await writeFile(executable, 'changed'); await assert.rejects(verifyMicrophoneExecutable(output, target), /helper_changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('EOF settles actual owned child and rejects its unanswered operation without a saved-PID signal', async () => {
  const port = new MicrophoneChild(child('held'));
  const result = assert.rejects(port.request('status'), /child_exited/);
  port.child.stdin.end(); await result; await port.exit;
  assert.equal(port.pending.size, 0); assert.equal(port.closed, true);
  assert.deepEqual(await port.close(), { code: 0, signal: null });
});

// Contract metadata and a non-audio subprocess. These are not live Zoom proofs.
function botFixture() {
  const start = Date.now() - 60000, stamp = offset => new Date(start + offset).toISOString();
  const expected = { runId: randomUUID(), collectorSHA256: 'a'.repeat(64), startedAtEpochMs: start,
    accountIdentitySHA256: 'b'.repeat(64), doctorRef: `doctor_${'0'.repeat(26)}`, patientRefSHA256: 'c'.repeat(64),
    hostIdSHA256: 'd'.repeat(64), meetingRecordRef: `zmtg_${'0'.repeat(26)}`, meetingIdSHA256: 'e'.repeat(64),
    appointmentRef: `appointment_${'0'.repeat(26)}`, occurrenceDigest: 'f'.repeat(64) };
  const { runId, collectorSHA256, startedAtEpochMs: _time, ...scope } = expected;
  Object.assign(scope, { botIdSHA256: '1'.repeat(64), recordingIdSHA256: '2'.repeat(64) });
  const correspondence = { readSequence: 1, scope: structuredClone(scope), meetingStatus: 'started',
    authorization: { occurrenceDigest: scope.occurrenceDigest, consumedAt: stamp(6000), expiresAt: stamp(300000) },
    meetingRuntime: { botIdSHA256: scope.botIdSHA256, occurrenceDigest: scope.occurrenceDigest },
    recordingMapping: { doctorRef: scope.doctorRef, appointmentRef: scope.appointmentRef, patientRefSHA256: scope.patientRefSHA256 } };
  const observation = { schema: 1, kind: 'zoom-bot', source: 'normal-zoom-ui-and-scoped-recall-observation', executionKind: 'live',
    runId, collectorSHA256, scope, consent: { source: 'normal-zoom-host-consent-ui', action: 'approve_recording', actionId: randomUUID(),
      artifactSHA256: '3'.repeat(64), hostIdSHA256: scope.hostIdSHA256, meetingIdSHA256: scope.meetingIdSHA256,
      occurrenceDigest: scope.occurrenceDigest, observedAtEpochMs: start + 12000 },
    core: { source: 'scoped-staging-zoom-recording-correspondence', before: correspondence,
      after: { ...structuredClone(correspondence), readSequence: 3 } },
    provider: { source: 'scoped-recall-get-response', httpStatus: 200, readSequence: 2, botIdSHA256: scope.botIdSHA256,
      meetingIdSHA256: scope.meetingIdSHA256, statusChanges: [
        { code: 'joining_call', subCode: null, createdAt: stamp(5000) },
        { code: 'recording_permission_allowed', subCode: null, createdAt: stamp(13000) },
        { code: 'in_call_recording', subCode: null, createdAt: stamp(14000) } ],
      recordings: [{ idSHA256: scope.recordingIdSHA256, botIdSHA256: scope.botIdSHA256, statusCode: 'processing',
        startedAt: stamp(14000), completedAt: null }] }, teardown: null };
  const mainProcess = { pid: 100, parentPid: 1, executablePath: '/owned/zoom.us.app/Contents/MacOS/zoom.us',
    startedAtSeconds: 100, startedAtMicroseconds: 0 };
  const pin = { runId, hostname: hostname(), application: { appPath: '/owned/zoom.us.app', bundleId: 'us.zoom.xos', teamId: 'BJ4HAAB9B3',
    bundleSHA256: '4'.repeat(64), verificationReceiptSHA256: '5'.repeat(64) },
    mainProcess, inputProcess: { ...mainProcess }, inputBundleId: 'us.zoom.xos' };
  function envelope({ requestNonce }) {
    const at = performance.timeOrigin + performance.now();
    const hal = { source: 'coreaudio-read-only-process-metadata', targetDeviceUID: 'BlackHole2ch_UID',
      observedAtEpochMs: at, completedAtEpochMs: at, completeSnapshot: true, processListStable: true,
      processListNonempty: true, defaultInputStable: true, defaultInputDeviceUID: 'unrelated-default', errors: [],
      processes: [{ processObjectId: 1, pid: 100, bundleId: pin.inputBundleId, processIdentity: { ...mainProcess },
        runningInput: true, inputDevices: [{ objectId: 2, uid: 'BlackHole2ch_UID', transportType: 1986622068, isAggregate: false }], usesTargetInput: true }] };
    return { observation: { ...structuredClone(observation), requestNonce }, nativeZoomCustody: {
      source: 'current-native-zoom-input-custody', runId, hostname: pin.hostname, requestNonce,
      startedAtEpochMs: at, observedAtEpochMs: at, verificationReceiptSHA256: pin.application.verificationReceiptSHA256,
      mainProcessBefore: { ...mainProcess }, mainProcessAfter: { ...mainProcess },
      ui: { source: 'normal-native-zoom-ui', observedAtEpochMs: at, meetingIdSHA256: scope.meetingIdSHA256,
        joined: true, microphoneConnected: true, muted: false, selectedInputDeviceUID: 'BlackHole2ch_UID' }, halBefore: hal, halAfter: structuredClone(hal) } };
  }
  return { captureProof: { kind: 'zoom-bot', expected }, nativeZoomCustody: pin, envelope };
}

test('bot microphone requires raw scoped proof AND nonce-bound custody, with no native DTO substitution', async () => {
  const value = botFixture(), returned = [];
  const gate = createBotMicrophoneAdmission({ ...value, observeProduct: async request => {
    assert.equal(request.sourceKind, 'native-zoom-microphone'); const result = value.envelope(request); returned.push(result); return result;
  } });
  await assert.rejects(gate.verifyRecording({ signal: active() }), /not_admitted/);
  const result = await gate.observe(active()); assert.equal(result.observation, returned[0].observation);
  assert.equal(result.observation.nativeObservation, undefined); gate.admitted();
  assert.match((await gate.verifyRecording({ signal: active() })).captureIdentity, /^[a-f0-9]{64}$/);
  assert.notEqual(returned[0].observation.requestNonce, returned[1].observation.requestNonce);
  for (const change of [v => v.observation = { scope: 'product-ui' }, v => v.observation.scope.appointmentRef = 'foreign',
    v => v.nativeZoomCustody.ui.muted = true, v => v.nativeZoomCustody.halAfter.processes[0].processIdentity.pid++,
    v => v.observation.requestNonce = randomUUID(), v => v.nativeZoomCustody = null, v => v.rawBody = 'unknown']) {
    const candidate = botFixture(); let changed = true;
    const bad = createBotMicrophoneAdmission({ ...candidate, observeProduct: async request => {
      const result = candidate.envelope(request); if (changed) change(result); return result;
    } });
    await assert.rejects(bad.observe(active())); changed = false;
    await assert.rejects(bad.observe(active()), /restart_forbidden/);
  }
});

test('whole bot request timeout and cancellation cannot be reset by late fresh custody', async () => {
  const value = botFixture();
  const gate = createBotMicrophoneAdmission({ ...value, observeProduct: async request => {
    await new Promise(resolve => setTimeout(resolve, 2050)); return value.envelope(request);
  } });
  await assert.rejects(gate.observe(active()), /transport_stale/);
  await assert.rejects(gate.observe(active()), /restart_forbidden/);
  const controller = new AbortController(), cancelled = createBotMicrophoneAdmission({ ...value, observeProduct: async request => {
    controller.abort(); return value.envelope(request);
  } });
  await assert.rejects(cancelled.observe(controller.signal));
  await assert.rejects(cancelled.observe(active()), /restart_forbidden/);
});

async function sourceFixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'scribe-bot-mic-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = resolve(root, 'case-one'); await mkdir(folder);
  const consent = JSON.stringify({ case_id: 'case-one', consent_record_id: 'synthetic-consent-1', synthetic_only: true, all_parties_consented: true });
  const pcm = Buffer.alloc(6400 * 2); for (let i = 1600; i < 6400; i++) pcm.writeInt16LE(2000, i * 2);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  const manifest = JSON.stringify({ case_id: 'case-one', synthetic_only: true, all_parties_consented: true,
    consent_record_id: 'synthetic-consent-1', consent_sha256: hash(consent),
    files: { 'visit.wav': { sha256: hash(wav), frames: 6400, nonzero_frames: 4800, peak_pcm16: 2000 } } });
  const registry = JSON.stringify({ schema: 1, cases: { 'case-one': hash(manifest) } }), registryPath = resolve(root, 'registry.json');
  await writeFile(resolve(folder, 'consent.json'), consent); await writeFile(resolve(folder, 'manifest.json'), manifest);
  await writeFile(resolve(folder, 'visit.wav'), wav); await writeFile(registryPath, registry);
  return { root, fixture: await (await openFixtureRegistry({ root, registryPath, registrySha256: hash(registry) })).load({ caseId: 'case-one' }) };
}
test('actual non-audio child schedules once only after bot admission, rejects reload/resume, and settles ownership', async t => {
  const { root, fixture } = await sourceFixture(t), value = botFixture();
  const executable = resolve(root, 'contract-helper'), marker = resolve(root, 'target.json'), commands = resolve(root, 'commands.jsonl');
  const code = `#!${process.execPath}
const fs=require('node:fs');let buffer='',fixture,state='silent';
process.stdin.setEncoding('utf8');process.stdin.on('end',()=>process.exit(0));process.stdin.on('data',bytes=>{
 buffer+=bytes;for(;;){const at=buffer.indexOf('\\n');if(at<0)break;const r=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
 fs.appendFileSync(${JSON.stringify(commands)},JSON.stringify({command:r.command,fixtureSha256:r.fixtureSha256})+'\\n');
 if(r.command==='initialize')fixture=r.fixture;if(r.command==='schedule')state='playing';
 const media={graphKind:'coreaudio-output',fixtureSha256:fixture.fixtureSha256,pcmSHA256:fixture.pcmSHA256,
 output:{deviceUID:'BlackHole2ch_UID',transport:'virtual',running:true},state,observedAtEpochMs:Date.now(),
 renderedFrames:256,offsetSeconds:0,playing:state==='playing',rms:0};
 process.stdout.write(JSON.stringify({id:r.id,ok:true,media})+'\\n');if(r.command==='close')process.exit(0);
 }});`;
  await writeFile(executable, code); await chmod(executable, 0o700);
  const target = { root, marker, hostname: hostname(), role: 'owned-macos-lab' };
  await writeFile(marker, JSON.stringify({ ...target, purpose: 'scribe-synthetic-virtual-lab' }));
  const source = await createMicrophoneSource({ fixture, output: { executable, sha256: hash(code), deviceUID: 'BlackHole2ch_UID' }, target,
    resourceOwner: { runId: value.captureProof.expected.runId, ownedRoot: resolve(root, 'owners') }, ...value,
    observeProduct: async request => value.envelope(request), signal: active() });
  try {
    const actual = await source.schedule({ fixtureSha256: fixture.sha256, restart: true, startAtEpochMs: Date.now() + 1000 });
    assert.equal(actual.observation.kind, 'zoom-bot'); assert.equal(actual.observation.nativeObservation, undefined);
    assert.match(actual.nativeZoomCustody.canonicalSHA256, /^[a-f0-9]{64}$/);
    assert.equal(actual.nativeZoomCustody.screenCaptureKitAbsence, 'NOT_ESTABLISHED');
    const verified = await source.verifyRecording({ signal: active() });
    assert.match(verified.captureIdentity, /^[a-f0-9]{64}$/);
    assert.equal(verified.nativeZoomCustody.inputPid, value.nativeZoomCustody.inputProcess.pid);
    assert.notEqual(actual.nativeZoomCustody.requestNonce, verified.nativeZoomCustody.requestNonce);
    await assert.rejects(source.resume({}), /pause_resume_not_supported/);
    await assert.rejects(source.load(fixture), /reload_requires_new_participant/);
    await assert.rejects(source.schedule({ fixtureSha256: fixture.sha256, restart: true }), /restart_forbidden/);
  } finally { assert.equal((await source.close()).ownedResourcesSettled, true); }
  const calls = (await readFile(commands, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.filter(row => row.command === 'schedule'), [{ command: 'schedule', fixtureSha256: fixture.sha256 }]);
  assert.equal(calls.filter(row => row.command === 'initialize').length, 1);
  assert.equal(calls.filter(row => row.command === 'load').length, 0);
});
