import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceGroup, SOURCE_GRAPH_ONSET_TOLERANCE_MS, expectedSignalOffsetMs } from './sources.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const signal = () => new AbortController().signal;
function botProof() { return {kind:'zoom-bot',expected:{
  runId:'00000000-0000-4000-8000-000000000001',collectorSHA256:'a'.repeat(64),startedAtEpochMs:1,
  accountIdentitySHA256:'b'.repeat(64),patientRefSHA256:'c'.repeat(64),hostIdSHA256:'d'.repeat(64),
  meetingIdSHA256:'e'.repeat(64),occurrenceDigest:'f'.repeat(64),doctorRef:'doctor_01m5sf17b2f54bfj1ctsfhgwcb',
  appointmentRef:'appointment_01m5sf17b2f54bfj1ctsfhgwcb',meetingRecordRef:'zmtg_01m5sf17b2f54bfj1ctsfhgwcb',
}}; }
process.env.SCRIBE_SOURCE_GROUP_TEST_MEETING = 'https://zoom.us/j/synthetic-mock-only';
function fixture(id = 'a', start = 1600) {
  const pcm = Buffer.alloc(64000 * 2);
  for (const [from, to] of [[start, start + 1600], [32000, 35200]])
    for (let i = from; i < to; i++) pcm.writeInt16LE(4000, i * 2);
  return { sampleRate: 16000, frames: 64000, base64: pcm.toString('base64'), sha256: id.repeat(64), firstSignalFrame: start };
}
const config = fixtures => ({ executionKind: 'mock', registry: {}, participants: fixtures.map((_, i) => ({
  persona: `speaker-${i}`, caseId: `case-${i}`, file: `role-${i}.wav`, meetingUrlEnv: 'SCRIBE_SOURCE_GROUP_TEST_MEETING', joinSteps: [] })) });
function group(fixtures, factory) {
  return new SourceGroup(config(fixtures), async () => { throw Error('mock_product_not_used'); }, {
    createParticipant: factory,
    openFixtureRegistry: async () => ({ load: async ({ caseId }) => fixtures[Number(caseId.split('-')[1])] }),
  });
}
function botGroup(f,p,overrides={}) {
  const input={...config([f]),captureProof:botProof(),...overrides};
  return new SourceGroup(input,()=>{}, {
    openFixtureRegistry:async()=>({load:async()=>f}),
    createParticipant:async options=>{assert.deepEqual(options.captureProof,input.captureProof);return p;},
  });
}
function participant(f, options = {}) {
  const calls = [], schedules = [];
  let phase = -1, sourceOffset = 0, current = null, closed = false;
  const media = () => current ?? { fixtureSha256: f.sha256, playing: false, completed: false, rms: 0,
    offsetSeconds: 0, audioRequests: 1, tracks: [{ state: 'live', enabled: true }] };
  const schedule = async request => {
    phase++;
    const clockOffset = (options.clockOffsets ?? [200, 300])[phase] ?? 0;
    const expected = expectedSignalOffsetMs(f, sourceOffset), error = (options.onsetErrors ?? [10, 15])[phase] ?? 0;
    schedules.push({ ...request, clockOffset }); calls.push(`schedule-${phase}`);
    current = { ...media(), playing: true, completed: false, offsetSeconds: sourceOffset,
      scheduledClock: { sampleEpochMs: request.startAtEpochMs - 2000, sampleContextSeconds: 10,
        startAtEpochMs: request.startAtEpochMs, startAtContextSeconds: 12, sourceOffsetSeconds: sourceOffset },
      firstSignal: { observedAtEpochMs: request.startAtEpochMs + expected + error,
        audioContextSeconds: 12 + (expected + error) / 1000,
        sourceOffsetSeconds: sourceOffset + (expected + error) / 1000, pollingIntervalMs: 10, analysisFrames: 256 } };
    return { media: structuredClone(current) };
  };
  return { calls, schedules,
    async navigate() { calls.push('navigate'); }, async click() { calls.push('click'); }, async fill() { calls.push('fill'); },
    async frames() { return [{ frameId: 'owned', media: media() }]; }, async select() {},
    async status() {
      if (closed) throw Error('closed');
      if (current) current = { ...current, playing: options.pause && phase === 0,
        completed: !(options.pause && phase === 0), offsetSeconds: options.pause && phase === 0 ? 1 : options.completedOffset ?? 4 };
      return { media: structuredClone(media()) };
    },
    async clockSample() { const offset = (options.clockOffsets ?? [200, 300])[phase + 1] ?? 0;
      const rtt = options.roundTripMs ?? 2;
      return { sentAtEpochMs: 1000, receivedAtEpochMs: 1000 + rtt, roundTripMs: rtt, media: { observedAtEpochMs: 1000 + rtt / 2 + offset } }; },
    schedule,
    async pause() { sourceOffset = options.pausedOffset ?? 1; current = { ...current, playing: false, completed: false, offsetSeconds: sourceOffset, rms: 0 }; return { media: structuredClone(current) }; },
    async resume(request) { return schedule(request); },
    async close() { calls.push('close'); closed = true; return { ownedResourcesSettled: true }; },
  };
}

test('source execution requires cancellation and test injection cannot emit live receipts', async () => {
  const f = fixture(), p = participant(f), g = group([f], async () => p);
  await assert.rejects(g.connect(), /source_signal_required/);
  assert.throws(() => new SourceGroup({ ...config([f]), executionKind: 'live' }, () => {}, { createParticipant: async () => p }), /execution_kind/);
  await g.cleanup();
});

test('bot SourceGroup passes the pinned proof, monitors admitted capture, and rejects unsupported mixes', async () => {
  const f=fixture(),p=participant(f);let reads=0;
  p.verifyRecording=async({signal})=>{assert.ok(signal instanceof AbortSignal);reads++;return {captureIdentity:'a'.repeat(64)};};
  const g=botGroup(f,p);await g.connect({signal:signal()});
  const result=await g.play({signal:signal()});assert.equal(reads,1);assert.equal(result.executionKind,'mock');
  assert.equal(result.botMonitoring.observations[0].captureIdentity,'a'.repeat(64));await g.cleanup();
  assert.throws(()=>botGroup(f,p,{participants:[{kind:'virtual-microphone'}]}),/one_zoom_participant/);
  assert.throws(()=>botGroup(f,p,{participants:[{},{}]}),/one_zoom_participant/);
  const h=botGroup(f,participant(f));await h.connect({signal:signal()});
  await assert.rejects(h.play({signal:signal(),quietWindow:[.9,1.1]}),/bot_pause_resume_not_supported/);
  assert.equal(h.participants[0].participant.schedules.length,0);await h.cleanup();
});

test('lost bot observation closes the admitted source and never restarts its fixture', async () => {
  const f=fixture(),p=participant(f),failure=Error('collector_rejected');
  p.verifyRecording=async()=>{throw failure;};const g=botGroup(f,p);await g.connect({signal:signal()});
  await assert.rejects(g.play({signal:signal()}),error=>error===failure);await tick();
  assert.equal(p.schedules.length,1);assert.ok(p.calls.includes('close'));
  await assert.rejects(g.play({signal:signal()}),/sources_not_ready/);
  const result=await g.cleanup();assert.equal(result.ownedResourcesSettled,true);
  assert.equal(result.sourceEvidence.botMonitoring.failure.reason,'recording_observation_failed');
});

test('hung bot observation closes sources at deadline and late completion cannot revive them', async () => {
  const f=fixture(),p=participant(f),entered=deferred(),late=deferred();let requestSignal;
  p.verifyRecording=({signal})=>{requestSignal=signal;entered.resolve();return late.promise;};
  const g=botGroup(f,p);await g.connect({signal:signal()});const keepAlive=setTimeout(()=>{},5000);
  try {
    const rejected=assert.rejects(g.play({signal:signal()}),/bot_monitor_timeout/);
    await entered.promise;await rejected;await tick();
    assert.equal(requestSignal.aborted,true);assert.ok(p.calls.includes('close'));
    assert.equal(g.evidence.botMonitoring.failure.reason,'timeout');
    let closed=false;const cleanup=g.cleanup().then(value=>{closed=true;return value;});
    await tick();assert.equal(closed,false);late.resolve({captureIdentity:'a'.repeat(64)});
    assert.equal((await cleanup).ownedResourcesSettled,true);assert.equal(p.schedules.length,1);
    assert.equal(g.evidence.botMonitoring.observations.length,0);
  } finally {clearTimeout(keepAlive);late.resolve({});}
});

test('bot monitoring continues after its first good read and stops on a later lost observation', async () => {
  const f=fixture(),p=participant(f);let reads=0;
  const originalStatus=p.status;
  p.status=async()=>{const result=await originalStatus();if(p.schedules.length)
    Object.assign(result.media,{playing:true,completed:false,offsetSeconds:1});return result;};
  p.verifyRecording=async()=>{if(++reads===2)throw Error('later_observation_lost');return {captureIdentity:'a'.repeat(64)};};
  const g=botGroup(f,p);await g.connect({signal:signal()});
  await assert.rejects(g.play({signal:signal()}),/later_observation_lost/);
  const result=await g.cleanup();assert.equal(reads,2);assert.ok(p.calls.includes('close'));
  assert.equal(result.sourceEvidence.botMonitoring.observations.length,1);assert.equal(p.schedules.length,1);
});

test('independent bot watchdog stops audio when browser status stalls between good proofs', async () => {
  const f=fixture(),p=participant(f),stalled=deferred(),entered=deferred();let reads=0;
  const originalStatus=p.status;
  p.status=async()=>{if(p.schedules.length){entered.resolve();await stalled.promise;}return originalStatus();};
  p.verifyRecording=async()=>{reads++;return {captureIdentity:'a'.repeat(64)};};
  const g=botGroup(f,p);await g.connect({signal:signal()});
  const rejected=assert.rejects(g.play({signal:signal()}),/closed|source_aborted/);
  await entered.promise;await new Promise(resolve=>setTimeout(resolve,3150));
  assert.equal(reads,1);assert.ok(p.calls.includes('close'));
  assert.equal(g.evidence.botMonitoring.failure.reason,'supervision_watchdog');
  let complete=false;const cleanup=g.cleanup().then(value=>{complete=true;return value;});
  await tick();assert.equal(complete,false);stalled.resolve();await rejected;
  assert.equal((await cleanup).ownedResourcesSettled,true);assert.equal(p.schedules.length,1);
});

test('bot watchdog also covers a scheduling acknowledgement that never returns', async () => {
  const f=fixture(),p=participant(f),stalled=deferred(),entered=deferred();const schedule=p.schedule;
  p.schedule=async options=>{const value=await schedule(options);entered.resolve();await stalled.promise;return value;};
  const g=botGroup(f,p);await g.connect({signal:signal()});
  const rejected=assert.rejects(g.play({signal:signal()}),/source_aborted/);
  await entered.promise;await new Promise(resolve=>setTimeout(resolve,3150));
  assert.ok(p.calls.includes('close'));assert.equal(g.evidence.botMonitoring.failure.reason,'supervision_watchdog');
  stalled.resolve();await rejected;assert.equal((await g.cleanup()).ownedResourcesSettled,true);
});

test('cleanup waits for late participant creation and closes it before returning', async () => {
  const f = fixture(), p = participant(f), created = deferred(), entered = deferred();
  const g = group([f], async ({ signal: active }) => { assert.ok(active instanceof AbortSignal); entered.resolve(); return created.promise; });
  const connecting = g.connect({ signal: signal() }); const rejected = assert.rejects(connecting, /source_aborted/);
  await entered.promise;
  let returned = false; const cleanup = g.cleanup().then(value => { returned = true; return value; });
  await tick(); assert.equal(returned, false); created.resolve(p);
  await rejected; const receipt = await cleanup;
  assert.deepEqual(p.calls, ['close']);
  assert.equal(receipt.syntheticParticipantsClosed, true); assert.equal(receipt.sourceOperationsSettled, true);
});

test('cancelled join cannot advance and cleanup waits even when a pending UI call ignores abort', async () => {
  const f = fixture(), p = participant(f), entered = deferred(), joined = deferred(), events = [];
  p.navigate = async (_url, { signal: active }) => { assert.ok(active instanceof AbortSignal); entered.resolve(); await joined.promise; events.push('join-settled'); };
  p.close = async () => { events.push('close'); return { ownedResourcesSettled: true }; };
  const g = group([f], async () => p); g.config.participants[0].joinSteps = [{ action: 'click', role: 'button', name: 'Join' }];
  const controller = new AbortController(), connecting = g.connect({ signal: controller.signal });
  const rejected = assert.rejects(connecting, /source_aborted/); await entered.promise; controller.abort();
  const cleanup = g.cleanup().then(value => { events.push('cleanup-return'); return value; });
  await tick(); assert.deepEqual(events, ['close']); joined.resolve(); await rejected; await cleanup;
  assert.deepEqual(events, ['close', 'join-settled', 'cleanup-return']); assert.ok(!p.calls.includes('click'));
});

test('a parallel schedule failure drains remaining requests before cleanup returns', async () => {
  const fixtures = [fixture('a'), fixture('b')], a = participant(fixtures[0]), b = participant(fixtures[1]), entered = deferred(), late = deferred();
  a.schedule = async () => { throw Error('first_schedule_failed'); };
  b.schedule = async () => { entered.resolve(); await late.promise; throw Error('late_schedule_failed'); };
  const g = group(fixtures, async ({ fixture: f }) => f === fixtures[0] ? a : b); await g.connect({ signal: signal() });
  const playing = g.play({ signal: signal() }), rejected = assert.rejects(playing, /first_schedule_failed/); await entered.promise;
  let returned = false; const cleanup = g.cleanup().then(value => { returned = true; return value; });
  await tick(); assert.equal(returned, false); assert.ok(a.calls.includes('close')); assert.ok(b.calls.includes('close'));
  late.resolve(); await rejected; assert.equal((await cleanup).sourceOperationsSettled, true);
});

test('initial and resumed phases retain separate signal/clock evidence and share calibrated epochs', async () => {
  const fixtures = [fixture('a'), fixture('b', 2400)];
  const a = participant(fixtures[0], { pause: true, clockOffsets: [200, 300], pausedOffset: 1, onsetErrors: [10, 15] });
  const b = participant(fixtures[1], { pause: true, clockOffsets: [-350, -250], pausedOffset: 1.01, onsetErrors: [20, 25] });
  const g = group(fixtures, async ({ fixture: f }) => f === fixtures[0] ? a : b), callbacks = [];
  await g.connect({ signal: signal() });
  const result = await g.play({ signal: signal(), quietWindow: [0.9, 1.1],
    pause: async ({ signal: active }) => { assert.ok(active instanceof AbortSignal); callbacks.push('pause'); },
    resume: async ({ signal: active }) => { assert.ok(active instanceof AbortSignal); callbacks.push('resume'); } });
  assert.equal(result.executionKind, 'mock'); assert.equal(result.captureTiming, 'NOT_RUN');
  assert.equal(result.onsetToleranceMs, SOURCE_GRAPH_ONSET_TOLERANCE_MS); assert.deepEqual(callbacks, ['pause', 'resume']);
  assert.deepEqual(result.phases.map(p => p.name), ['initial', 'resumed']);
  for (let i = 0; i < 2; i++) {
    assert.equal(a.schedules[i].startAtEpochMs - a.schedules[i].clockOffset, b.schedules[i].startAtEpochMs - b.schedules[i].clockOffset);
    assert.ok(Math.abs(result.phases[i].onsetSkewMs - 10) < 0.001);
    assert.equal(result.phases[i].status, 'PASS');
  }
  assert.equal(result.measurements[0].phases[0].clock.clockOffsetMs, 200);
  assert.equal(result.measurements[0].phases[1].clock.clockOffsetMs, 300);
  assert.equal(result.measurements[1].phases[1].sourceOffsetSeconds, 1.01);
  assert.ok(result.measurements[0].phases[0].expectedFirstSignalOffsetMs < 200);
  assert.ok(result.measurements[0].phases[1].expectedFirstSignalOffsetMs > 900);
  assert.notDeepEqual(result.measurements[0].phases[0].firstSignal, result.measurements[0].phases[1].firstSignal);
  assert.deepEqual(result.measurements.map(m => m.framesCompleted), [64000, 64000]); await g.cleanup();
});

test('out-of-bound observed onset fails and its measured failure survives cleanup', async () => {
  const f = fixture(), g = group([f], async () => participant(f, { onsetErrors: [180] })); await g.connect({ signal: signal() });
  await assert.rejects(g.play({ signal: signal() }), /source_onset_tolerance_exceeded/);
  const receipt = await g.cleanup(); assert.equal(receipt.sourceEvidence.phases[0].status, 'FAIL');
  assert.ok(Math.abs(receipt.sourceEvidence.phases[0].maximumAbsoluteOnsetErrorMs - 180) < 0.001);
});

test('uncertain clock and incomplete frame observations cannot qualify playback', async () => {
  const f = fixture(), p = participant(f, { roundTripMs: 80 }), g = group([f], async () => p);
  await g.connect({ signal: signal() }); await assert.rejects(g.play({ signal: signal() }), /source_clock_uncertain/);
  assert.equal(p.schedules.length, 0); await g.cleanup();
  const h = group([f], async () => participant(f, { completedOffset: 3.9 })); await h.connect({ signal: signal() });
  await assert.rejects(h.play({ signal: signal() }), /source_timeout/); await h.cleanup();
});

test('PCM timing accounts for silence, resumed offset, and detector threshold', () => {
  const f = fixture(); assert.ok(expectedSignalOffsetMs(f, 0) >= 100 && expectedSignalOffsetMs(f, 0) < 101);
  assert.ok(expectedSignalOffsetMs(f, 1) >= 1000 && expectedSignalOffsetMs(f, 1) < 1001);
  assert.throws(() => expectedSignalOffsetMs(f, 3), /no_signal/);
  const quiet = { ...f, base64: Buffer.alloc(f.frames * 2).toString('base64') };
  assert.throws(() => expectedSignalOffsetMs(quiet, 0), /no_signal/);
});

test('factory cleanup failure retains its browser handle for coordinator cleanup', async () => {
  const f=fixture(); let closes=0;
  const g=group([f],async()=>{throw Object.assign(Error('participant_initialization_cleanup_failed'),{closeParticipant:async()=>{closes++;return {ownedResourcesSettled:true};}});});
  await assert.rejects(g.connect({signal:signal()}),/initialization_cleanup/);
  const receipt=await g.cleanup();assert.equal(closes,1);assert.equal(receipt.ownedResourcesSettled,true);
});

test('fulfilled but unconfirmed source cleanup retains ownership and its actual receipt', async () => {
  for (const receipt of [undefined, { ownedResourcesSettled: false, reason: 'helper_pending' }]) {
    const f = fixture(), p = participant(f); p.close = async () => receipt;
    const g = group([f], async () => p); await g.connect({ signal: signal() });
    const actual = await g.cleanup();
    assert.equal(actual.ownedResourcesSettled, false); assert.equal(actual.syntheticParticipantsClosed, false);
    assert.deepEqual(actual.participantResources[0].closeReceipt, receipt);
  }
});

test('mixed native output and Zoom graphs share scheduling while keeping their different evidence', async () => {
  const fixtures = [fixture('a'), fixture('b')], native = participant(fixtures[0]), zoom = participant(fixtures[1]);
  const convert = value => {
    delete value.media.tracks;
    Object.assign(value.media, { graphKind: 'coreaudio-output', renderedFrames: 256,
      output: { deviceUID: 'BlackHole2ch_UID', transport: 'virtual', running: true } });
    if (value.media.firstSignal) Object.assign(value.media.firstSignal, { pollingIntervalMs: 0, callbackFrames: 512, measurement: 'coreaudio-render-callback' });
    return value;
  };
  const mic = { ...native, navigate: async () => { throw Error('microphone_must_not_join_zoom'); },
    status: async () => convert(await native.status()), schedule: async request => convert(await native.schedule(request)),
    resume: async request => convert(await native.resume(request)), pause: async () => convert(await native.pause()) };
  const input = config(fixtures); input.participants[0].kind = 'virtual-microphone'; input.participants[0].output = { deviceUID: 'BlackHole2ch_UID' };
  const g = new SourceGroup(input, () => {}, { createParticipant: async () => zoom, createMicrophoneSource: async () => mic,
    openFixtureRegistry: async () => ({ load: async ({ caseId }) => fixtures[Number(caseId.split('-')[1])] }) });
  await g.connect({ signal: signal() }); const result = await g.play({ signal: signal() });
  assert.equal(result.executionKind, 'mock'); assert.equal(result.captureTiming, 'NOT_RUN');
  assert.equal(result.measurements.length, 2);
  assert.equal(result.phases[0].sources[0].firstSignal.measurement, 'coreaudio-render-callback');
  assert.equal(result.phases[0].sources[1].firstSignal.pollingIntervalMs, 10);
  assert.equal((await g.cleanup()).ownedResourcesSettled, true);
});
