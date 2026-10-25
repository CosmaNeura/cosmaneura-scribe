import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { closedLifecycleProvesStopped } from './closed-lifecycle.mjs';
import { nativeCleanupProvesStopped } from './engine.mjs';
import { validateRecoveryInspection } from './recovery.mjs';

// Protocol-only injected evidence. Actual UI runs must collect these fields
// from the passive observer, not from this fixture or a configuration flag.
function fixture(desktop = false) {
  const now = Date.now(), timeOrigin = now - 100000;
  const scope = { runId: randomUUID(), workspaceId: randomUUID(), appointmentRef: 'appointment_01m5q8r3kzeng9szb5frh6ppk3' };
  const admission = { ...scope, source: 'normal-native-admission-response', sessionId: randomUUID(), revision: randomUUID() };
  const native = { ...admission, source: desktop ? 'normal-desktop-recording-response' : 'normal-native-recording-response',
    recorderId: randomUUID(), nativeRevision: 2, observedAtMonotonicMs: 200, browserTimeOriginMs: timeOrigin };
  const record = { ...native, phase: 'recording', busy: false, pendingMutation: false };
  const finish = { ...native, nativeRevision: 9, phase: desktop ? 'stopped' : 'sealed', busy: false,
    captureState: 'processing', pendingMutation: false, observedAtMonotonicMs: 10000 };
  const descriptor = { runId: scope.runId, observerSHA256: 'a'.repeat(64), pendingObservedReplies: 0 };
  const scenario = { runId: 'lifecycle-test', targetId: 'owned-test', executionKind: 'live', admissionBinding: { runId: scope.runId } };
  const proof = { source: 'current-native-cleanup-observation', executionKind: 'live', runId: scenario.runId, targetId: scenario.targetId,
    observedAtEpochMs: now, currentVisit: { ...scope, revision: admission.revision, source: 'normal-native-mount-response' },
    nativeObservation: null, observerPendingReplies: 0,
    observers: desktop ? { visit: null, admission: null, desktop: { ...descriptor, pid: 100, webContentsId: 2 } }
      : { visit: { ...descriptor }, admission: { ...descriptor }, desktop: null },
    closedLifecycle: { ...scope, source: desktop ? 'normal-desktop-recorder-close-response' : 'normal-native-recorder-close-response',
      sessionId: admission.sessionId, recorderId: native.recorderId, authRevision: admission.revision,
      recordingSource: native.source, nativeRevisionBeforeClose: 10, closeRequestId: randomUUID(),
      closeMethod: desktop ? 'workspace_open' : 'close', phase: 'closed', captureMutationSequence: 5, currentCaptureMutationSequence: 5,
      observedAtMonotonicMs: 20000, browserTimeOriginMs: timeOrigin, inspectedAtMonotonicMs: now - timeOrigin, pendingObservedReplies: 0 } };
  return { proof, scenario, observations: { consent: { admission }, record: { nativeObservation: record }, finish: { nativeTerminal: finish } }, now };
}

test('an old correlated close plus fresh uninterrupted observer inspection releases only its exact finished recorder', () => {
  for (const desktop of [false, true]) {
    const { proof, scenario, observations, now } = fixture(desktop);
    assert(now - proof.closedLifecycle.browserTimeOriginMs - proof.closedLifecycle.observedAtMonotonicMs > 15000);
    assert.equal(closedLifecycleProvesStopped(proof, scenario, observations), true);
    assert.equal(nativeCleanupProvesStopped(proof, scenario, observations, now), true);
    const recovery = { ...proof, source: 'current-native-recovery-observation', recoveryStage: 'capture', currentNote: null, unresolvedOwnedResources: [] };
    const result = validateRecoveryInspection(recovery, scenario, observations, { events: [], completed: ['record', 'finish'] });
    assert.equal(result.captureStopped, true); assert.equal(result.nativePhase, 'closed');
    assert.equal(result.proofKind, 'correlated-native-close');
  }
});

test('absence, replacement, new mutations, old inspections and pending replies never establish closure', () => {
  const changes = [
    value => { delete value.proof.closedLifecycle; }, value => { value.proof.nativeObservation = undefined; },
    value => { value.proof.nativeObservation = value.observations.record.nativeObservation; },
    value => { value.proof.currentVisit.workspaceId = randomUUID(); },
    value => { value.proof.currentVisit.revision = randomUUID(); },
    value => { value.proof.closedLifecycle.sessionId = randomUUID(); },
    value => { value.proof.closedLifecycle.recorderId = randomUUID(); },
    value => { value.proof.closedLifecycle.authRevision = randomUUID(); },
    value => { value.proof.closedLifecycle.currentCaptureMutationSequence++; },
    value => { value.proof.closedLifecycle.pendingObservedReplies = 1; },
    value => { value.proof.observerPendingReplies = 1; },
    value => { value.proof.closedLifecycle.inspectedAtMonotonicMs -= 6000; },
    value => { value.proof.closedLifecycle.observedAtMonotonicMs = 200001; },
    value => { value.proof.closedLifecycle.observedAtMonotonicMs = 0; },
    value => { value.proof.closedLifecycle.nativeRevisionBeforeClose = 8; },
    value => { value.proof.closedLifecycle.recordingSource = 'normal-desktop-recording-response'; },
    value => { value.proof.closedLifecycle.closeMethod = 'encounter_closed'; },
    value => { delete value.proof.observers; }, value => { value.proof.observers.visit = null; },
    value => { value.proof.observers.admission.observerSHA256 = null; },
    value => { value.proof.observers.admission.runId = randomUUID(); },
    value => { value.proof.observers.admission.pendingObservedReplies = 1; },
    value => { delete value.observations.finish; }, value => { delete value.observations.record; },
    value => { value.observations.finish.nativeTerminal.phase = 'sealing'; },
    value => { value.observations.finish.nativeTerminal.busy = true; },
    value => { value.observations.record.nativeObservation.nativeRevision = 11; },
  ];
  for (const change of changes) { const value = fixture(); change(value);
    assert.equal(closedLifecycleProvesStopped(value.proof, value.scenario, value.observations), false, change.toString()); }
});

test('cleanup and recovery independently reject stale, foreign and premature closed receipts', () => {
  for (const change of [p => { p.runId = 'foreign'; }, p => { p.targetId = 'foreign'; }, p => { p.observedAtEpochMs -= 6000; }]) {
    const { proof, scenario, observations, now } = fixture(); change(proof);
    assert.equal(nativeCleanupProvesStopped(proof, scenario, observations, now), false);
    assert.throws(() => validateRecoveryInspection({ ...proof, source: 'current-native-recovery-observation',
      recoveryStage: 'capture', currentNote: null, unresolvedOwnedResources: [] }, scenario, observations,
    { events: [], completed: ['record', 'finish'] }), /recovery_resources_unconfirmed/);
  }
  const { proof, scenario, observations } = fixture(true);
  for (const method of ['deactivate', 'workspace_list', 'workspace_open']) {
    proof.closedLifecycle.closeMethod = method;
    assert.equal(closedLifecycleProvesStopped(proof, scenario, observations), true);
  }
  observations.finish.nativeTerminal.captureState = 'paused';
  assert.equal(closedLifecycleProvesStopped(proof, scenario, observations), false);
});
