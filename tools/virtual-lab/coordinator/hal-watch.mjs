import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { sha256 } from './journal.mjs';

const exec = promisify(execFile);
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const SIMULATOR_AUDIO_BUNDLE = 'com.apple.CoreSimulator.SimAudioProcessorServices.SimAudioProcessorService';
const identityKeys = ['pid', 'parentPid', 'executablePath', 'startedAtSeconds', 'startedAtMicroseconds'];

export function parseSimulatorInputRoute(text, defaultInputDeviceUID) {
  if (typeof text !== 'string' || text.length > 1000000 || typeof defaultInputDeviceUID !== 'string' || !defaultInputDeviceUID)
    throw Error('simulator_input_route_unconfirmed');
  const ports = text.split(/^Port:\s*$/m).filter(value => /Port Identifier: com\.apple\.CoreSimulator\.Audio\.HostRoute\s*$/m.test(value));
  if (ports.length !== 1) throw Error('simulator_input_route_unconfirmed');
  const matches = [...ports[0].matchAll(/^\s*Guest Audio Input -> (.+)\s*$/gm)];
  if (matches.length !== 1) throw Error('simulator_input_route_unconfirmed');
  const selected = matches[0][1].trim();
  if (selected === 'Default Host Audio Device') return { selected: 'system-default', effectiveDeviceUID: defaultInputDeviceUID };
  const explicit = /^Host Audio Device #([^\s]{1,512})$/.exec(selected);
  if (!explicit) throw Error('simulator_input_route_unconfirmed');
  return { selected: 'explicit', effectiveDeviceUID: explicit[1] };
}

export function bootedSimulators(value) {
  if (!value?.devices || typeof value.devices !== 'object' || Array.isArray(value.devices)) throw Error('simulator_inventory_unconfirmed');
  const devices = Object.values(value.devices).flatMap(group => {
    if (!Array.isArray(group)) throw Error('simulator_inventory_unconfirmed');
    return group.filter(device => device.state === 'Booted').map(device => {
      if (!uuid(device.udid) || device.isAvailable !== true) throw Error('simulator_inventory_unconfirmed');
      return { udid: device.udid.toUpperCase() };
    });
  }).sort((a, b) => a.udid.localeCompare(b.udid));
  if (!devices.length || devices.length > 64 || new Set(devices.map(device => device.udid)).size !== devices.length)
    throw Error('simulator_inventory_unconfirmed');
  return devices;
}

/** Assess observed metadata only. This cannot establish SCK absence or exclude
 * a reader starting between samples. The caller must retain the raw receipt. */
export function assessHALScope(receipt, { target, expectedService, requireOwnedInput = false, now = Date.now() }) {
  const reasons = [], hal = receipt.hal, before = receipt.halBefore;
  if (receipt.source !== 'current-hal-input-scope-observation' || receipt.targetUDID !== target.udid.toUpperCase()
      || receipt.hostname !== target.hostname || receipt.deviceUID !== 'BlackHole2ch_UID'
      || !Number.isFinite(receipt.startedAtEpochMs) || !Number.isFinite(receipt.observedAtEpochMs)
      || receipt.observedAtEpochMs < receipt.startedAtEpochMs || receipt.observedAtEpochMs - receipt.startedAtEpochMs > 5000
      || Math.abs(now - receipt.observedAtEpochMs) > 2000) reasons.push('hal_scope_stale_or_unbound');
  for (const sample of [before, hal]) {
    if (!sample || sample.source !== 'coreaudio-read-only-process-metadata' || sample.targetDeviceUID !== receipt.deviceUID
        || sample.completeSnapshot !== true || sample.processListStable !== true || sample.processListNonempty !== true
        || sample.defaultInputStable !== true || !Array.isArray(sample.processes) || !sample.processes.length
        || !Array.isArray(sample.errors) || sample.errors.length || typeof sample.defaultInputDeviceUID !== 'string'
        || !Number.isFinite(sample.observedAtEpochMs) || !Number.isFinite(sample.completedAtEpochMs)
        || sample.observedAtEpochMs < receipt.startedAtEpochMs - 50 || sample.completedAtEpochMs > receipt.observedAtEpochMs + 50)
      reasons.push('hal_snapshot_incomplete');
  }
  if (before?.defaultInputDeviceUID !== hal?.defaultInputDeviceUID) reasons.push('hal_default_input_changed');
  if (!Array.isArray(receipt.routes) || !receipt.routes.length || receipt.bootedStable !== true
      || JSON.stringify(receipt.bootedBefore) !== JSON.stringify(receipt.bootedAfter)
      || receipt.routes.length !== receipt.bootedAfter?.length
      || new Set(receipt.routes.map(route => route.udid)).size !== receipt.routes.length) reasons.push('simulator_inventory_changed');
  const routes = receipt.routes ?? [];
  if (routes.filter(route => route.udid === receipt.targetUDID).length !== 1
      || routes.some(route => !receipt.bootedAfter?.some(device => device.udid === route.udid)
        || !route.first || !route.last || JSON.stringify(route.first) !== JSON.stringify(route.last))) reasons.push('simulator_routes_unconfirmed');
  const routed = routes.filter(route => route.last?.effectiveDeviceUID === receipt.deviceUID);
  if (routed.length !== 1 || routed[0]?.udid !== receipt.targetUDID) reasons.push('virtual_input_route_not_exclusive');
  let ownedInputs = 0;
  const serviceIdentity = sample => (sample?.processes ?? []).filter(process => process.bundleId === SIMULATOR_AUDIO_BUNDLE);
  const firstService = serviceIdentity(before), lastService = serviceIdentity(hal);
  if (firstService.length !== 1 || lastService.length !== 1
      || identityKeys.some(key => firstService[0]?.processIdentity?.[key] !== lastService[0]?.processIdentity?.[key]))
    reasons.push('simulator_audio_process_changed');
  for (const process of [...firstService, ...lastService]) {
    const identity = process.processIdentity;
    if (!identity || identity.pid !== process.pid || !Number.isSafeInteger(identity.pid) || identity.pid <= 0
        || !Number.isSafeInteger(identity.startedAtSeconds) || identity.startedAtSeconds <= 0
        || !Number.isSafeInteger(identity.startedAtMicroseconds) || identity.startedAtMicroseconds < 0 || identity.startedAtMicroseconds >= 1000000
        || identity.executablePath !== expectedService.executablePath
        || receipt.serviceExecutableSHA256 !== expectedService.executableSHA256 || !digest(receipt.serviceExecutableSHA256))
      reasons.push('simulator_audio_process_unconfirmed');
  }
  for (const sample of [before, hal]) for (const process of sample?.processes ?? []) {
    if (typeof process.runningInput !== 'boolean' || !Array.isArray(process.inputDevices)) { reasons.push('hal_process_unconfirmed'); continue; }
    if (process.runningInput && (!process.inputDevices.length || process.inputDevices.some(device =>
      typeof device.uid !== 'string' || !device.uid || !Number.isSafeInteger(device.transportType) || device.isAggregate !== false)))
      reasons.push('active_input_device_route_unconfirmed');
    if (!process.runningInput || !process.inputDevices.some(device => device.uid === receipt.deviceUID)) continue;
    const identity = process.processIdentity;
    if (process.bundleId !== SIMULATOR_AUDIO_BUNDLE || !identity || identity.pid !== process.pid
        || !Number.isSafeInteger(identity.startedAtSeconds) || identity.startedAtSeconds <= 0
        || !Number.isSafeInteger(identity.startedAtMicroseconds) || identity.startedAtMicroseconds < 0 || identity.startedAtMicroseconds >= 1000000
        || identity.executablePath !== expectedService.executablePath
        || receipt.serviceExecutableSHA256 !== expectedService.executableSHA256 || !digest(receipt.serviceExecutableSHA256))
      reasons.push('foreign_or_unconfirmed_virtual_input_client');
    else if (sample === hal) ownedInputs++;
  }
  if (requireOwnedInput && ownedInputs !== 1) reasons.push('owned_simulator_input_not_active');
  return { status: reasons.length ? 'BLOCKED' : 'OBSERVED_ALLOWED', reasons: [...new Set(reasons)],
    activeOwnedInputClients: ownedInputs, scope: 'sampled-hal-input-clients-and-simulator-routes',
    screenCaptureKitAbsence: 'NOT_ESTABLISHED', futureReaderExclusion: 'NOT_ESTABLISHED' };
}

/** Runs only read-only metadata commands. No routing/default changes, native
 * product commands, process signals, or microphone/audio stream are issued. */
export async function inspectHALScope({ target, inventoryHelper, helperSHA256, expectedService, signal, requireOwnedInput = false }) {
  if (!(signal instanceof AbortSignal) || target?.role !== 'owned-ios-simulator' || target.hostname !== hostname()
      || !uuid(target.udid) || !isAbsolute(inventoryHelper) || !digest(helperSHA256)
      || !isAbsolute(expectedService?.executablePath ?? '') || !digest(expectedService?.executableSHA256)) throw Error('hal_scope_configuration_required');
  signal.throwIfAborted();
  const root = await realpath(target.root), markerPath = await realpath(target.marker), rel = relative(root, markerPath);
  if (rel.startsWith('..') || isAbsolute(rel)) throw Error('hal_target_marker_outside_owned_root');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  if (marker.purpose !== 'scribe-synthetic-virtual-lab' || marker.role !== target.role
      || marker.hostname !== hostname() || marker.udid !== target.udid) throw Error('hal_target_marker_mismatch');
  const helper = await realpath(inventoryHelper), stat = await lstat(helper);
  if (!stat.isFile() || stat.size > 10000000 || sha256(await readFile(helper)) !== helperSHA256) throw Error('hal_helper_identity_changed');
  const receipt = { source: 'current-hal-input-scope-observation', hostname: hostname(), targetUDID: target.udid.toUpperCase(),
    deviceUID: 'BlackHole2ch_UID', helperSHA256, startedAtEpochMs: Date.now() };
  const active = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const command = async (file, args) => { active.throwIfAborted(); return (await exec(file, args,
    { signal: active, timeout: 5000, maxBuffer: 1000000 })).stdout; };
  try {
    const inventory = async () => bootedSimulators(JSON.parse(await command('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'])));
    receipt.halBefore = JSON.parse(await command(helper, ['inspect']));
    receipt.bootedBefore = await inventory();
    receipt.routes = [];
    for (const { udid } of receipt.bootedBefore) receipt.routes.push({ udid,
      first: parseSimulatorInputRoute(await command('xcrun', ['simctl', 'io', udid, 'enumerate']), receipt.halBefore.defaultInputDeviceUID) });
    for (const route of receipt.routes) route.last = parseSimulatorInputRoute(
      await command('xcrun', ['simctl', 'io', route.udid, 'enumerate']), receipt.halBefore.defaultInputDeviceUID);
    receipt.bootedAfter = await inventory();
    receipt.bootedStable = JSON.stringify(receipt.bootedBefore) === JSON.stringify(receipt.bootedAfter);
    receipt.hal = JSON.parse(await command(helper, ['inspect']));
    const service = (receipt.hal.processes ?? []).find(process => process.bundleId === SIMULATOR_AUDIO_BUNDLE);
    if (service?.processIdentity?.executablePath === expectedService.executablePath)
      receipt.serviceExecutableSHA256 = sha256(await readFile(await realpath(expectedService.executablePath)));
    active.throwIfAborted();
    receipt.observedAtEpochMs = Date.now();
    receipt.assessment = assessHALScope(receipt, { target, expectedService, requireOwnedInput });
  } catch (error) {
    receipt.observedAtEpochMs = Date.now();
    receipt.assessment = { status: 'BLOCKED', reasons: [active.aborted ? 'hal_inspection_aborted' : /^[a-z_]{1,100}$/.test(error.message) ? error.message : 'hal_inspection_failed'],
      scope: 'sampled-hal-input-clients-and-simulator-routes', screenCaptureKitAbsence: 'NOT_ESTABLISHED', futureReaderExclusion: 'NOT_ESTABLISHED' };
  }
  return receipt;
}

/** The supplied failure callback may stop only the caller's owned source.
 * It must never pause, terminate or reconfigure another process. */
export async function startHALWatch({ inspect, onUnsafe, signal, intervalMs = 1000, maxSamples = 1200 }) {
  if (!(signal instanceof AbortSignal) || typeof inspect !== 'function' || typeof onUnsafe !== 'function'
      || !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 5000
      || !Number.isSafeInteger(maxSamples) || maxSamples < 1 || maxSamples > 3600) throw Error('hal_watch_configuration_required');
  const own = new AbortController(), active = AbortSignal.any([signal, own.signal]), samples = [];
  let failure = null, stoppedForUnsafe = false, unsafeCallbackFailed = false;
  const sample = async () => {
    const receipt = await inspect(active); samples.push(receipt);
    if (active.aborted) return false;
    if (receipt?.assessment?.status !== 'OBSERVED_ALLOWED') { stoppedForUnsafe = true; await onUnsafe(receipt); return false; }
    return true;
  };
  active.throwIfAborted();
  if (!await sample()) return { samples, stop: async () => ({ ownedResourcesSettled: true, status: stoppedForUnsafe ? 'BLOCKED' : 'STOPPED' }) };
  const work = (async () => {
    while (!active.aborted) {
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); active.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, intervalMs); active.addEventListener('abort', done, { once: true });
      });
      if (active.aborted) break;
      if (samples.length >= maxSamples) { stoppedForUnsafe = true;
        await onUnsafe({ assessment: { status: 'BLOCKED', reasons: ['hal_watch_sample_limit'] } }); break; }
      if (!await sample()) break;
    }
  })().catch(async error => { if (active.aborted && !stoppedForUnsafe) return;
    failure = error; stoppedForUnsafe = true;
    try { await onUnsafe({ assessment: { status: 'BLOCKED', reasons: ['hal_watch_failed'] } }); }
    catch { unsafeCallbackFailed = true; } });
  return { samples, async stop() { own.abort(); await work;
    return { ownedResourcesSettled: !unsafeCallbackFailed, status: failure || stoppedForUnsafe ? 'BLOCKED' : 'STOPPED', sampleCount: samples.length }; } };
}
