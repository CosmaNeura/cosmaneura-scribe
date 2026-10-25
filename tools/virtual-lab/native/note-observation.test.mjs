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
