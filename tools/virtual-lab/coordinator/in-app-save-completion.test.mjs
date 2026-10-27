import assert from 'node:assert/strict';
import test from 'node:test';
import { AppiumUI, IOS_OBSERVER_HASHES } from './appium-ui.mjs';
import { validateSavedReceipt } from './dashboard.mjs';
import { validateInAppSaveCompletion } from './in-app-save-completion.mjs';
import { snapshotSaveUI, SAVE_FIELDS_SCRIPT, SAVE_UI_SCRIPT } from './save-completion.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const suffix = '01m5q661ryetaa28yxe7vbqrex';
const at = n => ({ browserTimeOriginMs: 1000, observedAtMonotonicMs: n });
function fixture(platform, dirty = false) {
  const desktop = platform === 'desktop', scope = { runId: id(1), workspaceId: id(2), appointmentRef: `appointment_${suffix}` };
  const note = { ...scope, source: 'normal-core-note-response', action: dirty ? 'save' : 'prepare', session_id: id(3),
    note_ref: `visit_note_${suffix}`, transcript_ref: `ai_visit_transcript_${suffix}`, schema_ref: `doctor_note_schema_${suffix}`,
    note_sha256: 'a'.repeat(64), source_sha256: 'b'.repeat(64), requestNonce: id(4), status: 'draft', field_order: ['HPI'], ...at(dirty ? 35 : 10) };
  const visit = { ...scope, source: 'normal-native-mount-response', requestId: id(5), revision: id(6),
    ...(desktop ? { transport: 'electron-main-ipc', connectionId: id(7), encounterId: id(8) } : {}), ...at(1) };
  const auth = { source: desktop ? 'normal-desktop-auth-response' : 'normal-native-auth-response', runId: scope.runId,
    phase: 'ready', revision: visit.revision, identitySHA256: 'c'.repeat(64), ...at(15) };
  const descriptor = kind => ({ runId: scope.runId, observerSHA256: desktop ? 'd'.repeat(64) : IOS_OBSERVER_HASHES[kind], pendingObservedReplies: 0 });
  const snapshot = { descriptor: descriptor('admission'), ...(desktop ? {} : { visitDescriptor: descriptor('visit') }),
    currentVisit: visit, currentNote: note, nativeObservation: null, observerPendingReplies: 0,
    observers: { desktop: desktop ? descriptor('desktop') : null, visit: desktop ? null : descriptor('visit'), admission: desktop ? null : descriptor('admission') } };
  const completion = { source: 'normal-in-app-save-completion', platform, attempt: { nonce: id(9), auth, visit,
    note: dirty ? { ...note, action: 'prepare', note_sha256: 'e'.repeat(64), requestNonce: id(10), ...at(10) } : note,
    fields: { source: 'normal-note-editor-fields', fieldsSHA256: note.note_sha256, fieldOrder: note.field_order, ...at(20) },
    click: { source: desktop ? 'normal-desktop-control-response' : 'normal-native-control-response', action: 'click',
      ...(desktop ? { startedAtEpochMs: 1030 } : {}), completedAtEpochMs: 1040 } },
    currentVisit: visit, auth: { ...auth, ...at(45) }, snapshots: [snapshot, structuredClone(snapshot)],
    ui: { source: 'normal-saved-review-ui', heading: 'Saved for review', actions: ['encounters', 'core'],
      fieldCount: 0, documentVisibility: 'visible', ...at(50) } };
  return { scope, note, completion };
}

for (const platform of ['ios', 'desktop']) for (const dirty of [false, true]) {
  test(`${platform}: ${dirty ? 'actual persisted edit with same note ID' : 'clean already persisted draft'} completes in app`, () => {
    const { scope, note, completion } = fixture(platform, dirty);
    assert.equal(validateInAppSaveCompletion(note, completion), completion);
    assert.equal(validateSavedReceipt({ ...note, saveCompletion: completion }, { admissionBinding: scope }).action, note.action);
    assert.equal(completion.handoff, undefined);
    assert.equal(note.note_ref, completion.attempt.note.note_ref);
  });
}

for (const platform of ['ios', 'desktop']) for (const [name, change] of [
  ['no actual click', c => { delete c.attempt.click; }],
  ['future click', c => { c.attempt.click.completedAtEpochMs = 1051; }],
  ['no pre-click fields', c => { c.attempt.fields = null; }],
  ['changed fields', c => { c.attempt.fields.fieldsSHA256 = 'f'.repeat(64); }],
  ['changed field order', c => { c.attempt.fields.fieldOrder = ['Other']; }],
  ['canceled Save', c => { c.ui.heading = 'Keep your note edits?'; }],
  ['hidden completion', c => { c.ui.documentVisibility = 'hidden'; }],
  ['editor remains', c => { c.ui.fieldCount = 1; }],
  ['missing normal action', c => { c.ui.actions = ['core']; }],
  ['different account', c => { c.auth.identitySHA256 = 'f'.repeat(64); }],
  ['different auth revision', c => { c.auth.revision = id(99); }],
  ['stale auth', c => { c.ui.observedAtMonotonicMs = 16000; }],
  ['expired completion', c => { c.ui.observedAtMonotonicMs = 120021; c.auth.observedAtMonotonicMs = 120020; }],
  ['remounted visit', c => { c.currentVisit = { ...c.currentVisit, requestId: id(99) }; }],
  ['foreign visit after UI', c => { c.snapshots[1].currentVisit.appointmentRef = `appointment_01m5q661ryetaa28yxe7vbqrey`; }],
  ['changed source after UI', c => { c.snapshots[1].currentNote.source_sha256 = 'f'.repeat(64); }],
  ['changed note after UI', c => { c.snapshots[1].currentNote.note_ref = `visit_note_01m5q661ryetaa28yxe7vbqrey`; }],
  ['different capture', c => { c.snapshots[1].currentNote.session_id = id(99); }],
  ['pending reply', c => { c.snapshots[1].observerPendingReplies = 1; }],
  ['pending underlying observer', c => { c.snapshots[1].observers[c.platform === 'desktop' ? 'desktop' : 'visit'].pendingObservedReplies = 1; }],
  ['replacement observer', c => { c.snapshots[1].observers[c.platform === 'desktop' ? 'desktop' : 'admission'].observerSHA256 = 'f'.repeat(64); }],
  ['active recorder', c => { c.snapshots[1].nativeObservation = { sessionId: c.attempt.note.session_id, phase: 'recording' }; }],
  ['one snapshot only', c => { c.snapshots.pop(); }],
]) test(`${platform}: ${name} cannot establish in-app Save`, () => {
  const { note, completion } = fixture(platform); change(completion);
  assert.throws(() => validateInAppSaveCompletion(note, completion), /in_app_save_completion_unconfirmed/);
});

for (const change of [
  (n, c) => { n.action = 'prepare'; c.snapshots.forEach(s => { s.currentNote.action = 'prepare'; }); },
  (n, c) => { n.requestNonce = c.attempt.note.requestNonce; c.snapshots.forEach(s => { s.currentNote.requestNonce = n.requestNonce; }); },
  (n, c) => { n.observedAtMonotonicMs = 19; c.snapshots.forEach(s => { s.currentNote.observedAtMonotonicMs = 19; }); },
]) test('dirty content needs its own actual save response after the field snapshot', () => {
  const { note, completion } = fixture('ios', true); change(note, completion);
  assert.throws(() => validateInAppSaveCompletion(note, completion), /in_app_save_completion_unconfirmed/);
});

test('completion reader refuses hidden or duplicate cards and hidden actions', () => {
  const oldDocument = globalThis.document, oldStyle = globalThis.getComputedStyle;
  const shown = () => [{}], buttons = ['encounters', 'core'].map(action => ({ disabled: false,
    getClientRects: shown, dataset: { workspaceAction: action } }));
  const card = { getClientRects: shown, querySelector: () => ({ textContent: 'Saved for review' }), querySelectorAll: () => buttons };
  let cards = [card];
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  globalThis.document = { visibilityState: 'visible', querySelectorAll: selector => selector === '.provider-completion' ? cards : [] };
  try {
    assert.equal(snapshotSaveUI().heading, 'Saved for review');
    card.getClientRects = () => []; assert.equal(snapshotSaveUI().heading, null);
    card.getClientRects = shown; cards = [card, card]; assert.equal(snapshotSaveUI().heading, null);
    cards = [card]; buttons[1].getClientRects = () => []; assert.deepEqual(snapshotSaveUI().actions, ['encounters']);
  } finally { globalThis.document = oldDocument; globalThis.getComputedStyle = oldStyle; }
});

for (const platform of ['ios', 'desktop']) for (const mode of ['clean', 'lost click', 'pending then settled', 'changed source']) {
  test(`${platform} real adapter Save control flow: ${mode}`, async () => {
    const { scope, note, completion } = fixture(platform), driver = new AppiumUI('/unused'), origin = Date.now() - 1000;
    const rebase = value => { if (!value || typeof value !== 'object') return;
      if ('browserTimeOriginMs' in value) value.browserTimeOriginMs = origin; Object.values(value).forEach(rebase); };
    rebase(completion); rebase(note);
    driver.config = { journey: { save: { actions: [{ action: 'click', locator: { using: 'xpath', value: 'observed-save-control' } }] } }, admissionBinding: scope };
    driver.binding = scope; driver.admission = { sessionId: note.session_id }; driver.scenario = { targetId: 'owned-test', admissionBinding: scope };
    driver.terminal = { sessionId: note.session_id, browserTimeOriginMs: origin, observedAtMonotonicMs: 1 };
    let clicks = 0, reads = 0, snapshots = 0;
    driver.readNote = async action => { reads++; assert.equal(action, null); return note; };
    driver.assertVisit = async () => completion.currentVisit;
    driver.readAuth = async () => ({ ...completion.auth, observedAtMonotonicMs: Date.now() - origin });
    const fields = () => ({ ...completion.attempt.fields, observedAtMonotonicMs: Date.now() - origin });
    const ui = () => ({ ...completion.ui, observedAtMonotonicMs: Date.now() - origin });
    const snapshot = () => {
      const value = structuredClone(completion.snapshots[0]); snapshots++;
      if (mode === 'pending then settled' && snapshots <= 2) {
        value.descriptor.pendingObservedReplies = 1; value.observerPendingReplies = 1;
      }
      if (mode === 'changed source') value.currentNote.source_sha256 = 'f'.repeat(64);
      return value;
    };
    driver.withUIContext = async callback => callback();
    driver.rawWebview = async script => { assert.equal(script, SAVE_FIELDS_SCRIPT); return fields(); };
    driver.webview = async script => {
      if (script === SAVE_UI_SCRIPT) return ui();
      if (script.includes('const visit =')) return snapshot();
      assert.fail('No browser handoff, model, mount or API request is allowed during Save observation');
    };
    if (platform === 'desktop') driver.desktop = { observerSHA256: 'd'.repeat(64), readSaveFields: async () => fields(),
      readSaveUI: async () => ui(), recoverySnapshot: async () => snapshot(), readSaveHandoff: async () => assert.fail('No external handoff') };
    driver.find = async () => 'current-save-control';
    const input = async (path, method) => {
      assert.equal(path, '/element/current-save-control/click'); assert.equal(method, 'POST');
      clicks++; if (mode === 'lost click') throw Error('click_response_lost');
    };
    driver.rawRequest = input; driver.request = input;
    driver.check = async () => [{ actual: 'Saved for review', expected: 'Saved for review' }];
    driver.capturePhaseArtifacts = async () => ({ testOnly: true });
    if (mode === 'lost click' || mode === 'changed source') {
      await assert.rejects(driver.perform('save', driver.scenario), mode === 'lost click' ? /click_response_lost/ : /in_app_save_completion_unconfirmed/);
      assert.equal(driver.savedNote, undefined);
    } else {
      const observation = await driver.perform('save', driver.scenario);
      assert.equal(observation.savedNote.action, 'prepare'); assert.equal(observation.savedNote.note_ref, note.note_ref);
      assert.equal(observation.savedNote.saveCompletion.source, 'normal-in-app-save-completion');
      assert.equal(observation.savedNote.saveCompletion.pendingSamples.length, mode === 'pending then settled' ? 2 : 1);
    }
    assert.equal(clicks, 1); assert.equal(reads, 1); assert.equal(driver.saveAttempt, null);
    await assert.rejects(driver.observe('save'), /in_app_save_completion_unconfirmed/);
  });
}
