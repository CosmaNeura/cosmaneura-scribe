import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSaveCompletion, snapshotSaveFields } from './save-completion.mjs';
import { validateSavedReceipt } from './dashboard.mjs';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const suffix = '01m5q661ryetaa28yxe7vbqrex';
function fixture(dirty = false) {
  const scope = { runId: id(1), workspaceId: id(2), appointmentRef: `appointment_${suffix}` };
  const note = { ...scope, source: 'normal-core-note-response', action: dirty ? 'save' : 'prepare', session_id: id(3),
    note_ref: `visit_note_${suffix}`, transcript_ref: `ai_visit_transcript_${suffix}`, schema_ref: `doctor_note_schema_${suffix}`,
    note_sha256: 'a'.repeat(64), source_sha256: 'b'.repeat(64), requestNonce: id(4), status: 'draft', field_order: ['HPI'],
    observedAtMonotonicMs: dirty ? 25 : 5, browserTimeOriginMs: 1000 };
  const current = { ...scope, source: 'normal-native-mount-response', requestId: id(6), revision: id(7),
    observedAtMonotonicMs: 40, browserTimeOriginMs: 1000 };
  const completion = { source: 'normal-native-save-completion', attempt: { nonce: id(8),
    note: { ...note, action: 'prepare', requestNonce: id(10), note_sha256: dirty ? 'c'.repeat(64) : note.note_sha256,
      ...(dirty ? { note_ref: `visit_note_01m5q661ryetaa28yxe7vbqrey` } : {}) },
    fields: { source: 'normal-note-editor-fields', fieldsSHA256: note.note_sha256, fieldOrder: note.field_order,
      observedAtMonotonicMs: 20, browserTimeOriginMs: 1000 },
    visit: { ...current, requestId: id(9), observedAtMonotonicMs: 1 },
    click: { source: 'normal-native-control-response', action: 'click', completedAtEpochMs: 1060 } },
    handoff: { ...current, source: 'normal-native-note-mount-handoff', requestedAtMonotonicMs: 30, pendingObservedReplies: 0, note },
    currentVisit: current, ui: { source: 'normal-saved-review-ui', heading: 'Saved for review', fieldCount: 0,
      actions: ['encounters', 'core'], documentVisibility: 'hidden', observedAtMonotonicMs: 60, browserTimeOriginMs: 1000 } };
  return { scope, note, completion };
}
for (const dirty of [false, true]) test(`${dirty ? 'dirty' : 'clean'} Save binds original Core action, field hash and new same-auth mount to actual completion`, () => {
  const { note, completion } = fixture(dirty);
  assert.equal(validateSaveCompletion(note, completion), completion);
  assert.equal(validateSavedReceipt({ ...note, saveCompletion: completion }, { admissionBinding: { runId: note.runId } }).action, note.action);
});
for (const [name, change] of [
  ['no actual click', c => { delete c.attempt.click; }],
  ['canceled Save UI', c => { c.ui.heading = 'Keep your note edits?'; }],
  ['old mount', c => { c.handoff.requestedAtMonotonicMs = 10; }],
  ['lost mount', c => { c.handoff = null; }],
  ['foreign mount', c => { c.handoff.appointmentRef = `appointment_01m5q661ryetaa28yxe7vbqrey`; }],
  ['auth switch', c => { c.currentVisit.revision = id(99); c.handoff.revision = id(99); }],
  ['later current mount', c => { c.currentVisit.requestId = id(99); }],
  ['unsettled mount', c => { c.handoff.pendingObservedReplies = 1; }],
  ['changed fields', c => { c.attempt.fields.fieldsSHA256 = 'c'.repeat(64); }],
  ['foreign field order', c => { c.attempt.fields.fieldOrder = ['Different']; }],
  ['late completion', c => { c.ui.observedAtMonotonicMs = 120021; }],
  ['future click receipt', c => { c.attempt.click.completedAtEpochMs = 1061; }],
]) test(`${name} cannot turn autosave into manual completion`, () => {
  const { note, completion } = fixture(); change(completion);
  assert.throws(() => validateSaveCompletion(note, completion), /native_save_completion_unconfirmed/);
});
test('plain prepared/read receipt cannot satisfy dashboard Save gate', () => {
  const { note } = fixture();
  assert.throws(() => validateSavedReceipt(note, { admissionBinding: { runId: note.runId } }), /native_saved_note_receipt_required/);
});
test('field snapshot hashes actual ordered values and refuses a mutation during digest', async () => {
  const originalDocument = globalThis.document, originalStyle = globalThis.getComputedStyle;
  const action = { disabled: false, isConnected: true, getClientRects: () => [{}] }, field = { name: 'note-0', value: 'synthetic only', disabled: false, readOnly: false, isConnected: true };
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  globalThis.document = { visibilityState: 'visible', querySelectorAll: query => query.includes('finish-note') ? [action] : query === '.provider-completion' ? [] : [field] };
  try {
    const value = await snapshotSaveFields(['HPI']); assert.equal(value.fieldOrder[0], 'HPI');
    assert.equal(JSON.stringify(value).includes('synthetic only'), false);
    const pending = snapshotSaveFields(['HPI']); field.value = 'changed'; assert.equal(await pending, null);
    document.visibilityState = 'hidden'; assert.equal(await snapshotSaveFields(['HPI']), null);
  } finally { globalThis.document = originalDocument; globalThis.getComputedStyle = originalStyle; }
});
