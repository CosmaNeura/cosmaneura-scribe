import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeTimingMeasurement } from './native-timing.mjs';
import { sha256 } from './journal.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { runId: id(1), workspaceId: id(2), appointmentRef: 'appointment_01m5q8r3kzeng9szb5frh6ppk3',
  sessionId: id(3), recorderId: id(4), authRevision: id(5) };
const sample = (revision, ns, sent, received, attempt = 1, dropped = 0) => ({ source: 'normal-native-timing-response',
  ...scope, nativeRevision: revision, requestId: id(revision + 10), method: 'providerRecordingCommand', kind: 'read',
  sample: { version: 1, clock: 'dispatch-uptime-ns', monotonicNs: ns, captureAttempt: attempt, droppedEvents: dropped },
  transport: { clock: 'performance-now-ms', sentAtMonotonicMs: sent, receivedAtMonotonicMs: received, browserTimeOriginMs: 9999,
    roundTripMs: received - sent, browserTimestampPrecision: 'UNKNOWN', browserTimestampResolutionMs: null,
    totalUncertaintyMs: null, qualification: 'NOT_ESTABLISHED' } });
const history = samples => ({ source: 'passive-native-timing-history', ...scope, maximumSamples: 128,
  evictedSamples: 0, invalidSamples: 0, unavailableSamples: 0, discardedRevisionSamples: 0, samples });
const event = (name, ns, attempt = 1, dropped = 0) => ({ utc: '2026-10-25T12:00:00.000Z', event: name,
  clock: 'dispatch-uptime-ns', monotonic_ns: ns, capture_attempt: attempt, dropped_events: dropped });
const bytes = entries => Buffer.from(JSON.stringify(entries));

test('subtracts integer native anchors before conversion and keeps transport-only browser estimates unqualified', () => {
  const anchor = 18446744073600000000n;
  const samples = [sample(1, anchor.toString(), 100, 102), sample(2, (anchor + 1000000n).toString(), 101, 103)];
  const journalBytes = bytes([event('startRequested', (anchor + 100000n).toString()), event('firstInputSignal', (anchor + 900001n).toString())]);
  const result = buildNativeTimingMeasurement({ history: history(samples), journalBytes, intervals: [['startRequested', 'firstInputSignal']] });
  assert.equal(result.correlation.anchorNativeNs, anchor.toString());
  assert.equal(result.correlation.transportBracketWidthMs, 2);
  assert.equal(result.correlation.totalUncertaintyMs, null);
  assert.equal(result.correlation.browserTimestampPrecision, 'UNKNOWN');
  assert.equal(result.qualification, 'NOT_ESTABLISHED');
  assert.equal(result.nativeIntervals[0].durationNs, '800001');
  assert.equal(result.nativeIntervals[0].durationMs, 0.800001);
  assert.equal(result.nativeIntervals[0].journalAttribution, 'NOT_ESTABLISHED');
  assert.equal(result.journal.sha256, sha256(journalBytes));
  assert.equal(result.journal.provenance, 'REQUIRES_OWNED_PROCESS_EXPORT');
});
test('equal quantized readings and inconsistent intersections never establish total precision or synchronization', () => {
  const first = sample(1, '1000000000', 100, 100);
  const equal = buildNativeTimingMeasurement({ history: history([first]) });
  assert.equal(equal.correlation.transportBracketWidthMs, 0); assert.equal(equal.correlation.totalUncertaintyMs, null);
  assert.equal(equal.correlation.browserTimestampResolutionMs, null);
  const inconsistent = buildNativeTimingMeasurement({ history: history([first, sample(2, '1000500000', 100, 100)]) });
  assert.equal(inconsistent.correlation.transportStatus, 'INCONSISTENT');
  assert.equal(inconsistent.correlation.transportBracketWidthMs, null);
  assert.equal(inconsistent.captureSynchronization, 'NOT_ESTABLISHED');
});
test('rejects foreign bindings, revisions, clock origins, regressing native time, attempts and drop counters', () => {
  const base = [sample(1, '1000000000', 100, 110, 1, 3), sample(2, '1100000000', 200, 210, 1, 3)];
  for (const change of [value => { value.sessionId = id(50); }, value => { value.recorderId = id(50); },
    value => { value.authRevision = id(50); }, value => { value.workspaceId = id(50); },
    value => { value.nativeRevision = 1; }, value => { value.sample.monotonicNs = '999999999'; },
    value => { value.sample.captureAttempt = 0; }, value => { value.sample.droppedEvents = 2; },
    value => { value.transport.browserTimeOriginMs++; }]) {
    const next = structuredClone(base); change(next[1]);
    assert.throws(() => buildNativeTimingMeasurement({ history: history(next) }), /native_timing_(scope_changed|sequence_invalid)/);
  }
  const newAttempt = structuredClone(base); newAttempt[1].sample.captureAttempt = 2; newAttempt[1].sample.droppedEvents = 0;
  assert.equal(buildNativeTimingMeasurement({ history: history(newAttempt) }).sampleCount, 2);
});
test('malformed or expanded timing data and made-up browser precision are rejected', () => {
  for (const change of [value => { value.sample.monotonicNs = '01'; }, value => { value.sample.monotonicNs = '18446744073709551616'; },
    value => { value.sample.private = 'never retain'; }, value => { value.sample.captureAttempt = -1; },
    value => { value.transport.totalUncertaintyMs = 0; }, value => { value.transport.browserTimestampPrecision = '1ms'; },
    value => { value.transport.roundTripMs++; }, value => { value.kind = 'close'; }]) {
    const value = sample(1, '1000000000', 100, 110); change(value);
    assert.throws(() => buildNativeTimingMeasurement({ history: history([value]) }), /native_timing_sample_invalid/);
  }
});
test('native intervals require unique endpoints inside the observed same-attempt sample window', () => {
  const samples = [sample(1, '1000000000', 100, 110, 0), sample(2, '1300000000', 400, 410, 1)];
  for (const [events, expected] of [
    [[event('startRequested', '1100000000'), event('firstInputSignal', '1200000000')], 'MEASURED'],
    [[event('startRequested', '1100000000'), event('firstInputSignal', '1200000000', 2)], 'NOT_OBSERVED'],
    [[event('startRequested', '900000000'), event('firstInputSignal', '1200000000')], 'OUTSIDE_OBSERVED_WINDOW'],
    [[event('startRequested', '1100000000'), event('firstInputSignal', '1400000000')], 'OUTSIDE_OBSERVED_WINDOW'],
    [[event('startRequested', '1100000000'), event('startRequested', '1150000000'), event('firstInputSignal', '1200000000')], 'AMBIGUOUS'],
  ]) {
    const result = buildNativeTimingMeasurement({ history: history(samples), journalBytes: bytes(events), intervals: [['startRequested', 'firstInputSignal']] });
    assert.equal(result.nativeIntervals[0].status, expected);
    if (expected !== 'MEASURED') assert.equal(result.nativeIntervals[0].durationNs, null);
  }
});
test('zero native drops never establish ring completeness and renderer record-ready durations are not native intervals', () => {
  const h = history([sample(1, '1000000000', 100, 110), sample(2, '1200000000', 300, 310)]); h.evictedSamples = 2;
  const journalBytes = bytes([event('startRequested', '1100000000'), { ...event('recordToNativeReady', '1150000000'), duration_ms: 0.1 }]);
  const result = buildNativeTimingMeasurement({ history: h, journalBytes });
  assert.equal(result.journal.completeness, 'UNKNOWN');
  assert.equal(result.journal.ringEvictionAndWriteFailureAccountedByDropCounter, false);
  assert.equal(result.observerRetention.evictedSamples, 2);
  assert.equal(result.nativeIntervals.find(value => value.endEvent === 'firstInputSignal').status, 'NOT_OBSERVED');
  assert.throws(() => buildNativeTimingMeasurement({ history: h, journalBytes, intervals: [['startRequested', 'recordToNativeReady']] }), /endpoints_invalid/);
  assert.equal(Object.hasOwn(result.journal.events[1], 'duration_ms'), false);
});
test('wall-clock values are not used in native duration or transport correlation', () => {
  const h = history([sample(1, '1000000000', 100, 110), sample(2, '1200000000', 300, 310)]);
  const events = [event('startRequested', '1050000000'), event('firstInputSignal', '1150000000')];
  const first = buildNativeTimingMeasurement({ history: h, journalBytes: bytes(events), intervals: [['startRequested', 'firstInputSignal']] });
  events[0].utc = '2026-10-26T00:00:00Z'; events[1].utc = '2026-10-24T00:00:00Z';
  const jumped = buildNativeTimingMeasurement({ history: h, journalBytes: bytes(events), intervals: [['startRequested', 'firstInputSignal']] });
  assert.deepEqual(first.nativeIntervals, jumped.nativeIntervals); assert.deepEqual(first.correlation, jumped.correlation);
});
test('missing timing stays explicitly unavailable and journal parsing is bounded and metadata-only', () => {
  const empty = buildNativeTimingMeasurement({ history: history([]) });
  assert.equal(empty.correlation, null); assert.deepEqual(empty.nativeIntervals, []); assert.equal(empty.qualification, 'NOT_ESTABLISHED');
  for (const journalBytes of [Buffer.from('malformed-private-content'), Buffer.alloc(32769), bytes(Array(129).fill(event('startRequested', '1'))),
    bytes([{ ...event('startRequested', '1'), private: 'never retain' }]),
    bytes([event('firstInputSignal', '2'), event('startRequested', '1')])])
    assert.throws(() => buildNativeTimingMeasurement({ history: history([]), journalBytes }), /native_timing_journal_invalid/);
});
