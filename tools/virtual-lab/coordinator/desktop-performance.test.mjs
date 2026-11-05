import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDesktopRecordPerformance, collectDesktopRecordPerformance, DESKTOP_RECORD_TARGET_MS } from './desktop-performance.mjs';
const ns = ms => String(BigInt(ms) * 1000000n);
function fixture() {
  const scope = { runId: 'run', workspaceId: 'workspace', appointmentRef: 'appointment', sessionId: 'session', revision: 'auth' };
  const admission = { ...scope, source: 'normal-native-admission-response', consentRecordId: 'consent' };
  const recording = { ...scope, source: 'normal-desktop-recording-response', recorderId: 'recorder',
    nativeRevision: 1, phase: 'ready', captureState: 'ready', pendingMutation: false, elapsedSeconds: 0, recordedChunks: 0, queuedChunks: 0 };
  const event = (name, time, attempt) => ({ event: name, monotonic_ns: ns(time), capture_attempt: attempt, pid: 41, utc: '2026-10-26T19:00:00Z' });
  const host = event('host_open', 500, 0);
  const base = { source: 'owned-desktop-performance-snapshot', ...scope, pid: 41, executablePath: '/owned/app',
    appPath: '/owned/resources', profile: '/owned/profile', hostname: 'owned', pendingObservedReplies: 0,
    admission, recording, auth: { runId: 'run', source: 'normal-desktop-auth-response', phase: 'ready', revision: 'auth', identitySHA256: 'hash' },
    diagnostics: { file: 'runtime-diagnostics-v1.jsonl', device: 1, inode: 2, events: [host] } };
  const final = structuredClone(base);final.recording = { ...recording, phase: 'recording', captureState: 'recording', nativeRevision: 2, elapsedSeconds: 1 };
  final.diagnostics.events.push(event('audio_start_pending', 1100, 1), event('audio_ready', 1250, 1));
  return { samples: [{ invokedNs: ns(900), returnedNs: ns(902), value: { ...base, mainMonotonicNs: ns(951) } },
    { invokedNs: ns(2500), returnedNs: ns(2502), value: { ...final, mainMonotonicNs: ns(2551) } }],
  timeline: { status: 'OBSERVED', action: 'record', assertionAction: 'record',
    commands: [{ kind: 'click', status: 'FULFILLED', invokedNs: ns(1000), settledNs: ns(1050) }],
    checks: [{ status: 'FULFILLED', invokedNs: ns(1060), settledNs: ns(2300) }] } };
}
test('accepted one-second counter provides a conservative bound, not an exact first buffer or saved-audio claim',()=>{
  const result = analyzeDesktopRecordPerformance(fixture());
  assert.equal(result.nativeReadyAcknowledgmentUpperMs,201);
  assert.equal(result.acceptedConvertedAudioUpperMs,1502);
  assert.equal(result.visibleRecordingUpperMs,1300);
  assert.equal(result.acceptedFramesLowerBound,16000);
  assert.equal(result.nativeReadyUnder5Seconds,true);
  assert.equal(result.exactFirstConvertedBufferTimestamp,'UNAVAILABLE');
  assert.equal(result.existingEngineRecordReadyMs,3000);
});
test('strict user target is not relaxed at exactly5000ms',()=>{
  const x=fixture();x.samples[1].invokedNs=ns(5998);x.samples[1].returnedNs=ns(6000);x.samples[1].value.mainMonotonicNs=ns(6049);
  x.timeline.checks[0].settledNs=ns(6000);
  const r=analyzeDesktopRecordPerformance(x);assert.equal(DESKTOP_RECORD_TARGET_MS,5000);
  assert.equal(r.nativeReadyUnder5Seconds,false);assert.equal(r.visibleRecordingUnder5Seconds,false);
});
test('normal pending Record transition is retained but only settled accepted frames qualify',()=>{
 const x=fixture(), transition=structuredClone(x.samples[1]);
 transition.invokedNs=ns(1200);transition.returnedNs=ns(1202);transition.value.mainMonotonicNs=ns(1251);
 transition.value.recording.pendingMutation=true;transition.value.pendingObservedReplies=1;
 transition.value.diagnostics.events.pop();
 x.samples.splice(1,0,transition);
 assert.equal(analyzeDesktopRecordPerformance(x).acceptedConvertedAudioUpperMs,1502);
});
test('pending frames without a later settled recording sample cannot qualify',()=>{
 const x=fixture();x.samples[1].value.recording.pendingMutation=true;
 assert.throws(()=>analyzeDesktopRecordPerformance(x),/accepted_converted_audio_not_observed/);
});
for(const [name,mutate]of Object.entries({
  'foreign process':x=>x.samples[1].value.pid++,
  'different consent':x=>x.samples[1].value.admission.consentRecordId='other',
  'account switch':x=>x.samples[1].value.auth.revision='other',
  'different recorder':x=>x.samples[1].value.recording.recorderId='other',
  'counter unavailable':x=>x.samples[1].value.recording.elapsedSeconds=0,
  'already used recorder':x=>x.samples[0].value.recording.elapsedSeconds=1,
  'old native attempt':x=>x.samples[1].value.diagnostics.events[1].monotonic_ns=ns(1000),
  'duplicated native ready':x=>x.samples[1].value.diagnostics.events.push(x.samples[1].value.diagnostics.events[2]),
  'lost baseline':x=>x.samples[1].value.diagnostics.events.shift(),
  'second attempt':x=>x.samples[1].value.diagnostics.events[2].capture_attempt=2,
  'native failure':x=>x.samples[1].value.diagnostics.events.push({...x.samples[1].value.diagnostics.events[2],event:'audio_overflow'}),
  'failed click':x=>x.timeline.commands[0].status='REJECTED',
  'unobserved visible state':x=>x.timeline.checks[0].status='PENDING',
  'changed clock':x=>x.samples[1].value.mainMonotonicNs=ns(2700),
  'rotated diagnostic file':x=>x.samples[1].value.diagnostics.inode++,
}))test(`${name} cannot qualify`,()=>{const x=fixture();mutate(x);assert.throws(()=>analyzeDesktopRecordPerformance(x));});
test('live collector refuses unowned adapters and never invokes supplied action',async()=>{
 let calls=0;await assert.rejects(collectDesktopRecordPerformance({ui:{},invoke:()=>calls++,signal:new AbortController().signal}),/normal_owned_adapter_required/);assert.equal(calls,0);
});
