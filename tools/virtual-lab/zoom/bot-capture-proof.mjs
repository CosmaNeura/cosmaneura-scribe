import {createHash} from 'node:crypto';

// Admission age, not a provider latency/SLA claim. The caller measures this
// whole nonce request/response window locally; receipt delivery cannot reset it.
export const BOT_PROOF_MAX_AGE_MS = 2000;
// Provisional refusal margin for inconsistent wall-clock chronology across
// Core, Recall and the observer. It does not establish their clock precision.
export const BOT_CLOCK_SKEW_ALLOWANCE_MS = 5000;
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const typeId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[0-7][0-9a-hjkmnp-tv-z]{25}$`).test(value);
const need = (value, code) => { if (!value) throw Error(code); };
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const iso = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const scopeKeys = ['accountIdentitySHA256', 'doctorRef', 'patientRefSHA256', 'hostIdSHA256',
  'meetingRecordRef', 'meetingIdSHA256', 'appointmentRef', 'occurrenceDigest'];
const hashKeys = ['accountIdentitySHA256', 'patientRefSHA256', 'hostIdSHA256', 'meetingIdSHA256', 'occurrenceDigest'];
const terminal = new Set(['call_ended', 'done', 'fatal']);
const botCodes = new Set(['joining_call', 'in_waiting_room', 'in_call_not_recording', 'recording_permission_allowed',
  'recording_permission_denied', 'in_call_recording', ...terminal]);
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const canonical = value => JSON.stringify(ordered(value));
const same = (a, b) => canonical(a) === canonical(b);

/** Metadata DTOs only: normal host UI evidence + an exact live provider GET,
 * bracketed by Core correspondence reads. This module performs no provider
 * calls, grants no consent, and has no live collector/host-locator adapter.
 * The collector must verify artifact bytes and project the real response.
 * Unknown fields/states are refused rather than retained as tokens or content.
 *
 * Core writes recording:{id}:doctor_id/appointment_id/patient_id before
 * recording.done, after a best-effort chat send, in three separate SETs.
 * A provider recording may therefore be real while this gate remains closed.
 */
export class BotCaptureProofGate {
  #expected; #accepted = null; #closed = false; #recordingBlocked = false; #requestPins = new Map();
  constructor(expected) {
    need(keys(expected, ['runId', 'collectorSHA256', 'startedAtEpochMs', ...scopeKeys])
      && uuid(expected.runId) && digest(expected.collectorSHA256) && Number.isFinite(expected.startedAtEpochMs)
      && expected.startedAtEpochMs > 0 && hashKeys.every(key => digest(expected[key]))
      && typeId(expected.doctorRef, 'doctor') && typeId(expected.appointmentRef, 'appointment')
      && typeId(expected.meetingRecordRef, 'zmtg'), 'bot_expected_scope_invalid');
    this.#expected = structuredClone(expected);
  }
  get expected() { return structuredClone(this.#expected); }
  get captureIdentity() { return this.#accepted?.identity ?? null; }

  #scope(scope) {
    const expected = this.#expected;
    need(keys(scope, [...scopeKeys, 'botIdSHA256', 'recordingIdSHA256'])
      && scopeKeys.every(key => scope[key] === expected[key])
      && digest(scope.botIdSHA256) && digest(scope.recordingIdSHA256)
      && scope.botIdSHA256 !== scope.recordingIdSHA256, 'bot_scope_mismatch');
  }
  #correspondence(row, scope, state) {
    need(keys(row, ['readSequence', 'scope', 'meetingStatus', 'authorization', 'meetingRuntime', 'recordingMapping'])
      && Number.isSafeInteger(row.readSequence) && row.readSequence > 0, 'bot_correspondence_invalid');
    this.#scope(row.scope);
    need(scopeKeys.concat(['botIdSHA256', 'recordingIdSHA256']).every(key => row.scope[key] === scope[key]), 'bot_correspondence_changed');
    const authorization = row.authorization, runtime = row.meetingRuntime, mapping = row.recordingMapping;
    need(keys(authorization, ['occurrenceDigest', 'consumedAt', 'expiresAt'])
      && authorization.occurrenceDigest === scope.occurrenceDigest && iso(authorization.consumedAt) && iso(authorization.expiresAt)
      && Date.parse(authorization.consumedAt) < Date.parse(authorization.expiresAt), 'bot_authorization_unconsumed');
    need(keys(mapping, ['doctorRef', 'appointmentRef', 'patientRefSHA256'])
      && mapping.doctorRef === scope.doctorRef && mapping.appointmentRef === scope.appointmentRef
      && mapping.patientRefSHA256 === scope.patientRefSHA256, 'bot_recording_mapping_pending_or_foreign');
    need(keys(runtime, ['botIdSHA256', 'occurrenceDigest']), 'bot_runtime_mapping_unknown');
    if (state === 'recording') need(row.meetingStatus === 'started' && runtime.botIdSHA256 === scope.botIdSHA256
      && runtime.occurrenceDigest === scope.occurrenceDigest, 'bot_runtime_mapping_changed');
    else need(row.meetingStatus === 'ended'
      && (runtime.botIdSHA256 === null || runtime.botIdSHA256 === scope.botIdSHA256)
      && (runtime.occurrenceDigest === null || runtime.occurrenceDigest === scope.occurrenceDigest), 'bot_meeting_not_ended');
  }
  #history(changes) {
    need(Array.isArray(changes) && changes.length > 1 && changes.length <= 512, 'bot_status_history_invalid');
    let lastAt = -Infinity, ended = false;
    for (const entry of changes) {
      need(keys(entry, ['code', 'subCode', 'createdAt']) && botCodes.has(entry.code) && iso(entry.createdAt)
        && (entry.subCode === null || typeof entry.subCode === 'string' && /^[a-z0-9_]{0,100}$/.test(entry.subCode)), 'bot_status_unknown');
      const at = Date.parse(entry.createdAt);
      need(at >= lastAt && (!ended || entry.code === 'done'), 'bot_status_order_invalid');
      lastAt = at; ended ||= terminal.has(entry.code);
    }
    // Preserve the observed ordering, including equal provider timestamps; do
    // not sort responses or infer precision from their serialized date strings.
    const permissions = changes.filter(row => ['recording_permission_allowed', 'recording_permission_denied'].includes(row.code));
    need(permissions.at(-1)?.code === 'recording_permission_allowed', 'bot_host_permission_not_allowed');
    const approved = changes.findLastIndex(row => row.code === 'recording_permission_allowed');
    need(changes.slice(approved + 1).some(row => row.code === 'in_call_recording'), 'bot_recording_not_observed');
  }
  #chronology(provider, core, consent, request) {
    const skew = BOT_CLOCK_SKEW_ALLOWANCE_MS, changes = provider.statusChanges;
    const times = changes.map(row => Date.parse(row.createdAt)), recording = provider.recordings[0];
    const began = Date.parse(recording.startedAt), consumed = Date.parse(core.before.authorization.consumedAt);
    const allowed = Date.parse(changes.findLast(row => row.code === 'recording_permission_allowed').createdAt);
    const firstRecording = Date.parse(changes.find(row => row.code === 'in_call_recording').createdAt);
    need(times.every(at => at <= request.receivedAtEpochMs + skew && at >= this.#expected.startedAtEpochMs - skew)
      && consumed >= this.#expected.startedAtEpochMs - skew && consumed <= allowed + skew
      && began >= consumed - skew && began >= allowed - skew && began <= firstRecording + skew
      && began <= request.receivedAtEpochMs + skew && consent.observedAtEpochMs <= began + skew,
    'bot_recording_chronology_invalid');
    if (recording.completedAt !== null) {
      const completed = Date.parse(recording.completedAt);
      const lastRecording = Date.parse(changes.findLast(row => row.code === 'in_call_recording').createdAt);
      need(completed <= request.receivedAtEpochMs + skew && completed >= lastRecording - skew
        && (!terminal.has(changes.at(-1).code) || completed <= times.at(-1) + skew), 'bot_completion_chronology_invalid');
    }
  }

  validate(observation, state, {request, now = Date.now()} = {}) {
    try { return this.#validate(observation, state, request, now); }
    catch (error) { if (this.#accepted || state === 'stopped') this.#recordingBlocked = true; throw error; }
  }
  #validate(value, state, request, now) {
    const expected = this.#expected;
    need(['recording', 'stopped'].includes(state), 'bot_proof_state_invalid');
    need(state !== 'recording' || !this.#closed && !this.#recordingBlocked, 'bot_recording_restart_forbidden');
    need(keys(request, ['requestNonce', 'sentAtEpochMs', 'receivedAtEpochMs']) && uuid(request.requestNonce)
      && [now, request.sentAtEpochMs, request.receivedAtEpochMs].every(Number.isFinite)
      && request.sentAtEpochMs >= expected.startedAtEpochMs && request.receivedAtEpochMs >= request.sentAtEpochMs
      && request.receivedAtEpochMs - request.sentAtEpochMs <= BOT_PROOF_MAX_AGE_MS
      && request.receivedAtEpochMs <= now + 50 && now - request.sentAtEpochMs <= BOT_PROOF_MAX_AGE_MS,
    'bot_proof_transport_stale');
    need(keys(value, ['schema', 'kind', 'source', 'executionKind', 'runId', 'requestNonce', 'collectorSHA256',
      'scope', 'consent', 'core', 'provider', 'teardown']) && value.schema === 1 && value.kind === 'zoom-bot'
      && value.source === 'normal-zoom-ui-and-scoped-recall-observation' && value.executionKind === 'live'
      && value.runId === expected.runId && value.requestNonce === request.requestNonce
      && value.collectorSHA256 === expected.collectorSHA256, 'bot_observer_identity_invalid');
    const scope = value.scope, consent = value.consent, core = value.core, provider = value.provider;
    this.#scope(scope);
    need(keys(consent, ['source', 'action', 'actionId', 'artifactSHA256', 'hostIdSHA256', 'meetingIdSHA256',
      'occurrenceDigest', 'observedAtEpochMs']) && consent.source === 'normal-zoom-host-consent-ui'
      && consent.action === 'approve_recording' && uuid(consent.actionId) && digest(consent.artifactSHA256)
      && consent.hostIdSHA256 === scope.hostIdSHA256 && consent.meetingIdSHA256 === scope.meetingIdSHA256
      && consent.occurrenceDigest === scope.occurrenceDigest && Number.isFinite(consent.observedAtEpochMs)
      && consent.observedAtEpochMs >= expected.startedAtEpochMs && consent.observedAtEpochMs <= request.receivedAtEpochMs + 50,
    'bot_normal_host_consent_missing');
    need(keys(core, ['source', 'before', 'after']) && core.source === 'scoped-staging-zoom-recording-correspondence', 'bot_core_source_invalid');
    this.#correspondence(core.before, scope, state); this.#correspondence(core.after, scope, state);
    need(same(core.before.authorization, core.after.authorization), 'bot_authorization_changed');
    need(keys(provider, ['source', 'httpStatus', 'readSequence', 'botIdSHA256', 'meetingIdSHA256', 'statusChanges', 'recordings'])
      && provider.source === 'scoped-recall-get-response' && provider.httpStatus === 200
      && Number.isSafeInteger(provider.readSequence) && core.before.readSequence < provider.readSequence
      && provider.readSequence < core.after.readSequence && provider.botIdSHA256 === scope.botIdSHA256
      && provider.meetingIdSHA256 === scope.meetingIdSHA256, 'bot_provider_response_invalid');
    const recordings = provider.recordings;
    need(Array.isArray(recordings) && recordings.length === 1
      && keys(recordings[0], ['idSHA256', 'botIdSHA256', 'statusCode', 'startedAt', 'completedAt'])
      && recordings[0].idSHA256 === scope.recordingIdSHA256 && recordings[0].botIdSHA256 === scope.botIdSHA256
      && ['processing', 'paused', 'done', 'failed', 'deleted'].includes(recordings[0].statusCode)
      && iso(recordings[0].startedAt) && (recordings[0].completedAt === null || iso(recordings[0].completedAt)
        && Date.parse(recordings[0].completedAt) >= Date.parse(recordings[0].startedAt)), 'bot_recording_missing_or_ambiguous');
    this.#history(provider.statusChanges);
    this.#chronology(provider, core, consent, request);
    const identity = hash(canonical([expected.runId, ...scopeKeys.map(key => scope[key]), scope.botIdSHA256,
      scope.recordingIdSHA256, consent.actionId, consent.artifactSHA256]));
    const previous = this.#accepted;
    if (previous) {
      need(identity === previous.identity && provider.statusChanges.length >= previous.history.length
        && previous.history.every((entry, index) => same(entry, provider.statusChanges[index]))
        && same(consent, previous.consent) && same(core.before.authorization, previous.authorization)
        && recordings[0].startedAt === previous.startedAt, 'bot_capture_or_history_changed');
    }
    const current = provider.statusChanges.at(-1).code;
    if (state === 'recording') {
      need(current === 'in_call_recording' && recordings[0].statusCode === 'processing'
        && recordings[0].completedAt === null && value.teardown === null, 'bot_not_currently_recording');
    } else {
      need(previous && terminal.has(current) && recordings[0].statusCode === 'done'
        && iso(recordings[0].completedAt), 'bot_stop_not_confirmed');
      const teardown = value.teardown;
      need(keys(teardown, ['source', 'botIdSHA256', 'occurrenceDigest', 'matchingRowCount', 'rows']) && teardown.source === 'scoped-core-teardown-rows'
        && teardown.botIdSHA256 === scope.botIdSHA256 && teardown.occurrenceDigest === scope.occurrenceDigest
        && Array.isArray(teardown.rows) && teardown.rows.length > 0 && teardown.rows.length <= 8
        && Number.isSafeInteger(teardown.matchingRowCount) && teardown.matchingRowCount === teardown.rows.length
        && new Set(teardown.rows.map(row => row.id)).size === teardown.rows.length, 'bot_teardown_unconfirmed');
      for (const row of teardown.rows) need(keys(row, ['id', 'eventType', 'state', 'processedAt', 'leaseExpiresAt', 'lastErrorCode'])
        && typeId(row.id, 'webhook_delivery') && row.eventType === 'internal.zoom_bot_release' && row.state === 'completed'
        && iso(row.processedAt) && Date.parse(row.processedAt) <= request.receivedAtEpochMs + BOT_CLOCK_SKEW_ALLOWANCE_MS
        && row.leaseExpiresAt === null && row.lastErrorCode === null, 'bot_teardown_unsettled');
    }
    const requestPin = hash(canonical({request, observation: value})), existingPin = this.#requestPins.get(request.requestNonce);
    need(!existingPin || existingPin === requestPin, 'bot_nonce_replayed_with_changed_observation');
    need(existingPin || this.#requestPins.size < 4096 || state === 'stopped', 'bot_observation_limit');
    if (state === 'stopped') { this.#closed = true; this.#recordingBlocked = true; }
    if (this.#requestPins.size < 4096) this.#requestPins.set(request.requestNonce, requestPin);
    this.#accepted = {identity, history: structuredClone(provider.statusChanges), consent: structuredClone(consent),
      authorization: structuredClone(core.before.authorization), startedAt: recordings[0].startedAt};
    return value;
  }
}
