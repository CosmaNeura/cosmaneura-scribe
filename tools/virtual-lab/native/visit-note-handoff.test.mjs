import assert from 'node:assert/strict';
import test from 'node:test';
import { installVisitScopeObserver } from './visit-observer.mjs';
import { installAdmissionObserver } from './admission-observer.mjs';
import { projectNoteObservation } from './note-observation.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const suffix = '01m5q661ryetaa28yxe7vbqrex';
const scope = { runId: id(1), workspaceId: id(2), appointmentRef: `appointment_${suffix}` };
async function fixture() {
  let override, held, count = 10;
  const native = (_plugin, method, options) => {
    if (held) return held;
    if (method === 'getState') return Promise.resolve({ revision: id(4), phase: 'ready', identity: { userId: 'user_synthetic' } });
    const request = JSON.parse(options.body);
    const body = options.action === 'mount' ? { revision: id(4), workspaceId: scope.workspaceId, appointmentRef: scope.appointmentRef }
      : { ...request, contract_version: '1', receipt: { status: 'draft', session_id: id(3), note_ref: `visit_note_${suffix}`,
        transcript_ref: `ai_visit_transcript_${suffix}`, schema_ref: `doctor_note_schema_${suffix}`, note_sha256: request.action === 'save' ? 'b'.repeat(64) : 'a'.repeat(64),
        source_sha256: 'c'.repeat(64), field_order: ['HPI'], fields: { private: 'do not retain' } } };
    return Promise.resolve(override ?? { status: 200, requestId: options.requestId, revision: id(4), body: JSON.stringify(body) });
  };
  globalThis.window = { Capacitor: { nativePromise: native, fromNative() {} } };
  installVisitScopeObserver({ runId: scope.runId }); installAdmissionObserver(scope, projectNoteObservation);
  const call = (action, fields) => window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'providerRequest', {
    action, revision: id(4), requestId: id(count++), body: JSON.stringify({ workspace_id: scope.workspaceId, ...fields }),
  });
  const note = action => call('capture-notes', { action, expected_session_id: id(3), request_nonce: id(count++), binding_ref: `scribe_capture_binding_${suffix}` });
  await window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'getState', {});
  await call('mount'); await note('read');
  return { call, note, visit: window.__scribeLabVisitObserver, admission: window.__scribeLabAdmissionObserver,
    reply(value) { override = value; }, hold(promise) { held = promise; },
    close() { window.__scribeLabAdmissionObserver.uninstall(); window.__scribeLabVisitObserver.uninstall(); delete globalThis.window; } };
}
test('clean Save remount clears current note but preserves only its exact correlated metadata handoff', async () => {
  const f = await fixture();
  try {
    const prior = f.admission.readCurrentNote(); await f.call('mount');
    assert.equal(f.admission.readCurrentNote(), null);
    const handoff = f.visit.readNoteHandoff();
    assert.deepEqual(handoff.note, prior); assert.equal(handoff.requestId, f.visit.readCurrent().requestId);
    assert.equal(handoff.pendingObservedReplies, 0); assert.equal(handoff.revision, id(4));
    assert(!JSON.stringify(handoff).includes('do not retain'));
    handoff.note.field_order.push('changed'); assert.deepEqual(f.visit.readNoteHandoff().note.field_order, ['HPI']);
  } finally { f.close(); }
});
test('dirty Save uses the latest actual acknowledgement before mount, not the pre-edit note', async () => {
  const f = await fixture(); try { await f.note('save'); await f.call('mount');
    assert.equal(f.visit.readNoteHandoff().note.action, 'save');
    assert.equal(f.visit.readNoteHandoff().note.note_sha256, 'b'.repeat(64));
  } finally { f.close(); }
});
test('unavailable metadata observer cannot change a normal product mount result', async () => {
  const f = await fixture(), observer = window.__scribeLabAdmissionObserver;
  try {
    window.__scribeLabAdmissionObserver = { ...observer, readCurrentNote() { throw Error('metadata_unavailable'); } };
    const reply = await f.call('mount'); assert.equal(reply.status, 200); assert.equal(f.visit.readNoteHandoff(), null);
  } finally { window.__scribeLabAdmissionObserver = observer; f.close(); }
});
for (const mode of ['denied', 'wrong-request', 'foreign-scope', 'malformed']) test(`${mode} mount cannot publish a handoff`, async () => {
  const f = await fixture(); try {
    f.reply({ status: mode === 'denied' ? 403 : 200, requestId: mode === 'wrong-request' ? id(99) : id(13), revision: id(4),
      body: mode === 'malformed' ? '{' : JSON.stringify({ revision: id(4), workspaceId: mode === 'foreign-scope' ? id(99) : scope.workspaceId, appointmentRef: scope.appointmentRef }) });
    await f.call('mount'); assert.equal(f.visit.readNoteHandoff(), null);
  } finally { f.close(); }
});
test('failed or unparseable later mount retires an earlier handoff without pretending it settled', async () => {
  const f = await fixture(); try { await f.call('mount'); assert(f.visit.readNoteHandoff());
    assert.throws(() => window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'providerRequest', { action: 'mount', body: '{' }));
    assert.equal(f.visit.readNoteHandoff(), null);
  } finally { f.close(); }
});
test('auth switch and later note requests invalidate handoff; a late mount cannot restore it', async () => {
  const f = await fixture(); try {
    let finish; const pending = new Promise(resolve => { finish = resolve; }); f.hold(pending);
    assert.equal(f.call('mount'), pending); f.hold(null);
    await f.note('save');
    finish({ status: 200, requestId: id(13), revision: id(4), body: JSON.stringify({ revision: id(4), workspaceId: scope.workspaceId, appointmentRef: scope.appointmentRef }) });
    await pending; assert.equal(f.visit.readNoteHandoff(), null);
    await f.note('read'); await f.call('mount'); assert(f.visit.readNoteHandoff());
    window.Capacitor.fromNative({ pluginId: 'CosmasWorkspaceAuth', methodName: 'addListener', success: true,
      data: { phase: 'ready', revision: id(88), identity: { userId: 'user_other' } } });
    assert.equal(f.visit.readNoteHandoff(), null);
  } finally { f.close(); }
});
