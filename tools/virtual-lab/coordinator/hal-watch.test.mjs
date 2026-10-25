import assert from 'node:assert/strict';
import test from 'node:test';
import { assessHALScope, bootedSimulators, parseSimulatorInputRoute, SIMULATOR_AUDIO_BUNDLE, startHALWatch } from './hal-watch.mjs';

const udid = '57895D36-3997-4047-B12F-0DAB046872EC', other = '43B9AA39-B9DF-44F0-8EC1-E26DBC7619F6';
const target = { udid, hostname: 'test-host' };
const expectedService = { executablePath: '/observed/apple/SimAudioProcessorService', executableSHA256: 'a'.repeat(64) };
function fixture(active = false) {
  const now = Date.now();
  const process = { bundleId: SIMULATOR_AUDIO_BUNDLE, pid: 42, processObjectId: 8, runningInput: active,
    inputDevices: active ? [{ uid: 'BlackHole2ch_UID', transportType: 1, isAggregate: false }] : [], processIdentity: { pid: 42, parentPid: 1,
      executablePath: expectedService.executablePath, startedAtSeconds: 1, startedAtMicroseconds: 2 } };
  const hal = { source: 'coreaudio-read-only-process-metadata', targetDeviceUID: 'BlackHole2ch_UID',
    completeSnapshot: true, processListStable: true, processListNonempty: true, defaultInputStable: true,
    errors: [], defaultInputDeviceUID: 'BuiltInMicrophoneDevice', observedAtEpochMs: now - 90, completedAtEpochMs: now - 80,
    processes: [process] };
  const route = (udid, uid) => ({ udid, first: { selected: 'explicit', effectiveDeviceUID: uid }, last: { selected: 'explicit', effectiveDeviceUID: uid } });
  return { source: 'current-hal-input-scope-observation', hostname: target.hostname, targetUDID: udid,
    deviceUID: 'BlackHole2ch_UID', startedAtEpochMs: now - 100, observedAtEpochMs: now,
    halBefore: structuredClone(hal), hal, bootedBefore: [{ udid }, { udid: other }], bootedAfter: [{ udid }, { udid: other }],
    bootedStable: true, routes: [route(udid, 'BlackHole2ch_UID'), route(other, 'BuiltInMicrophoneDevice')],
    serviceExecutableSHA256: expectedService.executableSHA256 };
}
test('simctl route parsing uses exactly one real audio port and resolves the observed host default', () => {
  const prefix = 'Port:\n    Port Identifier: com.apple.CoreSimulator.Audio.HostRoute\n';
  assert.equal(parseSimulatorInputRoute(prefix + '    Guest Audio Input -> Host Audio Device #BlackHole2ch_UID\n', 'physical').effectiveDeviceUID, 'BlackHole2ch_UID');
  assert.deepEqual(parseSimulatorInputRoute(prefix + '    Guest Audio Input -> Default Host Audio Device\n', 'physical'),
    { selected: 'system-default', effectiveDeviceUID: 'physical' });
  for (const text of ['', prefix, prefix + '    Guest Audio Input -> unknown\n', (prefix + '    Guest Audio Input -> Default Host Audio Device\n').repeat(2)])
    assert.throws(() => parseSimulatorInputRoute(text, 'physical'), /route_unconfirmed/);
});
test('booted inventory rejects empty, duplicate and unavailable guests', () => {
  const entry = { udid, state: 'Booted', isAvailable: true };
  assert.deepEqual(bootedSimulators({ devices: { runtime: [entry] } }), [{ udid }]);
  for (const entries of [[], [entry, entry], [{ ...entry, isAvailable: false }]])
    assert.throws(() => bootedSimulators({ devices: { runtime: entries } }), /inventory_unconfirmed/);
});
test('silent HAL inventory is permitted as metadata but cannot claim active native input', () => {
  const receipt = fixture(), options = { target, expectedService };
  assert.equal(assessHALScope(receipt, options).status, 'OBSERVED_ALLOWED');
  assert.equal(assessHALScope(receipt, { ...options, requireOwnedInput: true }).status, 'BLOCKED');
  const result = assessHALScope(fixture(true), { ...options, requireOwnedInput: true });
  assert.equal(result.status, 'OBSERVED_ALLOWED'); assert.equal(result.activeOwnedInputClients, 1);
  assert.equal(result.screenCaptureKitAbsence, 'NOT_ESTABLISHED'); assert.equal(result.futureReaderExclusion, 'NOT_ESTABLISHED');
});
test('another virtual consumer, shared guest route, reused PID, changed binary and unknown metadata block emission', () => {
  for (const change of [
    r => { r.hal.processes.push({ ...r.hal.processes[0], bundleId: 'unrelated.app', pid: 99 }); },
    r => { r.routes[1].last.effectiveDeviceUID = 'BlackHole2ch_UID'; r.routes[1].first.effectiveDeviceUID = 'BlackHole2ch_UID'; },
    r => { r.hal.processes[0].processIdentity.startedAtMicroseconds++; },
    r => { r.serviceExecutableSHA256 = 'b'.repeat(64); },
    r => { r.hal.completeSnapshot = false; }, r => { r.hal.processes = []; },
    r => { r.hal.processes[0].processIdentity = null; },
    r => { r.hal.processes[0].inputDevices[0].isAggregate = true; },
    r => { r.hal.processes[0].inputDevices = []; },
    r => { r.hal.defaultInputDeviceUID = 'BlackHole2ch_UID'; },
    r => { r.bootedStable = false; }, r => { r.routes[0].last = null; },
    r => { r.observedAtEpochMs -= 3000; }, r => { r.hal.errors.push({ reason: 'permission' }); },
  ]) { const receipt = fixture(true); change(receipt);
    assert.equal(assessHALScope(receipt, { target, expectedService, requireOwnedInput: true }).status, 'BLOCKED', change.toString()); }
});
test('watch stops only through its supplied callback on an unsafe actual sample and drains its timer', async () => {
  let count = 0, unsafe = 0;
  const watch = await startHALWatch({ signal: new AbortController().signal, intervalMs: 100,
    inspect: async () => ({ assessment: { status: ++count === 1 ? 'OBSERVED_ALLOWED' : 'BLOCKED' } }),
    onUnsafe: async receipt => { assert.equal(receipt.assessment.status, 'BLOCKED'); unsafe++; } });
  await new Promise(resolve => setTimeout(resolve, 160));
  const close = await watch.stop(); assert.equal(close.status, 'BLOCKED'); assert.equal(close.ownedResourcesSettled, true);
  assert.equal(unsafe, 1); assert.equal(watch.samples.length, 2);
});
test('normal watch stop drains in-flight metadata without an unsafe-source callback', async () => {
  let calls = 0, unsafe = 0;
  const watch = await startHALWatch({ signal: new AbortController().signal, intervalMs: 100,
    inspect: async signal => { calls++; if (calls > 1) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { assessment: { status: signal.aborted ? 'BLOCKED' : 'OBSERVED_ALLOWED' } }; }, onUnsafe: async () => { unsafe++; } });
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal((await watch.stop()).status, 'STOPPED'); assert.equal(unsafe, 0);
});
test('an unsafe callback aborting its owner cannot erase the failure, including initial and limit failures', async () => {
  for (const mode of ['initial', 'later', 'limit']) {
    const lifetime = new AbortController(); let count = 0;
    const watch = await startHALWatch({ signal: lifetime.signal, intervalMs: 100, maxSamples: mode === 'limit' ? 1 : 2,
      inspect: async () => ({ assessment: { status: mode === 'initial' || mode === 'later' && ++count > 1 ? 'BLOCKED' : 'OBSERVED_ALLOWED' } }),
      onUnsafe: async () => { lifetime.abort(); } });
    if (mode !== 'initial') await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await watch.stop()).status, 'BLOCKED');
  }
});
test('metadata failures or exhausting bounded samples invoke the source callback, and a failed callback stays unconfirmed', async () => {
  for (const fails of [false, true]) {
    let calls = 0, unsafe = 0;
    const watch = await startHALWatch({ signal: new AbortController().signal, intervalMs: 100, maxSamples: fails ? 2 : 1,
      inspect: async () => { if (++calls > 1) throw Error('metadata unavailable'); return { assessment: { status: 'OBSERVED_ALLOWED' } }; },
      onUnsafe: async () => { unsafe++; if (fails) throw Error('source shutdown unknown'); } });
    await new Promise(resolve => setTimeout(resolve, 160));
    const result = await watch.stop(); assert.equal(result.status, 'BLOCKED'); assert.equal(result.ownedResourcesSettled, !fails);
    assert.equal(unsafe, 1);
  }
});
