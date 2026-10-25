import { sha256 } from './journal.mjs';

export const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const typeId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[0-7][0-9a-hjkmnp-tv-z]{25}$`).test(value);
export const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const code = error => /^[a-z_]{1,100}$/.test(error?.message) ? error.message : 'zoom_bot_operation_failed';
const need = (condition, message) => { if (!condition) throw Error(message); };

/** Source-derived metadata only. Provider resource IDs, URLs, topics, names,
 * DOBs, tokens and note/transcript bodies never enter these observations. */
export function projectSchedule(data, authorization) {
  need(data?.zoom_connected === true && data.capture_available === true && Array.isArray(data.meetings), 'zoom_schedule_unavailable');
  const found = data.meetings.filter(item => item.zoom_meeting_id === authorization.meetingId);
  need(found.length === 1, 'zoom_meeting_missing_or_ambiguous');
  const row = found[0];
  need(row.id === authorization.meetingRecordRef && ['scheduled', 'started', 'ended'].includes(row.status)
    && typeof row.capture_authorized === 'boolean'
    && (row.appointment_id === null || row.appointment_id === authorization.appointmentRef), 'zoom_meeting_scope_mismatch');
  return { meetingRecordRef: row.id, meetingIdSHA256: sha256(row.zoom_meeting_id),
    appointmentRef: row.appointment_id, status: row.status, captureAuthorized: row.capture_authorized };
}

export function projectAuthorization(data, authorization) {
  need(data?.appointment_id === authorization.appointmentRef && ['pending', 'armed'].includes(data.state), 'zoom_authorization_response_invalid');
  return { appointmentRef: data.appointment_id, state: data.state };
}

/** The collector executes a scoped read-only staging query. Its freshness and
 * request binding are checked independently from normal browser identity. */
export function validateHostObservation(value, config, request, { now = Date.now() } = {}) {
  need(value?.source === 'live-staging-zoom-bot-observation' && value.executionKind === 'live' && value.status === 'READONLY_VERIFIED'
    && value.runId === config.runId && value.requestNonce === request.requestNonce
    && Number.isFinite(value.observedAtEpochMs) && value.observedAtEpochMs >= request.createdAtEpochMs - 5000
    && value.observedAtEpochMs <= now + 5000 && now - value.observedAtEpochMs <= 120000
    && value.collector?.startedAtEpochMs >= request.createdAtEpochMs
    && value.collector.completedAtEpochMs >= value.collector.startedAtEpochMs
    && value.collector.completedAtEpochMs <= now + 50
    && value.collector.scriptSHA256 === config.collector.scriptSHA256, 'zoom_collector_observation_stale');
  need(value.scope?.hostIdSHA256 === sha256(config.hostId) && value.scope.doctorRef === config.doctorRef
    && value.profile?.doctorRef === config.doctorRef && value.profile.clerkSubjectSHA256 === config.identitySHA256
    && value.profile.deletedAt === null && typeId(value.profile.practiceRef, 'practice'), 'zoom_collector_account_mismatch');
  const deployment = value.deployment;
  need(/^[a-f0-9]{40}$/.test(deployment?.sourceSHA ?? '') && typeof deployment.webRevision === 'string'
    && typeof deployment.workerRevision === 'string' && /^sha256:[a-f0-9]{64}$/.test(deployment.imageDigest ?? ''), 'zoom_collector_deployment_missing');
  const host = value.hostBinding, integration = value.requestedAccountIntegration;
  need(Number.isSafeInteger(host?.count) && host.count >= 0 && Array.isArray(host.ownerDoctorSHA256s)
    && host.ownerDoctorSHA256s.length === host.count && host.ownerDoctorSHA256s.every(digest)
    && Number.isSafeInteger(host.matchingRequestedOwnerCount) && host.matchingRequestedOwnerCount >= 0
    && host.matchingRequestedOwnerCount === host.ownerDoctorSHA256s.filter(item => item === sha256(config.doctorRef)).length
    && Number.isSafeInteger(integration?.count) && integration.count >= 0 && Array.isArray(integration.providerUserIdSHA256s)
    && integration.providerUserIdSHA256s.length === integration.count && integration.providerUserIdSHA256s.every(digest), 'zoom_collector_binding_invalid');
  need(host.count <= 1 && host.count === host.matchingRequestedOwnerCount
    && integration.count <= 1 && integration.providerUserIdSHA256s.every(item => item === sha256(config.hostId))
    && host.count === integration.count, 'zoom_host_owned_elsewhere');
  return { ...projectHostObservation(value), bindingState: host.count === 1 ? 'CONNECTED_TO_EXPECTED_HOST' : 'UNBOUND' };
}

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
export function projectHostObservation(value) {
  const result = pick(value, ['source', 'executionKind', 'status', 'runId', 'requestNonce', 'observedAtEpochMs']);
  for (const [key, fields] of Object.entries({
    scope: ['hostIdSHA256', 'doctorRef', 'meetingIdSHA256', 'appointmentRef'],
    profile: ['doctorRef', 'clerkSubjectSHA256', 'emailSHA256', 'practiceRef', 'deletedAt'],
    hostBinding: ['count', 'ownerDoctorSHA256s', 'matchingRequestedOwnerCount'],
    requestedAccountIntegration: ['count', 'providerUserIdSHA256s'],
    deployment: ['sourceSHA', 'webRevision', 'workerRevision', 'imageDigest', 'postapplySourceProofSHA256'],
    collector: ['scriptSHA256', 'querySHA256', 'startedAtEpochMs', 'completedAtEpochMs'],
  })) result[key] = pick(value?.[key], fields);
  if (value?.appointmentScope) {
    result.appointmentScope = pick(value.appointmentScope, ['doctorRef', 'appointmentRefsSHA256s', 'patientRefsSHA256s',
      'appointmentLinkedMeetingCount', 'captureAuthorizedMeetingCount', 'linkedMeetingRecordRefsSHA256s']);
    result.appointmentScope.requestedAppointment = pick(value.appointmentScope.requestedAppointment,
      ['appointmentRef', 'doctorRef', 'patientRefSHA256', 'scribeCaptureBindingCount']);
    result.appointmentScope.meeting = pick(value.appointmentScope.meeting, ['meetingRecordRef', 'meetingIdSHA256', 'doctorRef',
      'linkedAppointmentRef', 'status', 'startTime', 'captureOccurrenceDigest', 'captureAuthorizationExpiresAt', 'captureAuthorizationConsumedAt']);
  }
  return result;
}

export function validateAuthorizationScope(value, authorization) {
  const scope = value.appointmentScope;
  const setMatches = (actual, expected) => Array.isArray(actual) && actual.every(digest)
    && new Set(actual).size === actual.length && actual.every(item => expected.map(sha256).includes(item));
  need(scope && setMatches(scope.appointmentRefsSHA256s, authorization.allowedAppointmentRefs)
    && setMatches(scope.patientRefsSHA256s, authorization.allowedPatientRefs)
    && scope.appointmentRefsSHA256s.includes(sha256(authorization.appointmentRef))
    && scope.patientRefsSHA256s.includes(scope.requestedAppointment?.patientRefSHA256), 'zoom_authorization_scope_required');
  need(scope.doctorRef === value.scope.doctorRef && scope.meeting?.meetingRecordRef === authorization.meetingRecordRef
    && scope.meeting.meetingIdSHA256 === sha256(authorization.meetingId)
    && scope.meeting.doctorRef === value.scope.doctorRef
    && [null, authorization.appointmentRef].includes(scope.meeting.linkedAppointmentRef)
    && scope.requestedAppointment?.appointmentRef === authorization.appointmentRef
    && scope.requestedAppointment.doctorRef === scope.meeting.doctorRef
    && scope.requestedAppointment.scribeCaptureBindingCount === 0
    && Number.isSafeInteger(scope.appointmentLinkedMeetingCount) && scope.appointmentLinkedMeetingCount >= 0 && scope.appointmentLinkedMeetingCount <= 1
    && Array.isArray(scope.linkedMeetingRecordRefsSHA256s) && scope.linkedMeetingRecordRefsSHA256s.length === scope.appointmentLinkedMeetingCount
    && scope.linkedMeetingRecordRefsSHA256s.every(item => item === sha256(authorization.meetingRecordRef))
    && Number.isSafeInteger(scope.captureAuthorizedMeetingCount) && scope.captureAuthorizedMeetingCount >= 0 && scope.captureAuthorizedMeetingCount <= scope.appointmentLinkedMeetingCount,
  'zoom_authorization_tuple_mismatch');
  return scope;
}

/** Dedicated future bot-note tuple. It deliberately has no native session ID
 * and does not turn automatic server persistence into a manual Save gate. */
export function projectBotNote(data, { doctorRef, appointmentRef, transcriptRef }) {
  need(data?.appointment?.id === appointmentRef && data.appointment.doctor_id === doctorRef
    && data.capture_workflow_required !== true && Array.isArray(data.notes), 'zoom_note_scope_mismatch');
  const notes = data.notes.filter(row => row.ai_transcript_id === transcriptRef && !row.deleted_at);
  const transcripts = [...(data.note_transcripts ?? []), ...(data.transcript ? [data.transcript] : [])]
    .filter(row => row.id === transcriptRef);
  need(notes.length === 1 && transcripts.length >= 1, 'zoom_note_transcript_missing');
  const note = notes[0], transcript = transcripts[0];
  need(typeId(note.id, 'visit_note') && typeId(transcriptRef, 'ai_visit_transcript')
    && note.appointment_id === appointmentRef && note.doctor_id === doctorRef
    && transcript.appointment_id === appointmentRef && transcript.doctor_id === doctorRef
    && transcript.patient_id === data.appointment.patient_id && !transcript.deleted_at
    && transcripts.every(row => sha256(JSON.stringify(row)) === sha256(JSON.stringify(transcript)))
    && note.note && !Array.isArray(note.note) && Object.keys(note.note).length > 0
    && Object.values(note.note).every(item => typeof item === 'string')
    && Array.isArray(transcript.transcript_data) && transcript.transcript_data.length > 0,
  'zoom_note_transcript_mismatch');
  return { doctorRef, appointmentRef, noteRef: note.id, aiTranscriptRef: transcriptRef,
    noteSHA256: sha256(JSON.stringify(Object.entries(note.note))), transcriptSHA256: sha256(JSON.stringify(transcript.transcript_data)) };
}
