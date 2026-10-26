import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDesktopSaveCompletion } from './desktop-save-completion.mjs';
import { validateSaveCompletion } from './save-completion.mjs';
import { validateSavedReceipt } from './dashboard.mjs';
import { AppiumUI } from './appium-ui.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const suffix = '01m5q661ryetaa28yxe7vbqrex';
const at = value => ({ observedAtMonotonicMs: value, browserTimeOriginMs: 1000 });
function fixture(dirty = false) {
  const scope = { runId: id(1), workspaceId: id(2), appointmentRef: `appointment_${suffix}` };
  const note = { ...scope, source: 'normal-core-note-response', action: dirty ? 'save' : 'prepare', session_id: id(3),
    note_ref: `visit_note_${suffix}`, transcript_ref: `ai_visit_transcript_${suffix}`, schema_ref: `doctor_note_schema_${suffix}`,
    note_sha256: 'a'.repeat(64), source_sha256: 'b'.repeat(64), requestNonce: id(4), status: 'draft', field_order: ['HPI'], ...at(dirty ? 35 : 10) };
  const visit = { ...scope, source: 'normal-native-mount-response', transport: 'electron-main-ipc', connectionId: id(9), requestId: id(5), encounterId: id(6), revision: id(7), ...at(1) };
  const auth = { source: 'normal-desktop-auth-response', runId: scope.runId, phase: 'ready', revision: visit.revision, identitySHA256: 'd'.repeat(64), ...at(5) };
  const completion = { source: 'normal-desktop-save-completion', attempt: { nonce: id(8), auth, visit,
    note: { ...note, action: 'prepare', ...(dirty ? { note_sha256: 'c'.repeat(64), note_ref: 'visit_note_01m5q661ryetaa28yxe7vbqrey', requestNonce: id(10) } : {}) },
    fields: { source: 'normal-note-editor-fields', fieldsSHA256: note.note_sha256, fieldOrder: note.field_order, ...at(20) },
    click: { source: 'normal-desktop-control-response', action: 'click', startedAtEpochMs: 1030, completedAtEpochMs: 1060 } },
    handoff: { ...scope, source: 'normal-desktop-open-core-response', note, encounterId: visit.encounterId, revision: visit.revision,
      connectionId: id(9), mountRequestId: visit.requestId, openCoreRequestId: id(11), accountIdentitySHA256: auth.identitySHA256,
      requestObservedAtMonotonicMs: 40, requestBrowserTimeOriginMs: 1000, pendingObservedReplies: 0, ...at(50) },
    auth: { ...auth, ...at(55) }, currentVisit: visit,
    ui: { source: 'normal-saved-review-ui', heading: 'Saved for review', actions: ['encounters', 'core'],
      fieldCount: 0, documentVisibility: 'hidden', ...at(65) } };
  return { scope, note, completion };
}

for (const dirty of [false, true]) test(`Desktop ${dirty ? 'dirty successor' : 'clean prepare'} binds original action and same mount to real completion`, () => {
  const { scope, note, completion } = fixture(dirty);
  assert.equal(validateDesktopSaveCompletion(note, completion), completion);
  const receipt = validateSavedReceipt({ ...note, saveCompletion: completion }, { admissionBinding: scope });
  assert.equal(receipt.action, dirty ? 'save' : 'prepare');
  assert.throws(() => validateSaveCompletion(note, completion), /native_save_completion_unconfirmed/);
});

for (const [name, change] of [
  ['no handoff', c => { c.handoff = null; }],
  ['no click', c => { delete c.attempt.click; }],
  ['old pre-click response', c => { c.handoff.requestObservedAtMonotonicMs = 25; }],
  ['future click', c => { c.attempt.click.completedAtEpochMs = 1066; }],
  ['relabelled native receipt', c => { c.handoff.source = 'normal-native-note-mount-handoff'; }],
  ['wrong current encounter', c => { c.currentVisit = { ...c.currentVisit, encounterId: id(90) }; }],
  ['wrong current connection', c => { c.currentVisit = { ...c.currentVisit, connectionId: id(90) }; }],
  ['note outside mounted scope', c => { c.currentVisit = { ...c.currentVisit, workspaceId: id(90) }; c.attempt.visit = c.currentVisit; c.handoff.workspaceId = id(90); }],
  ['different mount', c => { c.handoff.mountRequestId = id(90); }],
  ['different session', c => { c.handoff.note = { ...c.handoff.note, session_id: id(90) }; }],
  ['different account', c => { c.auth.identitySHA256 = 'e'.repeat(64); }],
  ['different auth revision', c => { c.auth.revision = id(90); }],
  ['missing pre-click auth', c => { c.attempt.auth = null; }],
  ['stale auth', c => { c.ui.observedAtMonotonicMs = 15100; }],
  ['old fields', c => { c.attempt.fields.observedAtMonotonicMs = 19; c.attempt.auth.observedAtMonotonicMs = 20; }],
  ['changed fields', c => { c.attempt.fields.fieldsSHA256 = 'c'.repeat(64); }],
  ['changed order', c => { c.attempt.fields.fieldOrder = ['Other']; }],
  ['pending replies', c => { c.handoff.pendingObservedReplies = 1; }],
  ['false Saved heading', c => { c.ui.heading = 'Keep your note edits?'; }],
  ['editor still present', c => { c.ui.fieldCount = 1; }],
  ['missing action', c => { c.ui.actions = ['core']; }],
  ['late completion', c => { c.ui.observedAtMonotonicMs = 120021; c.auth.observedAtMonotonicMs = 120020; }],
]) test(`${name} refuses Desktop completion`, () => {
  const { note, completion } = fixture(); change(completion);
  assert.throws(() => validateDesktopSaveCompletion(note, completion), /desktop_save_completion_unconfirmed/);
});

test('an unpersisted dirty field hash cannot be accepted by relabelling a prepare receipt', () => {
  const { note, completion } = fixture(true);
  note.action = 'prepare'; completion.handoff.note.action = 'prepare';
  assert.throws(() => validateDesktopSaveCompletion(note, completion), /desktop_save_completion_unconfirmed/);
});

for (const mode of ['success', 'lost click', 'reply before discovery']) test(`Desktop Appium Save: ${mode}`, async () => {
  const { scope, note, completion } = fixture(), driver = new AppiumUI('/unused'), origin = Date.now() - 25;
  const rebase = value => { if (!value || typeof value !== 'object') return;
    if ('browserTimeOriginMs' in value) value.browserTimeOriginMs = origin; Object.values(value).forEach(rebase); };
  rebase(completion); rebase(note);
  driver.config = { journey: { save: { actions: [{ action: 'click' }] } } };
  driver.binding = scope; driver.admission = { sessionId: note.session_id }; driver.scenario = { targetId: 'owned-test' };
  driver.terminal = { sessionId: note.session_id, browserTimeOriginMs: origin, observedAtMonotonicMs: 1 };
  let clicks = 0, reads = 0;
  driver.readNote = async action => { reads++; assert.equal(action, null); return note; };
  driver.assertVisit = async () => completion.currentVisit;
  driver.readAuth = async () => ({ ...completion.auth, observedAtMonotonicMs: Date.now() - origin });
  driver.desktop = {
    readSaveFields: async () => ({ ...completion.attempt.fields, observedAtMonotonicMs: Date.now() - origin }),
    readSaveHandoff: async () => completion.handoff,
    readSaveUI: async () => ({ ...completion.ui, observedAtMonotonicMs: Date.now() - origin }),
  };
  driver.find = async () => {
    if (mode === 'reply before discovery') {
      completion.handoff.requestBrowserTimeOriginMs = origin;
      completion.handoff.requestObservedAtMonotonicMs = completion.handoff.observedAtMonotonicMs = Date.now() - origin;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return 'actual-save-control';
  };
  driver.rawRequest = async (path, method) => {
    assert.equal(path, '/element/actual-save-control/click'); assert.equal(method, 'POST');
    clicks++; if (mode === 'lost click') throw Error('click_response_lost');
    if (mode === 'reply before discovery') return;
    completion.handoff.requestBrowserTimeOriginMs = origin;
    completion.handoff.requestObservedAtMonotonicMs = Date.now() - origin;
    completion.handoff.observedAtMonotonicMs = Date.now() - origin;
  };
  driver.check = async () => [{ actual: 'Saved for review', expected: 'Saved for review' }];
  driver.capturePhaseArtifacts = async () => ({ testOnly: true });
  driver.webview = async () => assert.fail('Desktop must not use native WebView DTOs');
  if (mode !== 'success') {
    await assert.rejects(driver.perform('save', driver.scenario), mode === 'lost click' ? /click_response_lost/ : /desktop_save_completion_unconfirmed/);
    assert.equal(driver.savedNote, undefined);
  }
  else {
    const observation = await driver.perform('save', driver.scenario);
    assert.equal(observation.savedNote.action, 'prepare'); assert.equal(observation.savedNote.saveCompletion.source, 'normal-desktop-save-completion');
    assert.equal(observation.savedNote.note_ref, note.note_ref);
  }
  assert.equal(clicks, 1); assert.equal(reads, 1); assert.equal(driver.saveAttempt, null);
  await assert.rejects(driver.observe('save'), /desktop_save_completion_unconfirmed/);
});
