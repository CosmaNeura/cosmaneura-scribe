import test from 'node:test';
import assert from 'node:assert/strict';
import { readRetainedAdmission } from './retained-admission.mjs';

function fixture() {
  const admission = Object.freeze({ sessionId: 'session', consentRecordId: 'consent', observedAtMonotonicMs: 1, browserTimeOriginMs: 10 });
  let reads = 0;
  return { admission, current: null, get reads() { return reads; },
    checkAdmission(value) { if (!value || value === undefined) throw Error('admission_not_observed'); return value; },
    async readAdmission() { return this.current; }, async readRecording() { reads++; return { sessionId: 'session', phase: 'ready' }; } };
}
test('an expired delivery cache keeps the exact original consent timestamps and requires native state', async () => {
  const f = fixture(), before = structuredClone(f.admission), proof = await readRetainedAdmission(f);
  assert.equal(proof.admission, f.admission); assert.deepEqual(f.admission, before);
  assert.equal(proof.admissionEvidence, 'retained-normal-consent'); assert.equal(f.reads, 1);
});
test('a current receipt also requires a current native response', async () => {
  const f = fixture(); f.current = { ...f.admission };
  assert.equal((await readRetainedAdmission(f)).admissionEvidence, 'current-normal-consent'); assert.equal(f.reads, 1);
});
for (const key of ['sessionId', 'consentRecordId']) test('replacement '+key+' is refused without reading another recorder', async () => {
  const f = fixture(); f.current = { ...f.admission, [key]: 'changed' };
  await assert.rejects(readRetainedAdmission(f), /restored_consent_changed/); assert.equal(f.reads, 0);
});
test('unknown cache state, absent persisted consent and missing current native evidence refuse', async () => {
  for (const patch of [{ current: undefined }, { admission: null }, { readRecording: async () => { throw Error('native_recording_state_unavailable'); } }]) {
    await assert.rejects(readRetainedAdmission(Object.assign(fixture(), patch)));
  }
});
