import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNativeZoomPin, requireNativeZoomCustody } from './native-zoom-custody.mjs';

// Contract projections only: no UI, HAL, microphone, source or provider call.
const clone = value => structuredClone(value);
function fixture() {
  const scope = { runId: '00000000-0000-4000-8000-000000000001', meetingIdSHA256: 'a'.repeat(64) };
  const mainProcess = { pid: 100, parentPid: 1, executablePath: '/owned/zoom.us.app/Contents/MacOS/zoom.us',
    startedAtSeconds: 100, startedAtMicroseconds: 9 };
  const inputProcess = { ...mainProcess, pid: 101, parentPid: 100, executablePath: '/owned/zoom.us.app/Contents/Frameworks/audio' };
  const pin = { runId: scope.runId, hostname: 'owned.local', application: { appPath: '/owned/zoom.us.app', bundleId: 'us.zoom.xos',
    teamId: 'BJ4HAAB9B3', bundleSHA256: 'b'.repeat(64), verificationReceiptSHA256: 'c'.repeat(64) }, mainProcess, inputProcess, inputBundleId: 'us.zoom.xos' };
  const request = { requestNonce: '00000000-0000-4000-8000-000000000002', sentAtEpochMs: 1000, receivedAtEpochMs: 1020 };
  const process = { processObjectId: 10, pid: 101, bundleId: pin.inputBundleId, processIdentity: clone(inputProcess), runningInput: true,
    inputDevices: [{ objectId: 11, uid: 'BlackHole2ch_UID', transportType: 1986622068, isAggregate: false }], usesTargetInput: true };
  const halBefore = { source: 'coreaudio-read-only-process-metadata', targetDeviceUID: 'BlackHole2ch_UID', observedAtEpochMs: 1001,
    completedAtEpochMs: 1003, completeSnapshot: true, processListStable: true, processListNonempty: true, defaultInputStable: true,
    defaultInputDeviceUID: 'unrelated-host-default', errors: [], processes: [process] };
  const receipt = { source: 'current-native-zoom-input-custody', runId: scope.runId, hostname: pin.hostname,
    requestNonce: request.requestNonce, startedAtEpochMs: 1000, observedAtEpochMs: 1019,
    verificationReceiptSHA256: pin.application.verificationReceiptSHA256,
    mainProcessBefore: clone(mainProcess), mainProcessAfter: clone(mainProcess),
    ui: { source: 'normal-native-zoom-ui', observedAtEpochMs: 1005, meetingIdSHA256: scope.meetingIdSHA256,
      joined: true, microphoneConnected: true, muted: false, selectedInputDeviceUID: 'BlackHole2ch_UID' },
    halBefore, halAfter: { ...clone(halBefore), observedAtEpochMs: 1010, completedAtEpochMs: 1018 } };
  return { scope, pin, request, receipt, now: 1021 };
}
const check = ({ receipt, pin, scope, request, now }) => requireNativeZoomCustody(receipt, pin, scope, request, now);
test('normal Zoom UI plus two complete HAL samples binds exactly the pinned virtual input process', () => {
  const value = fixture();
  assert.deepEqual(validateNativeZoomPin(value.pin, value.scope, { hostname: value.pin.hostname, role: 'owned-macos-lab' }), value.pin);
  assert.equal(check(value), value.receipt);
  // No default setter is required: explicit Zoom input can differ from default.
  assert.equal(value.receipt.halBefore.defaultInputDeviceUID, 'unrelated-host-default');
});
test('pin rejects an unowned role, foreign run/host, nonofficial app and path escape', () => {
  for (const mutate of [p => p.runId = 'foreign', p => p.application.teamId = 'foreign', p => p.application.bundleId = 'other',
    p => p.application.bundleSHA256 = '', p => p.application.verificationReceiptSHA256 = '',
    p => p.mainProcess.executablePath = '/outside/zoom', p => p.inputProcess.executablePath = '/owned/zoom.us.app/../other',
    p => p.inputProcess.startedAtMicroseconds = 1000000]) {
    const value = fixture(); mutate(value.pin); assert.throws(() => validateNativeZoomPin(value.pin, value.scope));
  }
  const value = fixture();
  for (const target of [{ hostname: 'other', role: 'owned-macos-lab' }, { hostname: value.pin.hostname, role: 'owned-ios-simulator' }])
    assert.throws(() => validateNativeZoomPin(value.pin, value.scope, target));
});
test('changed or reused PID, startup identity, binary path and signature receipt are rejected', () => {
  for (const mutate of [r => r.mainProcessAfter.pid++, r => r.mainProcessBefore.startedAtMicroseconds++,
    r => r.mainProcessAfter.executablePath += '-other', r => r.verificationReceiptSHA256 = '0'.repeat(64),
    r => r.halAfter.processes[0].pid++, r => r.halBefore.processes[0].processIdentity.startedAtSeconds++,
    r => r.halAfter.processes[0].processIdentity.executablePath = '/foreign', r => r.halAfter.processes[0].bundleId = 'foreign']) {
    const value = fixture(); mutate(value.receipt); assert.throws(() => check(value));
  }
});
test('normal joined unmuted explicit virtual input and the exact meeting must all be observed', () => {
  for (const patch of [{ joined: false }, { microphoneConnected: false }, { muted: true }, { muted: null },
    { selectedInputDeviceUID: 'default' }, { selectedInputDeviceUID: 'BuiltInMicrophoneDevice' },
    { meetingIdSHA256: 'f'.repeat(64) }, { source: 'operator_verified' }, { observedAtEpochMs: 999 }]) {
    const value = fixture(); Object.assign(value.receipt.ui, patch); assert.throws(() => check(value), /audio_not_observed/);
  }
});
test('extra, unknown, aggregate, physical and absent input readers never qualify custody', () => {
  for (const mutate of [s => s.processes.push({ ...clone(s.processes[0]), processObjectId: 99, pid: 999 }),
    s => s.processes[0].inputDevices.push({ objectId: 23, uid: 'physical', transportType: 1, isAggregate: false }),
    s => s.processes[0].inputDevices[0].isAggregate = true, s => s.processes[0].inputDevices[0].transportType = 1,
    s => s.processes[0].inputDevices[0].uid = 'BuiltInMicrophoneDevice', s => s.processes[0].inputDevices = [],
    s => s.processes[0].runningInput = false, s => s.processes[0].runningInput = null,
    s => s.processes[0].processIdentity = null, s => s.processes[0].usesTargetInput = false,
    s => s.processes.push(clone(s.processes[0])), s => s.errors.push({ reason: 'metadata' }),
    s => s.completeSnapshot = false, s => s.processListStable = false, s => s.defaultInputStable = false]) {
    for (const key of ['halBefore', 'halAfter']) {
      const value = fixture(); mutate(value.receipt[key]); assert.throws(() => check(value));
    }
  }
});
test('custody cannot be replayed, restamped, reordered, or mixed with unknown content', () => {
  for (const mutate of [v => v.now += 2001, v => v.receipt.requestNonce = 'foreign', v => v.receipt.runId = 'foreign',
    v => v.receipt.hostname = 'foreign', v => v.receipt.startedAtEpochMs = 999,
    v => v.receipt.halAfter.observedAtEpochMs = 1002, v => v.receipt.halAfter.completedAtEpochMs = 9999,
    v => v.receipt.halAfter.defaultInputDeviceUID = 'changed', v => v.receipt.ui.rawText = 'unknown',
    v => v.receipt.halBefore.processes[0].audio = 'unknown']) {
    const value = fixture(); mutate(value); assert.throws(() => check(value));
  }
});
