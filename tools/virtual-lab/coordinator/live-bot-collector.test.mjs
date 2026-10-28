import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {LiveBotPipe, readNormalHostArtifact} from './live-bot-collector.mjs';

// Real owned child pipes and actual artifact bytes, with synthetic external
// observations only. These tests establish no live account/capture acceptance.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const start = Date.now() - 60000, iso = offset => new Date(start + offset).toISOString();
  const typed = prefix => `${prefix}_${'0'.repeat(26)}`;
  const expected = {runId: randomUUID(), collectorSHA256: 'a'.repeat(64), startedAtEpochMs: start,
    accountIdentitySHA256: 'b'.repeat(64), doctorRef: typed('doctor'), patientRefSHA256: 'c'.repeat(64), hostIdSHA256: 'd'.repeat(64),
    meetingRecordRef: typed('zmtg'), meetingIdSHA256: 'e'.repeat(64), appointmentRef: typed('appointment'), occurrenceDigest: 'f'.repeat(64)};
  const {runId, collectorSHA256, startedAtEpochMs: _start, ...scope} = expected;
  Object.assign(scope, {botIdSHA256: '1'.repeat(64), recordingIdSHA256: '2'.repeat(64)});
  const row = {readSequence: 1, scope, meetingStatus: 'started',
    authorization: {occurrenceDigest: scope.occurrenceDigest, consumedAt: iso(6000), expiresAt: iso(300000)},
    meetingRuntime: {botIdSHA256: scope.botIdSHA256, occurrenceDigest: scope.occurrenceDigest},
    recordingMapping: {doctorRef: scope.doctorRef, appointmentRef: scope.appointmentRef, patientRefSHA256: scope.patientRefSHA256}};
  const observation = {schema: 1, kind: 'zoom-bot', source: 'normal-zoom-ui-and-scoped-recall-observation', executionKind: 'live',
    runId, requestNonce: randomUUID(), collectorSHA256, scope,
    consent: {source: 'normal-zoom-host-consent-ui', action: 'approve_recording', actionId: randomUUID(), artifactSHA256: '3'.repeat(64),
      hostIdSHA256: scope.hostIdSHA256, meetingIdSHA256: scope.meetingIdSHA256, occurrenceDigest: scope.occurrenceDigest, observedAtEpochMs: start + 12000},
    recordingEvidence: {source: 'normal-zoom-host-consent-ui', action: 'recording_active', actionId: randomUUID(),
      artifactSHA256: '4'.repeat(64), hostIdSHA256: scope.hostIdSHA256, meetingIdSHA256: scope.meetingIdSHA256,
      occurrenceDigest: scope.occurrenceDigest, observedAtEpochMs: start + 15000},
    core: {source: 'scoped-staging-zoom-recording-correspondence', before: row, after: {...structuredClone(row), readSequence: 3}},
    provider: {source: 'scoped-recall-get-response', httpStatus: 200, readSequence: 2, botIdSHA256: scope.botIdSHA256,
      meetingIdSHA256: scope.meetingIdSHA256, statusChanges: [
        {code: 'joining_call', subCode: null, createdAt: iso(5000)},
        {code: 'in_call_not_recording', subCode: null, createdAt: iso(14000)}],
      recordings: [{idSHA256: scope.recordingIdSHA256, botIdSHA256: scope.botIdSHA256, statusCode: 'processing', startedAt: iso(14000), completedAt: null}]}, teardown: null};
  return {expected, observation};
}
async function setup(t, mode = 'normal') {
  const input = fixture(), dir = await mkdtemp(join(tmpdir(), 'live-bot-test-'));
  const script = join(dir, 'child.mjs');
  await writeFile(script, `import readline from 'node:readline';
const fixture=${JSON.stringify(input)}, mode=${JSON.stringify(mode)};
let configured=false;
for await(const line of readline.createInterface({input:process.stdin})) {
 const r=JSON.parse(line);
 if(!configured){configured=true;console.log(JSON.stringify({version:1,kind:'live-bot-reader-ready',runId:fixture.expected.runId,collectorSHA256:fixture.expected.collectorSHA256,revision:'fixture-revision',schema:'3d40e4e90e05'}));continue;}
 if(r.action==='close'){console.log(JSON.stringify({version:1,runId:r.runId,requestNonce:r.requestNonce,closed:true}));break;}
 if(mode==='delayed')await new Promise(resolve=>setTimeout(resolve,2100));
 const observation=structuredClone(fixture.observation);observation.requestNonce=r.requestNonce;
 if(mode==='changed')observation.core.after.recordingMapping.appointmentRef='appointment_'+'1'.repeat(26);
 const value={version:1,runId:r.runId,requestNonce:mode==='nonce'?'00000000-0000-4000-8000-000000000000':r.requestNonce,observation};
 if(mode==='extra')value.secret='must_never_escape';
 console.log(JSON.stringify(value));
}
`);
  const controller = new AbortController();
  const child = spawn(process.execPath, [script], {stdio: ['pipe', 'pipe', 'pipe']});
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const pipe = new LiveBotPipe(child, {expected: input.expected, deployment: {revision: 'fixture-revision', schema: '3d40e4e90e05'}, signal: controller.signal});
  await pipe.initialize({offlineExternalSubstitution: true});
  t.after(async () => { await pipe.close(); await rm(dir, {recursive: true, force: true}); });
  return {pipe, ...input};
}

test('actual persistent pipe returns the original DTO and acknowledges remote resource close', async t => {
  const input = await setup(t), nonce = randomUUID();
  const dto = await input.pipe.request('observe', nonce, input.observation.consent, input.observation.recordingEvidence, null);
  assert.deepEqual(dto, {...input.observation, requestNonce: nonce});
  assert.equal((await input.pipe.close()).remoteReaderResourcesSettled, true);
});
test('replayed nonce never dispatches another observation', async t => {
  const input = await setup(t), nonce = randomUUID();
  await input.pipe.request('observe', nonce, input.observation.consent, input.observation.recordingEvidence, null);
  await assert.rejects(input.pipe.request('observe', nonce, input.observation.consent, input.observation.recordingEvidence, null), /request_refused/);
});
test('concurrent requests are refused before the first response', async t => {
  const input = await setup(t), pending = input.pipe.request('observe', randomUUID(), input.observation.consent, input.observation.recordingEvidence, null);
  await assert.rejects(input.pipe.request('observe', randomUUID(), input.observation.consent, input.observation.recordingEvidence, null), /request_refused/);
  await pending;
});
for (const mode of ['nonce', 'extra', 'changed']) test(`actual child ${mode} response fails and forbids recording restart`, async t => {
  const input = await setup(t, mode);
  await assert.rejects(input.pipe.request('observe', randomUUID(), input.observation.consent, input.observation.recordingEvidence, null));
  await assert.rejects(input.pipe.request('observe', randomUUID(), input.observation.consent, input.observation.recordingEvidence, null), /request_refused/);
});
test('unchanged two-second pipe deadline rejects a delayed child', async t => {
  const input = await setup(t, 'delayed'), start = performance.now();
  await assert.rejects(input.pipe.request('observe', randomUUID(), input.observation.consent, input.observation.recordingEvidence, null), /request_timeout/);
  assert.ok(performance.now() - start < 2050);
  assert.equal((await input.pipe.close()).remoteReaderResourcesSettled, false);
});
test('host artifact verifies actual bytes and refuses changed or invented files', async t => {
  const {expected} = fixture(), dir = await realpath(await mkdtemp(join(tmpdir(), 'live-host-artifact-')));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const screenshot = join(dir, 'after.png'), record = join(dir, 'action.json');
  await writeFile(screenshot, 'synthetic image bytes', {mode: 0o600});
  const pin = hash(await readFile(screenshot));
  const value = {source: 'normal-zoom-host-consent-ui', action: 'approve_recording', actionId: randomUUID(),
    hostIdSHA256: expected.hostIdSHA256, meetingIdSHA256: expected.meetingIdSHA256, occurrenceDigest: expected.occurrenceDigest,
    observedAtEpochMs: Date.now(), files: [{sha256: pin}]};
  await writeFile(record, JSON.stringify(value), {mode: 0o600});
  const binding = {path: record, sha256: hash(await readFile(record)), files: [{path: screenshot, sha256: pin}]};
  assert.equal((await readNormalHostArtifact(binding, expected, 'consent')).artifactSHA256, binding.sha256);
  const recording = join(dir, 'recording.json');
  const recordingValue = {...value, action: 'recording_active', actionId: randomUUID(), observedAtEpochMs: Date.now()};
  await writeFile(recording, JSON.stringify(recordingValue), {mode: 0o600});
  const recordingBinding = {path: recording, sha256: hash(await readFile(recording)), files: [{path: screenshot, sha256: pin}]};
  assert.equal((await readNormalHostArtifact(recordingBinding, expected, 'recording')).artifactSHA256, recordingBinding.sha256);
  await writeFile(screenshot, 'changed bytes');
  await assert.rejects(readNormalHostArtifact(binding, expected, 'consent'), /file_bytes_changed/);
  await assert.rejects(readNormalHostArtifact(recordingBinding, expected, 'recording'), /file_bytes_changed/);
});
