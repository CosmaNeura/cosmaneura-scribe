import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {BotCaptureProofGate, BOT_PROOF_MAX_AGE_MS} from './bot-capture-proof.mjs';
import {createCaptureProofGate, validateProductObservation} from './participant-session.mjs';

// Contract fixtures, not live observations. No provider, browser, microphone,
// media stream or host consent action is used by this file.
const typed = (prefix, digit = '0') => `${prefix}_${digit.repeat(26)}`;
const digest = digit => digit.repeat(64);
const start = 1700000000000, timestamp = offset => new Date(start + offset).toISOString();
const clone = value => structuredClone(value);
function fixture() {
  const expected = {runId: randomUUID(), collectorSHA256: digest('a'), startedAtEpochMs: start,
    accountIdentitySHA256: digest('b'), doctorRef: typed('doctor'), patientRefSHA256: digest('c'),
    hostIdSHA256: digest('d'), meetingRecordRef: typed('zmtg'), meetingIdSHA256: digest('e'),
    appointmentRef: typed('appointment'), occurrenceDigest: digest('f')};
  const {runId, collectorSHA256, startedAtEpochMs, ...scope} = expected;
  Object.assign(scope, {botIdSHA256: digest('1'), recordingIdSHA256: digest('2')});
  const request = {requestNonce: randomUUID(), sentAtEpochMs: start + 59900, receivedAtEpochMs: start + 59990};
  const correspondence = {readSequence: 1, scope: clone(scope), meetingStatus: 'started',
    authorization: {occurrenceDigest: scope.occurrenceDigest, consumedAt: timestamp(6000), expiresAt: timestamp(300000)},
    meetingRuntime: {botIdSHA256: scope.botIdSHA256, occurrenceDigest: scope.occurrenceDigest},
    recordingMapping: {doctorRef: scope.doctorRef, appointmentRef: scope.appointmentRef, patientRefSHA256: scope.patientRefSHA256}};
  const observation = {schema: 1, kind: 'zoom-bot', source: 'normal-zoom-ui-and-scoped-recall-observation', executionKind: 'live',
    runId, requestNonce: request.requestNonce, collectorSHA256, scope,
    consent: {source: 'normal-zoom-host-consent-ui', action: 'approve_recording', actionId: randomUUID(), artifactSHA256: digest('3'),
      hostIdSHA256: scope.hostIdSHA256, meetingIdSHA256: scope.meetingIdSHA256, occurrenceDigest: scope.occurrenceDigest,
      observedAtEpochMs: start + 12000},
    recordingEvidence: {source: 'normal-zoom-host-consent-ui', action: 'recording_active', actionId: randomUUID(),
      artifactSHA256: digest('4'), hostIdSHA256: scope.hostIdSHA256, meetingIdSHA256: scope.meetingIdSHA256,
      occurrenceDigest: scope.occurrenceDigest, observedAtEpochMs: start + 15000},
    core: {source: 'scoped-staging-zoom-recording-correspondence', before: correspondence, after: {...clone(correspondence), readSequence: 3}},
    provider: {source: 'scoped-recall-get-response', httpStatus: 200, readSequence: 2, botIdSHA256: scope.botIdSHA256,
      meetingIdSHA256: scope.meetingIdSHA256, statusChanges: [
        {code: 'joining_call', subCode: null, createdAt: timestamp(5000)},
        {code: 'in_call_not_recording', subCode: null, createdAt: timestamp(14000)},
      ], recordings: [{idSHA256: scope.recordingIdSHA256, botIdSHA256: scope.botIdSHA256, statusCode: 'processing',
        startedAt: timestamp(14000), completedAt: null}]}, teardown: null};
  return {executionKind: 'mock', expected, observation, request, now: start + 60000};
}
function later(input) {
  const value = clone(input); value.now += 1000;
  value.request = {requestNonce: randomUUID(), sentAtEpochMs: value.now - 100, receivedAtEpochMs: value.now - 10};
  value.observation.requestNonce = value.request.requestNonce;
  return value;
}
function stopped(input) {
  const value = later(input), observation = value.observation;
  for (const side of ['before', 'after']) {
    observation.core[side].meetingStatus = 'ended';
    observation.core[side].meetingRuntime = {botIdSHA256: null, occurrenceDigest: null, mergeGeneration: null};
  }
  observation.provider.statusChanges.push({code: 'call_ended', subCode: null, createdAt: timestamp(60000)},
    {code: 'done', subCode: null, createdAt: timestamp(60010)});
  observation.provider.recordings[0].statusCode = 'done'; observation.provider.recordings[0].completedAt = timestamp(60000);
  observation.teardown = {source: 'scoped-core-canonical-meeting-end-release', botIdSHA256: observation.scope.botIdSHA256,
    occurrenceDigest: observation.scope.occurrenceDigest, generation: null, inventory: 'UNKNOWN',
    hostEnd: {source: 'normal-zoom-host-end-ui', action: 'end_meeting_for_all', actionId: randomUUID(), artifactSHA256: digest('5'),
      hostIdSHA256: observation.scope.hostIdSHA256, meetingIdSHA256: observation.scope.meetingIdSHA256,
      occurrenceDigest: observation.scope.occurrenceDigest, actionStartedAtEpochMs: start + 59995, observedAtEpochMs: start + 60005},
    canonicalIntent: {action: 'release', stopRecording: true, cleanupSession: true, markMeetingEnded: true},
    release: {id: typed('webhook_delivery'), eventType: 'internal.zoom_bot_release', providerEventDigest: digest('6'),
      state: 'completed', receivedAt: timestamp(60010), processedAt: timestamp(60020), leaseExpiresAt: null, lastErrorCode: null}};
  return value;
}
const check = (gate, input, state = 'recording') => gate.validate(input.observation, state, {request: input.request, now: input.now});

test('mock contract: actual data fields qualify only the pinned recording scope, not a live acceptance result', () => {
  const value = fixture(), gate = new BotCaptureProofGate(value.expected);
  assert.equal(value.executionKind, 'mock'); assert.equal(check(gate, value), value.observation);
  assert.match(gate.captureIdentity, /^[a-f0-9]{64}$/);
  // A transition may be old while a fresh exact GET still observes recording.
  const next = later(value); assert.equal(check(gate, next), next.observation);
  assert.equal('nativeSessionId' in next.observation, false);
  assert.equal('verified' in next.observation, false);
});
test('configuration requires explicit complete scope and a pinned collector', () => {
  const {expected} = fixture();
  for (const modify of [v => {delete v.collectorSHA256;}, v => {v.runId = 'made-up';}, v => {v.doctorRef = 'unknown';},
    v => {v.startedAtEpochMs = NaN;}, v => {v.providerToken = 'not allowed';}]) {
    const value = clone(expected); modify(value); assert.throws(() => new BotCaptureProofGate(value), /bot_expected_scope_invalid/);
  }
});
test('partial early Core recording keys keep the fixture gate closed without borrowing the bot ID', () => {
  for (const side of ['before', 'after']) for (const key of ['doctorRef', 'appointmentRef', 'patientRefSHA256']) {
    const value = fixture(), gate = new BotCaptureProofGate(value.expected), partial = clone(value);
    partial.observation.core[side].recordingMapping[key] = null;
    assert.throws(() => check(gate, partial), /bot_recording_mapping_pending_or_foreign/);
    // Before any admission, a later complete read can legitimately become ready.
    assert.equal(check(gate, value), value.observation);
  }
  const value = fixture(); value.observation.scope.recordingIdSHA256 = value.observation.scope.botIdSHA256;
  assert.throws(() => check(new BotCaptureProofGate(value.expected), value), /bot_scope_mismatch/);
});
test('R11 regression: advisory in_call_not_recording qualifies with one exact active durable recording', () => {
  const value = fixture(), gate = new BotCaptureProofGate(value.expected);
  assert.equal(value.observation.provider.statusChanges.at(-1).code, 'in_call_not_recording');
  assert.equal(check(gate, value), value.observation);
});
test('exact active provider row and current Core authority remain mandatory', () => {
  for (const mutate of [
    v => {v.provider.recordings[0].startedAt = null;},
    v => {v.provider.recordings[0].completedAt = timestamp(15000);},
    v => {v.provider.recordings[0].statusCode = 'paused';},
    v => {v.provider.source = 'start_recording_post_response';},
    v => {v.core.before.authorization.consumedAt = null;},
    v => {v.core.after.authorization.expiresAt = timestamp(5000);},
  ]) {
    const value = fixture(); mutate(value.observation);
    assert.throws(() => check(new BotCaptureProofGate(value.expected), value));
  }
});
test('normal host consent evidence is required independently of provider recording status', () => {
  for (const mutate of [v => {v.consent = null;}, v => {v.consent.source = 'operator_verified';},
    v => {v.consent.action = 'connect';}, v => {v.consent.artifactSHA256 = '';}, v => {v.consent.actionId = 'yes';},
    v => {v.consent.hostIdSHA256 = digest('9');}, v => {v.consent.meetingIdSHA256 = digest('9');},
    v => {v.consent.occurrenceDigest = digest('9');}, v => {v.consent.observedAtEpochMs = start - 1;}]) {
    const value = fixture(); mutate(value.observation);
    assert.throws(() => check(new BotCaptureProofGate(value.expected), value), /bot_normal_host_consent_missing/);
  }
});
test('distinct visible REC evidence is required and pinned independently of consent', () => {
  for (const mutate of [v => {v.recordingEvidence = null;}, v => {v.recordingEvidence.source = 'operator_verified';},
    v => {v.recordingEvidence.action = 'approve_recording';}, v => {v.recordingEvidence.artifactSHA256 = '';},
    v => {v.recordingEvidence.actionId = 'yes';}, v => {v.recordingEvidence.actionId = v.consent.actionId;},
    v => {v.recordingEvidence.artifactSHA256 = v.consent.artifactSHA256;},
    v => {v.recordingEvidence.hostIdSHA256 = digest('9');}, v => {v.recordingEvidence.meetingIdSHA256 = digest('9');},
    v => {v.recordingEvidence.occurrenceDigest = digest('9');}, v => {v.recordingEvidence.observedAtEpochMs = start - 1;}]) {
    const value = fixture(); mutate(value.observation);
    assert.throws(() => check(new BotCaptureProofGate(value.expected), value), /bot_normal_rec_indicator_missing/);
  }
});
test('foreign account, host, doctor, patient, appointment, occurrence or resource is refused', () => {
  for (const key of ['accountIdentitySHA256', 'hostIdSHA256', 'doctorRef', 'patientRefSHA256', 'appointmentRef', 'occurrenceDigest']) {
    const value = fixture(); value.observation.scope[key] = 'foreign';
    assert.throws(() => check(new BotCaptureProofGate(value.expected), value), /bot_scope_mismatch/);
  }
  for (const mutate of [v => {v.core.after.scope.botIdSHA256 = digest('9');},
    v => {v.core.before.meetingRuntime.occurrenceDigest = digest('9');},
    v => {v.provider.botIdSHA256 = digest('9');}, v => {v.provider.recordings[0].botIdSHA256 = digest('9');},
    v => {v.provider.recordings[0].idSHA256 = digest('9');}, v => {v.provider.recordings.push(clone(v.provider.recordings[0]));}]) {
    const value = fixture(); mutate(value.observation); assert.throws(() => check(new BotCaptureProofGate(value.expected), value));
  }
});
test('a late response cannot restamp its nonce or escape the entire local request freshness window', () => {
  for (const mutate of [v => {v.now += BOT_PROOF_MAX_AGE_MS;}, v => {v.request.receivedAtEpochMs = v.request.sentAtEpochMs - 1;},
    v => {v.request.receivedAtEpochMs = v.now + 100;}, v => {v.request.sentAtEpochMs -= 3000;},
    v => {v.request.sentAtEpochMs = NaN;}, v => {v.observation.requestNonce = randomUUID();},
    v => {v.observation.collectorSHA256 = digest('9');}, v => {v.observation.executionKind = 'mock';},
    v => {v.observation.provider.readSequence = v.observation.core.before.readSequence;},
    v => {v.observation.provider.httpStatus = 503;}]) {
    const value = fixture(); mutate(value); assert.throws(() => check(new BotCaptureProofGate(value.expected), value));
  }
});
test('bot status is only a terminal-negative guard while unknown and malformed history fail closed', () => {
  for (const advisory of ['recording_permission_denied', 'in_waiting_room']) {
    const value = fixture(); value.observation.provider.statusChanges.at(-1).code = advisory;
    assert.equal(check(new BotCaptureProofGate(value.expected), value), value.observation);
  }
  for (const mutate of [v => {v.provider.statusChanges.at(-1).code = 'new_unknown_status';},
    v => {v.provider.statusChanges[0].createdAt = timestamp(20000);},
    v => {v.provider.statusChanges[1].createdAt = 'unknown';},
    v => {v.provider.statusChanges.push({code: 'call_ended', subCode: null, createdAt: timestamp(15000)});},
    v => {v.provider.statusChanges.at(-1).message = 'unprojected body';}]) {
    const value = fixture(); mutate(value.observation); assert.throws(() => check(new BotCaptureProofGate(value.expected), value));
  }
});
test('future provider times or impossible start/consumption/completion chronology cannot qualify', () => {
  for (const mutate of [v => {v.provider.statusChanges.at(-1).createdAt = timestamp(120000);},
    v => {v.provider.recordings[0].startedAt = timestamp(120000);},
    v => {v.provider.recordings[0].startedAt = timestamp(0);},
    v => {v.provider.recordings[0].startedAt = 'invalid';},
    v => {v.core.before.authorization.consumedAt = v.core.after.authorization.consumedAt = timestamp(40000);},
    v => {v.consent.observedAtEpochMs = start + 40000;},
    v => {v.recordingEvidence.observedAtEpochMs = start + 120000;}]) {
    const value = fixture(); mutate(value.observation);
    assert.throws(() => check(new BotCaptureProofGate(value.expected), value));
  }
  for (const mutate of [v => {v.provider.recordings[0].completedAt = timestamp(120000);},
    v => {v.provider.recordings[0].completedAt = 'invalid';},
    v => {v.provider.recordings[0].completedAt = timestamp(1000);},
    v => {v.teardown.release.processedAt = timestamp(120000);}]) {
    const value = fixture(), gate = new BotCaptureProofGate(value.expected); check(gate, value);
    const done = stopped(value); mutate(done.observation); assert.throws(() => check(gate, done, 'stopped'));
  }
});
test('proof objects reject arbitrary body, URL and native-receipt fields instead of retaining them', () => {
  for (const mutate of [v => {v.sessionId = 'pretend-native';}, v => {v.nativeState = 'recording';},
    v => {v.provider.token = 'secret';}, v => {v.provider.recordings[0].downloadUrl = 'https://example.invalid/private';},
    v => {v.consent.promptText = 'unprojected';}, v => {v.recordingEvidence.promptText = 'unprojected';}]) {
    const value = fixture(); mutate(value.observation); assert.throws(() => check(new BotCaptureProofGate(value.expected), value));
  }
});
test('current recording identity, UI evidence and accepted history cannot be rewritten after admission', () => {
  for (const mutate of [v => {v.consent.actionId = randomUUID();}, v => {v.provider.statusChanges[0].subCode = 'changed';},
    v => {v.recordingEvidence.actionId = randomUUID();}, v => {v.recordingEvidence.observedAtEpochMs += 100;},
    v => {v.consent.observedAtEpochMs += 100;}, v => {v.provider.recordings[0].startedAt = timestamp(14001);},
    v => {v.core.before.authorization.expiresAt = v.core.after.authorization.expiresAt = timestamp(400000);},
    v => {v.provider.statusChanges.shift();}]) {
    const value = fixture(), gate = new BotCaptureProofGate(value.expected); check(gate, value);
    const next = later(value); mutate(next.observation);
    assert.throws(() => check(gate, next));
    assert.throws(() => check(gate, later(value)), /bot_recording_restart_forbidden/);
  }
});
test('a previously seen nonce cannot be reissued with a new receive window', () => {
  const value = fixture(), gate = new BotCaptureProofGate(value.expected); check(gate, value);
  const next = later(value); check(gate, next);
  const replay = later(next); replay.request.requestNonce = value.request.requestNonce;
  replay.observation.requestNonce = value.request.requestNonce;
  assert.throws(() => check(gate, replay), /bot_nonce_replayed_with_changed_observation/);
});
test('property order is immaterial while provider event ordering and the expected scope stay pinned', () => {
  const value = fixture(), gate = new BotCaptureProofGate(value.expected); check(gate, value);
  value.expected.doctorRef = 'changed after construction';
  const next = later(value);
  next.observation.provider.statusChanges = next.observation.provider.statusChanges.map(row => ({createdAt: row.createdAt, subCode: row.subCode, code: row.code}));
  assert.equal(check(gate, next), next.observation);
});
test('stop needs the admitted recording, terminal provider, normal End and one completed canonical release; inventory remains unknown', () => {
  const value = fixture(), done = stopped(value);
  assert.throws(() => check(new BotCaptureProofGate(value.expected), done, 'stopped'), /bot_stop_not_confirmed/);
  const gate = new BotCaptureProofGate(value.expected); check(gate, value);
  assert.equal(check(gate, done, 'stopped'), done.observation);
  assert.throws(() => check(gate, later(value)), /bot_recording_restart_forbidden/);
  for (const mutate of [v => {v.provider.statusChanges = v.provider.statusChanges.slice(0, 2);},
    v => {v.provider.recordings[0].statusCode = 'processing';}, v => {v.provider.recordings[0].completedAt = null;},
    v => {v.core.after.meetingStatus = 'started';}, v => {v.core.after.meetingRuntime.botIdSHA256 = digest('9');},
    v => {v.core.after.recordingMapping = null;}, v => {v.teardown = null;}, v => {v.teardown.release = null;},
    v => {v.teardown.inventory = 'COMPLETE';},
    v => {v.teardown.release.state = 'retry_wait';}, v => {v.teardown.release.leaseExpiresAt = timestamp(90000);},
    v => {v.teardown.release.lastErrorCode = 'provider_operation_uncertain';},
    v => {v.teardown.release.eventType = 'internal.zoom_bot_pause';}]) {
    const initial = fixture(), testGate = new BotCaptureProofGate(initial.expected); check(testGate, initial);
    const stoppedValue = stopped(initial); mutate(stoppedValue.observation);
    assert.throws(() => check(testGate, stoppedValue, 'stopped'));
  }
});
test('invalid post-admission state blocks source restart but still permits later proven stop', () => {
  const value = fixture(), gate = new BotCaptureProofGate(value.expected); check(gate, value);
  const failed = later(value); failed.observation.provider.httpStatus = 503;
  assert.throws(() => check(gate, failed)); assert.throws(() => check(gate, later(value)), /bot_recording_restart_forbidden/);
  assert.equal(check(gate, stopped(value), 'stopped').provider.recordings[0].statusCode, 'done');
});
test('producer failure latches the explicit bot union after admission without erasing later stop evidence', () => {
  const value = fixture(), gate = createCaptureProofGate({kind: 'zoom-bot', expected: value.expected});
  gate.observationFailed();
  assert.equal(check(gate, value), value.observation);
  const identity = gate.identity();
  gate.observationFailed(); gate.observationFailed();
  assert.throws(() => check(gate, later(value)), /bot_recording_restart_forbidden/);
  assert.equal(gate.identity(), identity);
  assert.equal(check(gate, stopped(value), 'idle').provider.recordings[0].statusCode, 'done');
  assert.equal(gate.identity(), identity);
  assert.throws(() => check(gate, later(stopped(value))), /bot_recording_restart_forbidden/);
});
test('explicit participant proof union preserves native checks and rejects either proof in the other branch', () => {
  const native = {scope: 'product-ui', targetId: 'owned', sessionId: 'native-session', observedAtEpochMs: start + 60000,
    consent: {sessionId: 'native-session', state: 'granted'},
    capture: {sessionId: 'native-session', state: 'recording', nativeState: 'recording', elapsedSeconds: 1}};
  assert.equal(createCaptureProofGate().validate(native, 'recording', {now: start + 60000}), native);
  assert.throws(() => createCaptureProofGate().validate({...native, kind: 'zoom-bot'}, 'recording', {now: start + 60000}), /capture-proof-kind-mismatch/);
  assert.throws(() => validateProductObservation({...native, capture: {...native.capture, nativeState: undefined}}, 'recording', start + 60000));
  const value = fixture(), bot = createCaptureProofGate({kind: 'zoom-bot', expected: value.expected});
  assert.equal(bot.validate(value.observation, 'recording', {request: value.request, now: value.now}), value.observation);
  assert.throws(() => createCaptureProofGate().validate(value.observation, 'recording', {now: value.now}));
  assert.throws(() => bot.validate(native, 'recording', {request: value.request, now: value.now}));
  assert.throws(() => createCaptureProofGate({kind: 'zoom-bot'}));
  assert.throws(() => createCaptureProofGate({kind: 'native', expected: value.expected}));
  assert.throws(() => createCaptureProofGate({kind: 'unknown'}));
});

test('canonical End receipt refuses wrong bot, occurrence, generation, flags and unsettled rows', () => {
  for (const mutate of [
    v => {v.teardown.botIdSHA256 = digest('9');}, v => {v.teardown.occurrenceDigest = digest('9');},
    v => {v.teardown.generation = 1;}, v => {v.core.before.meetingRuntime.mergeGeneration = 1;},
    v => {v.core.after.meetingRuntime.mergeGeneration = 1;}, v => {delete v.core.before.meetingRuntime.mergeGeneration;},
    v => {v.teardown.generation = -1;}, v => {v.teardown.generation = 0.5;},
    v => {v.teardown.canonicalIntent.cleanupSession = false;}, v => {v.teardown.canonicalIntent.markMeetingEnded = false;},
    v => {v.teardown.canonicalIntent.stopRecording = false;}, v => {v.teardown.canonicalIntent.action = 'pause';},
    v => {v.teardown.release.state = 'processing';}, v => {v.teardown.release.state = 'dead_letter';},
    v => {v.teardown.release.processedAt = null;}, v => {v.teardown.release.receivedAt = timestamp(62000);},
    v => {v.teardown.release.processedAt = timestamp(59900);}, v => {v.teardown.release.providerEventDigest = 'unknown';},
    v => {v.teardown.matchingRowCount = 1;}, v => {v.teardown.source = 'scoped-core-teardown-rows';},
  ]) {
    const initial = fixture(), gate = new BotCaptureProofGate(initial.expected); check(gate, initial);
    const done = stopped(initial); mutate(done.observation);
    assert.throws(() => check(gate, done, 'stopped'));
    assert.throws(() => check(gate, later(initial)), /bot_recording_restart_forbidden/);
  }
});
test('host End must be actual same-scope normal End after the latest admitted recording observation', () => {
  for (const mutate of [
    v => {v.teardown.hostEnd = null;}, v => {v.teardown.hostEnd.source = 'operator_verified';},
    v => {v.teardown.hostEnd.action = 'leave_meeting';}, v => {v.teardown.hostEnd.actionId = 'unknown';},
    v => {v.teardown.hostEnd.artifactSHA256 = '';}, v => {v.teardown.hostEnd.hostIdSHA256 = digest('9');},
    v => {v.teardown.hostEnd.meetingIdSHA256 = digest('9');}, v => {v.teardown.hostEnd.occurrenceDigest = digest('9');},
    v => {v.teardown.hostEnd.actionStartedAtEpochMs = start + 50000;},
    v => {v.teardown.hostEnd.actionStartedAtEpochMs = start + 60006;},
    v => {v.teardown.hostEnd.observedAtEpochMs = start + 65000;},
    v => {v.teardown.release.receivedAt = timestamp(52000);},
  ]) {
    const initial = fixture(), gate = new BotCaptureProofGate(initial.expected); check(gate, initial);
    const done = stopped(initial); mutate(done.observation);
    assert.throws(() => check(gate, done, 'stopped'));
  }
});
test('an exact canonical End can prove this capture stopped while other release inventory remains UNKNOWN', () => {
  const initial = fixture(), gate = new BotCaptureProofGate(initial.expected); check(gate, initial);
  const done = stopped(initial);
  for (const side of ['before', 'after']) done.observation.core[side].meetingRuntime.mergeGeneration = 2;
  done.observation.teardown.generation = 2;
  const accepted = check(gate, done, 'stopped');
  assert.equal(accepted.teardown.inventory, 'UNKNOWN');
  assert.equal('matchingRowCount' in accepted.teardown, false);
  assert.equal('allResourcesSettled' in accepted, false);
  // Another pending generation-3 release cannot be inferred absent from this
  // exact generation-2 receipt; this gate makes no exhaustive queue assertion.
  const repeated = later(done); assert.equal(check(gate, repeated, 'stopped'), repeated.observation);
  const swappedEnd = later(repeated); swappedEnd.observation.teardown.hostEnd.actionId = randomUUID();
  assert.throws(() => check(gate, swappedEnd, 'stopped'), /bot_end_evidence_changed/);
  assert.throws(() => check(gate, later(initial)), /bot_recording_restart_forbidden/);
});
