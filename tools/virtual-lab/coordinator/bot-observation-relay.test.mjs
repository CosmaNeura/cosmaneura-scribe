import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createBotObservationRelay, createBotObservationRelayClient} from './bot-observation-relay.mjs';

// Synthetic contract fixtures over real loopback sockets. No account, provider,
// consent action, microphone, or live recording is used or qualified here.
function fixture() {
  const start = Date.now() - 60000, iso = offset => new Date(start + offset).toISOString();
  const hash = digit => digit.repeat(64), typed = prefix => `${prefix}_${'0'.repeat(26)}`;
  const expected = {runId: randomUUID(), collectorSHA256: hash('a'), startedAtEpochMs: start,
    accountIdentitySHA256: hash('b'), doctorRef: typed('doctor'), patientRefSHA256: hash('c'), hostIdSHA256: hash('d'),
    meetingRecordRef: typed('zmtg'), meetingIdSHA256: hash('e'), appointmentRef: typed('appointment'), occurrenceDigest: hash('f')};
  const {runId, collectorSHA256, startedAtEpochMs, ...scope} = expected;
  Object.assign(scope, {botIdSHA256: hash('1'), recordingIdSHA256: hash('2')});
  const core = {readSequence: 1, scope, meetingStatus: 'started',
    authorization: {occurrenceDigest: scope.occurrenceDigest, consumedAt: iso(6000), expiresAt: iso(300000)},
    meetingRuntime: {botIdSHA256: scope.botIdSHA256, occurrenceDigest: scope.occurrenceDigest},
    recordingMapping: {doctorRef: scope.doctorRef, appointmentRef: scope.appointmentRef, patientRefSHA256: scope.patientRefSHA256}};
  const observation = {schema: 1, kind: 'zoom-bot', source: 'normal-zoom-ui-and-scoped-recall-observation', executionKind: 'live',
    runId, requestNonce: randomUUID(), collectorSHA256, scope,
    consent: {source: 'normal-zoom-host-consent-ui', action: 'approve_recording', actionId: randomUUID(), artifactSHA256: hash('3'),
      hostIdSHA256: scope.hostIdSHA256, meetingIdSHA256: scope.meetingIdSHA256, occurrenceDigest: scope.occurrenceDigest,
      observedAtEpochMs: start + 12000},
    core: {source: 'scoped-staging-zoom-recording-correspondence', before: core, after: {...structuredClone(core), readSequence: 3}},
    provider: {source: 'scoped-recall-get-response', httpStatus: 200, readSequence: 2, botIdSHA256: scope.botIdSHA256,
      meetingIdSHA256: scope.meetingIdSHA256, statusChanges: [
        {code: 'joining_call', subCode: null, createdAt: iso(5000)},
        {code: 'recording_permission_allowed', subCode: null, createdAt: iso(13000)},
        {code: 'in_call_recording', subCode: null, createdAt: iso(14000)},
      ], recordings: [{idSHA256: scope.recordingIdSHA256, botIdSHA256: scope.botIdSHA256, statusCode: 'processing',
        startedAt: iso(14000), completedAt: null}]}, teardown: null};
  return {expected, observation, hash, typed};
}
function stopped(input) {
  const value = structuredClone(input.observation), at = Date.now(), iso = new Date(at).toISOString();
  for (const side of ['before', 'after']) {
    value.core[side].meetingStatus = 'ended';
    value.core[side].meetingRuntime = {botIdSHA256: null, occurrenceDigest: null, mergeGeneration: null};
  }
  value.provider.statusChanges.push({code: 'call_ended', subCode: null, createdAt: iso}, {code: 'done', subCode: null, createdAt: iso});
  Object.assign(value.provider.recordings[0], {statusCode: 'done', completedAt: iso});
  value.teardown = {source: 'scoped-core-canonical-meeting-end-release', botIdSHA256: value.scope.botIdSHA256,
    occurrenceDigest: value.scope.occurrenceDigest, generation: null, inventory: 'UNKNOWN',
    hostEnd: {source: 'normal-zoom-host-end-ui', action: 'end_meeting_for_all', actionId: randomUUID(), artifactSHA256: input.hash('4'),
      hostIdSHA256: value.scope.hostIdSHA256, meetingIdSHA256: value.scope.meetingIdSHA256, occurrenceDigest: value.scope.occurrenceDigest,
      actionStartedAtEpochMs: at, observedAtEpochMs: at},
    canonicalIntent: {action: 'release', stopRecording: true, cleanupSession: true, markMeetingEnded: true},
    release: {id: input.typed('webhook_delivery'), eventType: 'internal.zoom_bot_release', providerEventDigest: input.hash('5'),
      state: 'completed', receivedAt: iso, processedAt: iso, leaseExpiresAt: null, lastErrorCode: null}};
  return value;
}
async function setup(t, behavior) {
  const input = fixture(), controller = new AbortController();
  let calls = 0, last;
  const read = async (action, {requestNonce}) => {
    calls++;
    last = {...structuredClone(action === 'observeStopped' ? stopped(input) : input.observation), requestNonce};
    return behavior ? behavior(last, calls, action) : last;
  };
  const relay = await createBotObservationRelay({expected: input.expected, signal: controller.signal,
    collector: {observe: fields => read('observe', fields), observeStopped: fields => read('observeStopped', fields)}});
  const client = createBotObservationRelayClient({endpoint: relay.endpoint, signal: controller.signal});
  t.after(async () => { client.close(); await relay.close(); });
  return {input, controller, relay, client, calls: () => calls, last: () => last};
}
async function raw(endpoint, changes = {}, body) {
  const payload = body ?? JSON.stringify({version: 1, runId: endpoint.runId, action: 'observe', requestNonce: randomUUID(),
    capability: endpoint.capability, ...changes});
  return new Promise((resolve, reject) => {
    const request = http.request({host: '127.0.0.1', port: endpoint.port, path: '/', method: 'POST', agent: false,
      headers: {'Content-Type': 'application/json'}}, response => {
      let data = ''; response.on('data', b => {data += b;}); response.on('end', () => resolve({status: response.statusCode, data}));
    });
    request.on('error', reject); request.end(payload);
  });
}

test('real loopback carries the identical strict metadata DTO, never a renewed receipt', async t => {
  const s = await setup(t);
  assert.equal(s.relay.endpoint.host, '127.0.0.1');
  assert.deepEqual(Object.keys(s.relay).sort(), ['close', 'endpoint']);
  const value = await s.client.observe({requestNonce: randomUUID()});
  assert.deepEqual(value, s.last()); assert.equal(s.calls(), 1);
  assert.equal('receivedAtEpochMs' in value, false);
  await delay(5);
  const end = await s.client.observeStopped({requestNonce: randomUUID()});
  assert.deepEqual(end, s.last()); assert.equal(end.teardown.inventory, 'UNKNOWN');
  await assert.rejects(s.client.observe({requestNonce: randomUUID()}), /unavailable/);
});

test('wrong capability, run, extra fields, and non-observation actions never reach the collector', async t => {
  const s = await setup(t);
  for (const change of [{capability: '0'.repeat(64)}, {runId: randomUUID()}, {action: 'bindConsent'},
    {action: 'bindHostEnd'}, {action: 'discover'}, {action: 'stop'}, {token: 'not-allowed'}]) {
    assert.equal((await raw(s.relay.endpoint, change)).status, 400);
  }
  assert.equal(s.calls(), 0);
  await s.client.observe({requestNonce: randomUUID()}); assert.equal(s.calls(), 1);
});

test('duplicate nonce is refused and the collector runs once', async t => {
  const s = await setup(t), requestNonce = randomUUID();
  assert.equal((await raw(s.relay.endpoint, {requestNonce})).status, 200);
  assert.equal((await raw(s.relay.endpoint, {requestNonce})).status, 400);
  assert.equal(s.calls(), 1);
});

test('concurrent proof requests cannot overlap the collector lane', async t => {
  let release;
  const s = await setup(t, value => new Promise(resolve => {release = () => resolve(value);}));
  const first = s.client.observe({requestNonce: randomUUID()});
  while (!release) await delay(1);
  assert.equal((await raw(s.relay.endpoint)).status, 400); assert.equal(s.calls(), 1);
  release(); await first;
});

test('invalid or credential-bearing DTO is never relayed and recording cannot restart', async t => {
  const s = await setup(t, value => ({...value, providerToken: 'must-never-leave-collector'}));
  const response = await raw(s.relay.endpoint);
  assert.equal(response.status, 503); assert.equal(response.data.includes('must-never'), false);
  assert.equal((await raw(s.relay.endpoint)).status, 400); assert.equal(s.calls(), 1);
});

test('a recording observation failure still permits an explicit exact stop proof', async t => {
  const s = await setup(t, (value, calls) => { if (calls === 2) throw Error('private diagnostic'); return value; });
  await s.client.observe({requestNonce: randomUUID()});
  await assert.rejects(s.client.observe({requestNonce: randomUUID()}), /unavailable/);
  await assert.rejects(s.client.observe({requestNonce: randomUUID()}), /unavailable/);
  await delay(5);
  assert.equal((await s.client.observeStopped({requestNonce: randomUUID()})).provider.recordings[0].statusCode, 'done');
  assert.equal(s.calls(), 3);
});

test('late proof is refused within the unchanged two-second request budget', async t => {
  const s = await setup(t, async value => { await delay(2150); return value; });
  const began = performance.now();
  await assert.rejects(s.client.observe({requestNonce: randomUUID()}), /unavailable/);
  assert.ok(performance.now() - began < 2150);
  await delay(170);
  await assert.rejects(s.client.observe({requestNonce: randomUUID()}), /unavailable/);
  assert.equal(s.calls(), 1);
});

test('abort and explicit close settle owned sockets without invoking provider mutation', async t => {
  const s = await setup(t);
  await s.client.observe({requestNonce: randomUUID()});
  s.controller.abort();
  await assert.rejects(s.client.observe({requestNonce: randomUUID()}));
  const closed = await s.relay.close();
  assert.deepEqual(closed, {relayClosed: true, ownedConnectionsSettled: true, collectorRequestSettled: true});
  assert.equal(s.calls(), 1);
});

test('client accepts only a bounded loopback endpoint and no credential or external host options', async t => {
  const s = await setup(t);
  for (const change of [{host: '0.0.0.0'}, {host: 'example.com'}, {port: 0}, {port: 65536}, {capability: 'short'}, {url: 'https://example.com'}]) {
    assert.throws(() => createBotObservationRelayClient({endpoint: {...s.relay.endpoint, ...change}, signal: s.controller.signal}), /endpoint_invalid/);
  }
});

test('oversized and malformed requests expose no parser diagnostics', async t => {
  const s = await setup(t);
  for (const body of ['{', JSON.stringify({unexpected: 'x'.repeat(1200)})]) {
    const result = await raw(s.relay.endpoint, {}, body);
    assert.equal(result.status, 400); assert.equal(result.data, '{"error":"bot_relay_request_refused"}');
  }
  assert.equal(s.calls(), 0);
});
