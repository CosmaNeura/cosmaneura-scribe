import assert from 'node:assert/strict';
import test from 'node:test';
import { projectNoteObservation } from './note-observation.mjs';
import { installAdmissionObserver } from './admission-observer.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const suffix = '01m5q661ryetaa28yxe7vbqrex';
const scope = { runId: id(1), workspaceId: id(2), appointmentRef: `appointment_${suffix}` };
const request = { action: 'read', expected_session_id: id(3), workspace_id: id(2),
  binding_ref: `scribe_capture_binding_${suffix}`, request_nonce: id(4), fields: { private: 'must not persist' } };
const body = { contract_version: '1', binding_ref: request.binding_ref, workspace_id: id(2), request_nonce: id(4), action: 'read',
  receipt: { status: 'draft', session_id: id(3), note_ref: `visit_note_${suffix}`, transcript_ref: `ai_visit_transcript_${suffix}`,
    schema_ref: `doctor_note_schema_${suffix}`, note_sha256: 'a'.repeat(64), source_sha256: 'b'.repeat(64), field_order: ['HPI'], fields: { private: 'must not persist' } } };

test('normal Core note metadata binds the request nonce, source session and persisted version without retaining prose', () => {
  const value = projectNoteObservation(request, body, scope);
  assert.equal(value.session_id, id(3)); assert.equal(value.note_sha256, 'a'.repeat(64));
  assert(!JSON.stringify(value).includes('must not persist')); assert(!JSON.stringify(value).includes('binding_ref'));
  for (const patch of [{ request_nonce: id(90) }, { workspace_id: id(91) }, { binding_ref: 'different' },
    { action: 'save' }, { receipt: { ...body.receipt, session_id: id(92) } },
    { receipt: { ...body.receipt, note_ref: null } }, { receipt: { ...body.receipt, status: 'not_prepared' } }])
    assert.equal(projectNoteObservation(request, { ...body, ...patch }, scope), null);
});

test('passive iOS note observer preserves promise identity and excludes late or foreign-session notes', async () => {
  let reply, held;
  const original = () => held ?? Promise.resolve(reply);
  globalThis.window = { Capacitor: { nativePromise: original } };
  installAdmissionObserver(scope, projectNoteObservation);
  const options = { requestId: id(5), revision: id(6), action: 'capture-notes', body: JSON.stringify(request) };
  reply = { status: 200, requestId: id(5), revision: id(6), body: JSON.stringify(body) };
  let finish; held = new Promise(resolve => { finish = resolve; });
  assert.equal(window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'providerRequest', options), held);
  window.__scribeLabAdmissionObserver.clear(); finish(reply); await held; held = null;
  assert.equal(window.__scribeLabAdmissionObserver.readNote('read'), null);
  window.__scribeLabAdmissionObserver.rebindCurrent({ ...scope, revision: id(6) });
  await window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'providerRequest', options);
  assert.equal(window.__scribeLabAdmissionObserver.readNote('read').session_id, id(3));
  assert.equal(window.__scribeLabAdmissionObserver.readCurrentNote().action, 'read');
  const foreign = { ...options, requestId: id(7), body: JSON.stringify({ ...request, action: 'prepare', expected_session_id: id(99) }) };
  reply = { status: 403, requestId: id(7), revision: id(6), body: '{}' };
  await window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'providerRequest', foreign);
  assert.equal(window.__scribeLabAdmissionObserver.readNote('read'), null);
  assert.equal(window.__scribeLabAdmissionObserver.readCurrentNote(), null);
  assert.equal(window.__scribeLabAdmissionObserver.uninstall().ownedResourcesSettled, true);
  assert.equal(window.Capacitor.nativePromise, original); delete globalThis.window;
});

test('normal coordinated note-opening projects the saved tuple only from the exact nested session and nonce', () => {
  const openingRequest = { ...request, action: undefined, transportAction: 'note_opening' };
  const opening = { ...body, action: undefined, operation: 'note_opening',
    receipt: { session_id: id(3), review: { private: 'must not persist' }, templates: [], note: body.receipt } };
  const note = projectNoteObservation(openingRequest, opening, scope);
  assert.equal(note.action, 'read'); assert.equal(note.transportAction, 'note_opening'); assert.equal(note.note_sha256, body.receipt.note_sha256);
  assert(!JSON.stringify(note).includes('must not persist'));
  for (const patch of [{ operation: 'read' }, { request_nonce: id(99) }, { action: 'read' },
    { receipt: { ...opening.receipt, session_id: id(99) } }, { receipt: { ...opening.receipt, note: null } },
    { receipt: { ...opening.receipt, note: { ...body.receipt, session_id: id(99) } } }])
    assert.equal(projectNoteObservation(openingRequest, { ...opening, ...patch }, scope), null);
});

test('same-scope normal remount permits an actual note-opening response after navigation clears cached notes', async () => {
  let reply; globalThis.window = { Capacitor: { nativePromise: () => Promise.resolve(reply) } };
  installAdmissionObserver(scope, projectNoteObservation);
  const observer = window.__scribeLabAdmissionObserver;
  const openingRequest = { ...request, action: undefined };
  const options = { requestId: id(5), revision: id(6), action: 'note-opening', body: JSON.stringify(openingRequest) };
  reply = { status: 200, requestId: id(5), revision: id(6), body: JSON.stringify({ ...body, action: undefined,
    operation: 'note_opening', receipt: { session_id: id(3), review: {}, templates: [], note: body.receipt } }) };
  observer.clear({ reason: 'navigation' });
  await window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'providerRequest', options);
  assert.equal(observer.readNote('read'), null);
  observer.rebindCurrent({ ...scope, revision: id(6) });
  await window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'providerRequest', options);
  assert.equal(observer.readNote('read').transportAction, 'note_opening');
  assert.equal(observer.readCurrentNote().requestNonce, request.request_nonce);
  observer.uninstall();
});

test('malformed latest note requests clear cached evidence and exclude older pending replies', async () => {
  for (const action of ['capture-notes', 'note-opening']) for (const invalidBody of [undefined, '{invalid', 'x'.repeat(270337)]) {
    let held, failure;
    const reply = { status: 200, requestId: id(5), revision: id(6), body: JSON.stringify(body) };
    const original = () => { if (failure) throw failure; return held ?? Promise.resolve(reply); };
    globalThis.window = { Capacitor: { nativePromise: original } };
    installAdmissionObserver(scope, projectNoteObservation);
    const observer = window.__scribeLabAdmissionObserver;
    const options = { requestId: id(5), revision: id(6), action: 'capture-notes', body: JSON.stringify(request) };
    await window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'providerRequest', options);
    assert(observer.readCurrentNote());
    await window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'providerRequest', { ...options, action, body: invalidBody });
    assert.equal(observer.readCurrentNote(), null); assert.equal(observer.readNote('read'), null);
    let finish;
    held = new Promise(resolve => { finish = resolve; });
    const pending = window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'providerRequest', options);
    held = null;
    await window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'providerRequest', { ...options, action, body: invalidBody });
    finish(reply); await pending;
    assert.equal(observer.readCurrentNote(), null); assert.equal(observer.readNote('read'), null);
    await window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'providerRequest', options);
    assert(observer.readCurrentNote()); failure = new Error('original synthetic transport error');
    assert.throws(() => window.Capacitor.nativePromise('CosmasWorkspaceAuth', 'providerRequest', { ...options, action }), error => error === failure);
    assert.equal(observer.readCurrentNote(), null); assert.equal(observer.readNote('read'), null);
    observer.uninstall();
  }
});
