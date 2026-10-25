import { isAbsolute, relative, resolve } from 'node:path';

const need = (condition, code) => { if (!condition) throw Error(code); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const identityKeys = ['pid', 'parentPid', 'executablePath', 'startedAtSeconds', 'startedAtMicroseconds'];
const sameIdentity = (a, b) => keys(a, identityKeys) && identityKeys.every(key => a[key] === b[key]);
const virtualTransport = 1986622068; // kAudioDeviceTransportTypeVirtual ('virt').
const deviceUID = 'BlackHole2ch_UID';
function processPin(value, appPath) {
  const path = value?.executablePath, within = typeof path === 'string' ? relative(appPath, path) : '..';
  return keys(value, identityKeys) && Number.isSafeInteger(value.pid) && value.pid > 0
    && Number.isSafeInteger(value.parentPid) && value.parentPid >= 0
    && Number.isSafeInteger(value.startedAtSeconds) && value.startedAtSeconds > 0
    && Number.isSafeInteger(value.startedAtMicroseconds) && value.startedAtMicroseconds >= 0 && value.startedAtMicroseconds < 1000000
    && isAbsolute(path) && resolve(path) === path && within && !within.startsWith('..') && !isAbsolute(within);
}

/** This pin refers to separately verified whole-bundle/signature bytes. This
 * pure validator neither verifies a signature nor invents a UI/HAL collector.
 * The transport must observe the current processes and normal Zoom controls.
 */
export function validateNativeZoomPin(value, { runId, meetingIdSHA256 }, target) {
  need(keys(value, ['runId', 'hostname', 'application', 'mainProcess', 'inputProcess', 'inputBundleId'])
    && value.runId === runId && typeof value.hostname === 'string' && value.hostname.length > 0
    && (!target || value.hostname === target.hostname && ['owned-macos-lab', 'owned-macos-guest'].includes(target.role)),
  'native_zoom_pin_invalid');
  const app = value.application;
  need(keys(app, ['appPath', 'bundleId', 'teamId', 'bundleSHA256', 'verificationReceiptSHA256'])
    && typeof app.appPath === 'string' && isAbsolute(app.appPath) && resolve(app.appPath) === app.appPath
    && app.bundleId === 'us.zoom.xos' && app.teamId === 'BJ4HAAB9B3'
    && digest(app.bundleSHA256) && digest(app.verificationReceiptSHA256) && digest(meetingIdSHA256)
    && typeof value.inputBundleId === 'string' && value.inputBundleId.length > 0 && value.inputBundleId.length <= 256
    && processPin(value.mainProcess, app.appPath) && processPin(value.inputProcess, app.appPath), 'native_zoom_pin_invalid');
  return structuredClone(value);
}

/** Metadata projection from normal Zoom UI and the existing read-only HAL
 * helper, bracketed in the SAME remote request clock as the bot proof. No
 * timestamp is renewed here. Sampled custody cannot exclude a future reader
 * or establish ScreenCaptureKit absence; retain that limitation in receipts.
 */
export function requireNativeZoomCustody(value, expected, scope, request, now) {
  need(keys(value, ['source', 'runId', 'hostname', 'requestNonce', 'startedAtEpochMs', 'observedAtEpochMs',
    'verificationReceiptSHA256', 'mainProcessBefore', 'mainProcessAfter', 'ui', 'halBefore', 'halAfter'])
    && value.source === 'current-native-zoom-input-custody' && value.runId === expected.runId
    && value.hostname === expected.hostname && value.requestNonce === request.requestNonce
    && value.verificationReceiptSHA256 === expected.application.verificationReceiptSHA256
    && [value.startedAtEpochMs, value.observedAtEpochMs, now].every(Number.isFinite)
    && value.startedAtEpochMs >= request.sentAtEpochMs && value.observedAtEpochMs >= value.startedAtEpochMs
    && value.observedAtEpochMs <= request.receivedAtEpochMs + 50 && now - value.startedAtEpochMs <= 2000,
  'native_zoom_custody_stale_or_unbound');
  need(sameIdentity(value.mainProcessBefore, expected.mainProcess) && sameIdentity(value.mainProcessAfter, expected.mainProcess),
    'native_zoom_process_changed');
  const ui = value.ui;
  need(keys(ui, ['source', 'observedAtEpochMs', 'meetingIdSHA256', 'joined', 'microphoneConnected', 'muted', 'selectedInputDeviceUID'])
    && ui.source === 'normal-native-zoom-ui' && ui.meetingIdSHA256 === scope.meetingIdSHA256
    && ui.joined === true && ui.microphoneConnected === true && ui.muted === false && ui.selectedInputDeviceUID === deviceUID
    && Number.isFinite(ui.observedAtEpochMs) && ui.observedAtEpochMs >= value.startedAtEpochMs
    && ui.observedAtEpochMs <= value.observedAtEpochMs, 'native_zoom_audio_not_observed');
  for (const sample of [value.halBefore, value.halAfter]) {
    need(keys(sample, ['source', 'targetDeviceUID', 'observedAtEpochMs', 'completedAtEpochMs', 'completeSnapshot',
      'processListStable', 'processListNonempty', 'defaultInputStable', 'defaultInputDeviceUID', 'errors', 'processes'])
      && sample.source === 'coreaudio-read-only-process-metadata' && sample.targetDeviceUID === deviceUID
      && sample.completeSnapshot === true && sample.processListStable === true && sample.processListNonempty === true
      && sample.defaultInputStable === true && typeof sample.defaultInputDeviceUID === 'string' && sample.defaultInputDeviceUID
      && Array.isArray(sample.errors) && sample.errors.length === 0
      && Array.isArray(sample.processes) && sample.processes.length > 0 && sample.processes.length <= 16384
      && Number.isFinite(sample.observedAtEpochMs) && Number.isFinite(sample.completedAtEpochMs)
      && sample.observedAtEpochMs >= value.startedAtEpochMs && sample.completedAtEpochMs >= sample.observedAtEpochMs
      && sample.completedAtEpochMs <= value.observedAtEpochMs, 'native_zoom_hal_unconfirmed');
    let readers = 0;
    const objectIds = new Set();
    for (const process of sample.processes) {
      need(keys(process, ['processObjectId', 'pid', 'bundleId', 'processIdentity', 'runningInput', 'inputDevices', 'usesTargetInput'])
        && Number.isSafeInteger(process.processObjectId) && process.processObjectId > 0 && !objectIds.has(process.processObjectId)
        && Number.isSafeInteger(process.pid) && process.pid > 0 && typeof process.bundleId === 'string'
        && typeof process.runningInput === 'boolean' && typeof process.usesTargetInput === 'boolean'
        && Array.isArray(process.inputDevices) && process.inputDevices.length <= 64, 'native_zoom_hal_unconfirmed');
      objectIds.add(process.processObjectId);
      for (const device of process.inputDevices) need(keys(device, ['objectId', 'uid', 'transportType', 'isAggregate'])
        && Number.isSafeInteger(device.objectId) && device.objectId > 0 && typeof device.uid === 'string' && device.uid
        && Number.isSafeInteger(device.transportType) && typeof device.isAggregate === 'boolean', 'native_zoom_input_unknown');
      const usesTarget = process.inputDevices.some(device => device.uid === deviceUID);
      need(usesTarget === process.usesTargetInput && (!process.runningInput || process.inputDevices.length > 0), 'native_zoom_input_unknown');
      if (!process.runningInput || !usesTarget) continue;
      need(process.pid === expected.inputProcess.pid && process.bundleId === expected.inputBundleId
        && sameIdentity(process.processIdentity, expected.inputProcess), 'native_zoom_foreign_input_reader');
      need(process.inputDevices.length === 1 && process.inputDevices[0].transportType === virtualTransport
        && process.inputDevices[0].isAggregate === false, 'native_zoom_input_not_exclusive');
      readers++;
    }
    need(readers === 1, 'native_zoom_input_not_active');
  }
  need(value.halBefore.completedAtEpochMs <= value.halAfter.observedAtEpochMs
    && value.halBefore.defaultInputDeviceUID === value.halAfter.defaultInputDeviceUID, 'native_zoom_hal_changed');
  return value;
}
