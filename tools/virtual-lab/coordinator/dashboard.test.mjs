import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from './journal.mjs';
import { DASHBOARD_ORIGIN, assertIsolationResponse, completeOptionalOnboarding, dashboardRequestAllowed, projectNoteDetail, validateSavedReceipt } from './dashboard.mjs';

const id = '01m5q661ryetaa28yxe7vbqrex', uuid = '11111111-1111-4111-8111-111111111111';
const fields = { Assessment: 'Invented headache.', Plan: 'Synthetic saved correction.' };
function receipt() { return { source: 'normal-core-note-response', action: 'save', runId: uuid, workspaceId: uuid,
  appointmentRef: 'appointment_' + id, session_id: uuid, status: 'draft', note_ref: 'visit_note_' + id,
  transcript_ref: 'ai_visit_transcript_' + id, note_sha256: sha256(JSON.stringify(Object.entries(fields))), field_order: Object.keys(fields),
  source_sha256: 'a'.repeat(64), schema_ref: 'doctor_note_schema_' + id, requestNonce: uuid,
  observedAtMonotonicMs: 12, browserTimeOriginMs: Date.now() - 12 }; }
function detail() {
  const r = receipt(), doctor = 'doctor_' + id, patient = 'patient_' + id;
  const transcript = { id: r.transcript_ref, appointment_id: r.appointmentRef, doctor_id: doctor, patient_id: patient,
    duration: 2, created_at: new Date().toISOString(), deleted_at: null,
    transcript_data: [{ speaker: 'Speaker 1', content: 'Invented headache.', startTime: 0, endTime: 2000 }] };
  return { appointment: { id: r.appointmentRef, doctor_id: doctor, patient_id: patient },
    notes: [{ id: r.note_ref, appointment_id: r.appointmentRef, doctor_id: doctor, ai_transcript_id: r.transcript_ref, note: fields }],
    transcript, note_transcripts: [transcript] };
}

test('dashboard binds the exact saved native session through note and transcript IDs plus ordered content hash', () => {
  const r = validateSavedReceipt(receipt(), { admissionBinding: { runId: uuid } });
  const actual = projectNoteDetail(detail(), r);
  assert.equal(actual.nativeSessionId, uuid);
  assert.equal(actual.noteSHA256, r.note_sha256);
  assert.equal(actual.transcriptSegments, 1);
  assert.equal(Object.hasOwn(actual, 'note'), false);
});
test('a different saved version or transcript cannot qualify an otherwise ready page', () => {
  for (const mutate of [data => { data.notes[0].id += '0'; }, data => { data.notes[0].ai_transcript_id += '0'; },
    data => { data.notes[0].note = { ...fields, Plan: 'Old unsaved content.' }; },
    data => { data.notes[0].note = { Plan: fields.Plan, Assessment: fields.Assessment }; },
    data => { data.notes[0].doctor_id += '0'; }, data => { data.transcript.deleted_at = new Date().toISOString(); }]) {
    const data = detail(); mutate(data); assert.throws(() => projectNoteDetail(data, receipt()), /dashboard_/);
  }
});
test('missing native provenance and ambiguous source versions fail closed', () => {
  assert.throws(() => validateSavedReceipt({ ...receipt(), source: 'configured-receipt' }, { admissionBinding: { runId: uuid } }), /receipt_required/);
  assert.throws(() => validateSavedReceipt({ ...receipt(), action: 'read' }, { admissionBinding: { runId: uuid } }), /receipt_required/);
  const data = detail(); data.note_transcripts = [{ ...data.transcript, duration: 9 }];
  assert.throws(() => projectNoteDetail(data, receipt()), /ambiguous/);
});
test('only an exact visit request is allowed; list searches and a wrong API origin cannot broaden access', () => {
  const r = receipt(), scope = { apiOrigin: 'https://staging-api.cosmaneura.com', appointmentRef: r.appointmentRef, noteRef: r.note_ref };
  const api = scope.apiOrigin + '/internal/v1';
  assert.equal(dashboardRequestAllowed(`${api}/notes/${r.appointmentRef}`, 'GET', scope), true);
  assert.equal(dashboardRequestAllowed(`${DASHBOARD_ORIGIN}/notes/${r.appointmentRef}?reviewNote=${r.note_ref}`, 'GET', scope), true);
  for (const url of [`${api}/notes`, `${api}/notes?search=synthetic`, `${api}/patients`, `${api}/notes/appointment_other`,
    `https://staging-other.cosmaneura.com/internal/v1/notes`, `${DASHBOARD_ORIGIN}/notes`]) {
    assert.equal(dashboardRequestAllowed(url, 'GET', scope), false);
  }
  assert.equal(dashboardRequestAllowed(`${api}/notes/${r.appointmentRef}`, 'POST', scope), false);
});
test('optional onboarding submits only after the distinct Go to Cosmas control', async () => {
  const events = [];
  const page = { getByRole: (role, { name }) => ({ count: async () => 1,
    click: async () => { events.push(name); }, waitFor: async () => { events.push(name); } }),
  waitForResponse: async predicate => {
    const response = { url: () => 'https://staging-api.cosmaneura.com/internal/v1/onboarding/complete', request: () => ({ method: () => 'POST' }), ok: () => true, status: () => 200 };
    assert.equal(predicate(response), true); return response;
  } };
  const result = await completeOptionalOnboarding(page, { signal: new AbortController().signal });
  assert.deepEqual(events, ['Start using Cosmas', "You're all set!", 'Go to Cosmas']);
  assert.equal(result.status, 200);
});
test('cross-account isolation needs an actual 403/404 for the current inactive actor', () => {
  const sample = { identitySHA256: 'a'.repeat(64), expectedIdentitySHA256: 'a'.repeat(64), viewerDoctorRef: 'doctor_' + id,
    viewAs: { active: false, targetPresent: false, actorDoctorRef: 'doctor_' + id } };
  for (const status of [403, 404]) assert.equal(assertIsolationResponse({ ...sample, status }).httpStatus, status);
  for (const status of [undefined, 200, 401, 500]) assert.throws(() => assertIsolationResponse({ ...sample, status }), /denial_not_observed/);
  assert.throws(() => assertIsolationResponse({ ...sample, status: 404, identitySHA256: 'b'.repeat(64) }), /actor_scope/);
  assert.throws(() => assertIsolationResponse({ ...sample, status: 404, viewAs: { ...sample.viewAs, active: true } }), /actor_scope/);
  assert.throws(() => assertIsolationResponse({ ...sample, status: 404, viewAs: null }), /actor_scope/);
});
