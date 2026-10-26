import { sha256 } from './journal.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const uint64 = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value)
  && BigInt(value) <= 18446744073709551615n;
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
const scopeKeys = ['runId', 'workspaceId', 'appointmentRef', 'sessionId', 'recorderId', 'authRevision'];
const eventNames = new Set(['startRequested', 'ticketAccepted', 'permissionAccepted', 'authorityAccepted', 'handleCreated',
  'leaseReady', 'reservationsReady', 'sourcePrepareRequested', 'sourcePrepared', 'sourceConsumeRequested',
  'sourceReadyRequested', 'sourceReadyReceived', 'firstInputBuffer', 'firstInputSignal', 'firstConvertedBuffer',
  'firstConvertedSignal', 'startRejected', 'readyRequested', 'readyAccepted', 'readyRejected', 'driverStarting',
  'sessionActivated', 'tapInstalled', 'engineStarted', 'driverArmed', 'driverRejected', 'engineConfigurationChanged',
  'sessionConfigurationChanged', 'routeChanged', 'interrupted', 'mediaServicesLost', 'mediaServicesReset',
  'backgrounded', 'permissionRevoked', 'captureFailed', 'inputFrozen', 'driverReleased', 'stopRequested',
  'stopAccepted', 'stopRejected', 'recordToNativeReady', 'inputAdmissionOverflow', 'firstPacketPersistenceStarted',
  'firstPacketPersistenceCompleted', 'packetPersistenceFailed', 'driverAdmissionOverflow', 'pcmHeartbeatExpired',
  'pcmInvalidInput', 'pcmBufferOverflow', 'pcmOutputLimit', 'pcmSinkFailed', 'windowAuthorityExpired', 'windowFrameLimit',
  'windowInterrupted', 'windowRouteChanged', 'continuationAuthorityExpired', 'continuationSourceRetired',
  'continuationRenewalRejected', 'continuationCaptureFailed', 'continuationStorageFailed', 'continuationClosureUnconfirmed',
  'finalizationAuthorityChanged', 'finalizationStorageFailed', 'physicalStopRejected', 'sourceStopRejected']);

function project(value) {
  const sample = value?.sample, transport = value?.transport;
  if (value?.source !== 'normal-native-timing-response' || !['openProviderRecording', 'providerRecordingCommand'].includes(value.method)
      || !(value.method === 'openProviderRecording' ? value.kind === 'open' : ['read', 'start', 'pause', 'seal', 'input'].includes(value.kind))
      || ![value.runId, value.workspaceId, value.sessionId, value.recorderId, value.authRevision, value.requestId].every(uuid)
      || !/^appointment_[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(value.appointmentRef ?? '')
      || !Number.isSafeInteger(value.nativeRevision) || value.nativeRevision < 1
      || !sample || Object.keys(sample).sort().join() !== 'captureAttempt,clock,droppedEvents,monotonicNs,version'
      || sample.version !== 1 || sample.clock !== 'dispatch-uptime-ns' || !uint64(sample.monotonicNs)
      || !count(sample.captureAttempt) || !count(sample.droppedEvents)
      || transport?.clock !== 'performance-now-ms' || transport.browserTimestampPrecision !== 'UNKNOWN'
      || transport.browserTimestampResolutionMs !== null || transport.totalUncertaintyMs !== null
      || transport.qualification !== 'NOT_ESTABLISHED'
      || ![transport.sentAtMonotonicMs, transport.receivedAtMonotonicMs, transport.browserTimeOriginMs, transport.roundTripMs].every(Number.isFinite)
      || transport.sentAtMonotonicMs < 0 || transport.receivedAtMonotonicMs < transport.sentAtMonotonicMs
      || transport.roundTripMs !== transport.receivedAtMonotonicMs - transport.sentAtMonotonicMs) throw Error('native_timing_sample_invalid');
  return { source: value.source, ...Object.fromEntries(scopeKeys.map(key => [key, value[key]])), nativeRevision: value.nativeRevision,
    requestId: value.requestId, method: value.method, kind: value.kind, sample: { ...sample },
    transport: { clock: transport.clock, sentAtMonotonicMs: transport.sentAtMonotonicMs,
      receivedAtMonotonicMs: transport.receivedAtMonotonicMs, browserTimeOriginMs: transport.browserTimeOriginMs,
      roundTripMs: transport.roundTripMs, browserTimestampPrecision: 'UNKNOWN', browserTimestampResolutionMs: null,
      totalUncertaintyMs: null, qualification: 'NOT_ESTABLISHED' } };
}

/** Integer native offsets are preserved. The intersection is an estimate of
 * transport delay only: quantization, oscillator drift and total error remain
 * unqualified. Equal performance.now readings never imply zero uncertainty. */
function correlate(samples) {
  const anchor = BigInt(samples[0].sample.monotonicNs), timeOrigin = samples[0].transport.browserTimeOriginMs;
  let lower = -Infinity, upper = Infinity, previous = null;
  for (const value of samples) {
    const native = BigInt(value.sample.monotonicNs);
    if (value.transport.browserTimeOriginMs !== timeOrigin || native < anchor
        || native - anchor > BigInt(Number.MAX_SAFE_INTEGER)
        || previous && (value.nativeRevision <= previous.nativeRevision || native < BigInt(previous.sample.monotonicNs)
          || value.sample.captureAttempt < previous.sample.captureAttempt
          || value.sample.captureAttempt === previous.sample.captureAttempt && value.sample.droppedEvents < previous.sample.droppedEvents))
      throw Error('native_timing_sequence_invalid');
    const offsetMs = Number(native - anchor) / 1000000;
    lower = Math.max(lower, value.transport.sentAtMonotonicMs - offsetMs);
    upper = Math.min(upper, value.transport.receivedAtMonotonicMs - offsetMs);
    previous = value;
  }
  return { qualification: 'NOT_ESTABLISHED', nativeClock: 'dispatch-uptime-ns', browserClock: 'performance-now-ms',
    browserTimestampPrecision: 'UNKNOWN', browserTimestampResolutionMs: null, totalUncertaintyMs: null,
    anchorNativeNs: anchor.toString(), latestNativeNs: previous.sample.monotonicNs,
    transportStatus: upper < lower ? 'INCONSISTENT' : 'ESTIMATE_ONLY',
    estimatedBrowserAtAnchorLowerMs: upper < lower ? null : lower,
    estimatedBrowserAtAnchorUpperMs: upper < lower ? null : upper,
    transportBracketWidthMs: upper < lower ? null : upper - lower,
    roundTripMinimumMs: Math.min(...samples.map(value => value.transport.roundTripMs)),
    roundTripMaximumMs: Math.max(...samples.map(value => value.transport.roundTripMs)) };
}

function journal(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 32768) throw Error('native_timing_journal_invalid');
  let entries;
  try { entries = JSON.parse(bytes.toString('utf8')); } catch { throw Error('native_timing_journal_invalid'); }
  if (!Array.isArray(entries) || entries.length > 128) throw Error('native_timing_journal_invalid');
  let previous;
  const events = entries.map(value => {
    const keys = Object.keys(value ?? {});
    if (!value || keys.some(key => !['utc', 'event', 'clock', 'monotonic_ns', 'capture_attempt', 'dropped_events', 'duration_ms', 'build_number'].includes(key))
        || value.clock !== 'dispatch-uptime-ns' || !eventNames.has(value.event) || !uint64(value.monotonic_ns)
        || !count(value.capture_attempt) || !count(value.dropped_events)
        || typeof value.utc !== 'string' || !Number.isFinite(Date.parse(value.utc))
        || value.duration_ms !== undefined && (!Number.isFinite(value.duration_ms) || value.duration_ms < 0 || value.duration_ms > 3600000)
        || value.build_number !== undefined && (!count(value.build_number) || value.build_number === 0)
        || previous && (BigInt(value.monotonic_ns) < BigInt(previous.monotonic_ns)
          || value.capture_attempt < previous.capture_attempt
          || value.capture_attempt === previous.capture_attempt && value.dropped_events < previous.dropped_events)) throw Error('native_timing_journal_invalid');
    previous = value;
    // recordToNativeReady.duration_ms is renderer timing, not native timing.
    return { event: value.event, clock: value.clock, monotonicNs: value.monotonic_ns,
      captureAttempt: value.capture_attempt, droppedEvents: value.dropped_events };
  });
  return { sha256: sha256(bytes), byteLength: bytes.length, events,
    provenance: 'REQUIRES_OWNED_PROCESS_EXPORT', completeness: 'UNKNOWN',
    dropCounterMeaning: 'admission-budget-and-pending-queue-rejections-only',
    ringEvictionAndWriteFailureAccountedByDropCounter: false };
}

function interval(events, samples, captureAttempt, startEvent, endEvent, correlation) {
  if (![startEvent, endEvent].every(name => eventNames.has(name) && name !== 'recordToNativeReady') || startEvent === endEvent)
    throw Error('native_interval_endpoints_invalid');
  const base = { captureAttempt, startEvent, endEvent, measurementScope: 'native-clock-only', qualification: 'NOT_ESTABLISHED',
    journalAttribution: 'NOT_ESTABLISHED', browserTimeQualification: 'NOT_ESTABLISHED' };
  const candidates = events.filter(value => value.captureAttempt === captureAttempt);
  const starts = candidates.filter(value => value.event === startEvent), ends = candidates.filter(value => value.event === endEvent);
  if (!starts.length || !ends.length) return { ...base, status: 'NOT_OBSERVED', durationNs: null, durationMs: null };
  if (starts.length !== 1 || ends.length !== 1) return { ...base, status: 'AMBIGUOUS', durationNs: null, durationMs: null };
  const start = BigInt(starts[0].monotonicNs), end = BigInt(ends[0].monotonicNs);
  const last = samples.filter(value => value.sample.captureAttempt === captureAttempt).at(-1);
  if (!last || start < BigInt(correlation.anchorNativeNs) || end > BigInt(last.sample.monotonicNs) || end < start
      || end - start > BigInt(Number.MAX_SAFE_INTEGER) || ends[0].droppedEvents > last.sample.droppedEvents)
    return { ...base, status: 'OUTSIDE_OBSERVED_WINDOW', durationNs: null, durationMs: null };
  return { ...base, status: 'MEASURED', startNativeNs: start.toString(), endNativeNs: end.toString(),
    durationNs: (end - start).toString(), durationMs: Number(end - start) / 1000000,
    observedNativeDroppedEvents: last.sample.droppedEvents };
}

/** Validate and retain only the known timing metadata before writing it. */
export function projectNativeTimingHistory(history) {
  if (history?.source !== 'passive-native-timing-history' || history.maximumSamples !== 128
      || !uuid(history.runId) || !uuid(history.workspaceId)
      || !/^appointment_[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(history.appointmentRef ?? '')
      || ![history.evictedSamples, history.invalidSamples, history.unavailableSamples, history.discardedRevisionSamples].every(count)
      || !Array.isArray(history.samples) || history.samples.length > 128) throw Error('native_timing_history_invalid');
  const samples = history.samples.map(project), identity = samples[0];
  if (samples.some(value => scopeKeys.some(key => value[key] !== identity[key]))
      || samples.some(value => ['runId', 'workspaceId', 'appointmentRef'].some(key => value[key] !== history[key])))
    throw Error('native_timing_scope_changed');
  return { source: 'passive-native-timing-history', runId: history.runId, workspaceId: history.workspaceId,
    appointmentRef: history.appointmentRef, maximumSamples: 128, evictedSamples: history.evictedSamples,
    invalidSamples: history.invalidSamples, unavailableSamples: history.unavailableSamples,
    discardedRevisionSamples: history.discardedRevisionSamples, samples };
}

/** Pure analysis; journal process ownership, completeness and clock precision
 * require separate evidence and never follow from these passive samples. */
export function buildNativeTimingMeasurement({ history, journalBytes = null, intervals = [
  ['startRequested', 'sourceReadyReceived'], ['startRequested', 'firstInputBuffer'],
  ['startRequested', 'firstInputSignal'], ['startRequested', 'firstConvertedSignal'], ['stopRequested', 'stopAccepted'],
] }) {
  history = projectNativeTimingHistory(history);
  if (!Array.isArray(intervals) || intervals.length > 16
      || intervals.some(pair => !Array.isArray(pair) || pair.length !== 2)) throw Error('native_timing_history_invalid');
  const samples = history.samples, identity = samples[0];
  const correlation = samples.length ? correlate(samples) : null, nativeJournal = journalBytes === null ? null : journal(journalBytes);
  const attempts = [...new Set(samples.map(value => value.sample.captureAttempt).filter(value => value > 0))];
  return { source: 'passive-native-timing-measurement', qualification: 'NOT_ESTABLISHED',
    scope: identity ? Object.fromEntries(scopeKeys.map(key => [key, identity[key]])) : null,
    sampleCount: samples.length, sampleSHA256: sha256(JSON.stringify(samples)),
    observerRetention: { maximumSamples: 128, evictedSamples: history.evictedSamples, invalidSamples: history.invalidSamples,
      unavailableSamples: history.unavailableSamples, discardedRevisionSamples: history.discardedRevisionSamples },
    correlation, journal: nativeJournal, captureSynchronization: 'NOT_ESTABLISHED',
    nativeIntervals: nativeJournal && correlation ? attempts.flatMap(attempt => intervals.map(([start, end]) =>
      interval(nativeJournal.events, samples, attempt, start, end, correlation))) : [] };
}
