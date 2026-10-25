import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { atomicJSON, sha256 } from './journal.mjs';
import { acquireGuard, publishExclusiveJSON, releaseGuard, sameRunIdentity } from './guard.mjs';
import { implementationReceipt } from './tool-identity.mjs';
import { code, digest, makeAuthorizationWindow, projectHostObservation, typeId, uuid, validateAuthorizationScope, validateHostObservation } from './zoom-bot-evidence.mjs';
import { inspectZoomBrowsers, openZoomUI } from './zoom-bot-ui.mjs';

export const ZOOM_BUDGETS = Object.freeze({ uiTimeoutMs: 30000, oauthTimeoutMs: 120000, collectorTimeoutMs: 240000 });
const requireValue = (value, message) => { if (!value) throw Error(message); };
const ids = (values, prefix) => Array.isArray(values) && values.length > 0 && values.length <= 100
  && new Set(values).size === values.length && values.every(value => typeId(value, prefix));
export function validateZoomConfig(config) {
  requireValue(config?.schema === 1 && config.syntheticOnly === true && ['live', 'mock'].includes(config.executionKind)
    && uuid(config.runId) && ['A', 'B'].includes(config.account) && digest(config.identitySHA256)
    && typeId(config.doctorRef, 'doctor') && /^[A-Za-z0-9_-]{16,64}$/.test(config.hostId ?? '')
    && ['profile', 'connect', 'authorize'].includes(config.action) && !JSON.stringify(config).includes('REPLACE_'), 'zoom_configuration_incomplete');
  const origin = new URL(config.apiOrigin);
  requireValue(origin.origin === config.apiOrigin && origin.protocol === 'https:'
    && /^staging(?:-[a-z0-9]+)?\.cosmaneura\.com$/.test(origin.hostname), 'zoom_staging_origin_required');
  requireValue(isAbsolute(config.storageState ?? '') && digest(config.storageStateSHA256)
    && isAbsolute(config.playwrightPath ?? ''), 'zoom_normal_session_required');
  const collector = config.collector;
  requireValue(collector && ['executable', 'script'].every(key => isAbsolute(collector[key] ?? '') && digest(collector[`${key}SHA256`])), 'zoom_collector_pin_required');
  for (const [key, ceiling] of Object.entries(ZOOM_BUDGETS)) requireValue(Number.isSafeInteger(config[key])
    && config[key] >= 1000 && config[key] <= ceiling, 'zoom_budget_invalid');
  if (config.action === 'authorize') {
    const value = config.authorization;
    requireValue(value && /^[0-9]{8,15}$/.test(value.meetingId ?? '') && typeId(value.meetingRecordRef, 'zmtg')
      && typeId(value.appointmentRef, 'appointment') && ids(value.allowedAppointmentRefs, 'appointment')
      && ids(value.allowedPatientRefs, 'patient') && value.allowedAppointmentRefs.includes(value.appointmentRef), 'zoom_exact_authorization_required');
  } else requireValue(config.authorization === undefined, 'zoom_unrequested_authorization_scope');
  return config;
}

async function pinnedFile(path, hash, { privateOnly = false } = {}) {
  const info = await lstat(path), bytes = await readFile(path);
  requireValue(info.isFile() && !info.isSymbolicLink() && info.size <= 300000000
    && (!privateOnly || (info.mode & 0o077) === 0) && sha256(bytes) === hash, 'zoom_pinned_input_changed');
  return bytes;
}

/** A bounded pinned collector gets only the exact public scope through stdin.
 * All stdout stays private and must be valid projected JSON; stderr is never
 * echoed. An aborted transport remains uncertain even after its child exits. */
export async function collectZoomHost(config, request, signal) {
  const collector = config.collector;
  await pinnedFile(collector.executable, collector.executableSHA256);
  await pinnedFile(collector.script, collector.scriptSHA256);
  signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(collector.executable, [collector.script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = Buffer.alloc(0), failure, stderrBytes = 0, kill;
    const stop = reason => { failure ??= reason; child.kill('SIGTERM'); kill ??= setTimeout(() => child.kill('SIGKILL'), 5000); };
    const aborted = () => stop('zoom_collector_aborted');
    const timeout = setTimeout(() => stop('zoom_collector_timeout'), config.collectorTimeoutMs);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    child.stdout.on('data', bytes => { if (output.length + bytes.length > 262144) stop('zoom_collector_output_limit'); else output = Buffer.concat([output, bytes]); });
    child.stderr.on('data', bytes => { stderrBytes += bytes.length; if (stderrBytes > 262144) stop('zoom_collector_output_limit'); });
    child.stdin.on('error', () => stop('zoom_collector_stdin_failed'));
    child.on('error', () => { failure ??= 'zoom_collector_launch_failed'; });
    child.on('close', status => {
      clearTimeout(timeout); clearTimeout(kill); signal.removeEventListener('abort', aborted);
      if (failure || status !== 0) { reject(Object.assign(Error(failure ?? 'zoom_collector_failed'), { ownedResourcesSettled: !failure })); return; }
      try { resolveResult(JSON.parse(output.toString('utf8'))); } catch { reject(Error('zoom_collector_json_invalid')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** Separate bot journal: no native Save/session claims and no automatic retry
 * of OAuth or authorization intents. A resumed action is reconciled by fresh
 * UI + collector reads. An absent response never means the action failed. */
export async function runZoomBot({ configPath, output, command = 'run', signal, ports, onCheckpoint = () => {} }) {
  requireValue(signal instanceof AbortSignal && ['doctor', 'run', 'resume'].includes(command), 'zoom_runner_arguments_required');
  signal.throwIfAborted();
  const configBytes = await readFile(configPath), config = validateZoomConfig(JSON.parse(configBytes));
  requireValue(!ports || config.executionKind === 'mock', 'zoom_mock_ports_forbidden_for_live');
  await pinnedFile(config.storageState, config.storageStateSHA256, { privateOnly: true });
  const implementation = await implementationReceipt();
  await mkdir(output, { recursive: true, mode: 0o700 }); output = await realpath(output);
  const runIdentity = { runId: config.runId, scenarioSHA256: sha256(configBytes), implementationSHA256: implementation.sha256, outputCanonical: output };
  const statePath = resolve(output, 'zoom-run.json');
  let state, initialBytes;
  if (command === 'resume') {
    initialBytes = await readFile(statePath); state = JSON.parse(initialBytes);
    requireValue(sameRunIdentity(state.runIdentity, runIdentity) && state.executionKind === config.executionKind, 'zoom_resume_identity_changed');
  } else {
    state = { schema: 1, runIdentity, account: config.account, executionKind: config.executionKind, status: 'INITIALIZING', pending: null,
      observations: [], attempts: [], startedAtEpochMs: Date.now(), fullAcceptance: 'NOT_RUN', botMedia: 'NOT_RUN',
      botNote: 'NOT_RUN', manualSave: 'NOT_AVAILABLE', savedPassagePlayback: 'NOT_AVAILABLE' };
    await publishExclusiveJSON(statePath, state); initialBytes = await readFile(statePath);
  }
  // All profile runners use the same local per-user host mutex, independent of
  // output path. A dead owner is claimable only by its exact same run.
  const lockRoot = resolve(await realpath(tmpdir()), `scribe-zoom-bot-${process.getuid()}`);
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const lockInfo = await lstat(lockRoot); requireValue(lockInfo.isDirectory() && !lockInfo.isSymbolicLink() && lockInfo.uid === process.getuid(), 'zoom_lock_root_invalid');
  await chmod(lockRoot, 0o700);
  const owner = { attemptId: randomUUID(), pid: process.pid, host: hostname(), runIdentity };
  const guard = await acquireGuard(resolve(lockRoot, `${sha256(config.hostId)}.guard`), owner, { recoverDeadOwner: command === 'resume' });
  let ui, latestHostRequest, cleanup = { ownedResourcesSettled: true }, collectorUncertain = state.cleanup?.collectorTransportUncertain === true;
  const persist = () => atomicJSON(statePath, state);
  const observe = async (phase, value) => {
    const name = `${phase}-${randomUUID()}.json`; await atomicJSON(resolve(output, name), value);
    state.observations.push({ phase, file: name, sha256: sha256(await readFile(resolve(output, name))) }); await persist(); return value;
  };
  const host = async () => {
    const request = { version: 1, runId: config.runId, requestNonce: randomUUID(), account: config.account, hostId: config.hostId, doctorRef: config.doctorRef,
      ...(config.authorization ? { authorization: config.authorization } : {}) };
    const createdAtEpochMs = Date.now();
    latestHostRequest = { ...request, createdAtEpochMs };
    let value;
    try { value = await (ports?.collect ?? collectZoomHost)(config, request, signal); }
    catch (error) { if (error.ownedResourcesSettled === false) collectorUncertain = true; throw error; }
    await observe('host', projectHostObservation(value));
    return validateHostObservation(value, config, latestHostRequest);
  };
  const profile = async () => {
    const value = await ui.profile(); await observe('profile', value);
    requireValue(value.executionKind === config.executionKind && value.identitySHA256 === config.identitySHA256
      && value.actor?.doctorRef === config.doctorRef && value.actor.active === false && value.actor.targetPresent === false
      && typeof value.settings?.connected === 'boolean' && !value.settings.failureCode, 'zoom_profile_identity_unconfirmed');
    return value;
  };
  const oauthIncomplete = cause => {
    state.status = 'OAUTH_INCOMPLETE';
    state.oauth = { cause, browserSessionResumable: false, resumeBehavior: 'reconcile_external_normal_connection_only' };
  };
  try {
    requireValue(sha256(await readFile(statePath)) === sha256(initialBytes), 'zoom_journal_changed_before_guard');
    requireValue(!collectorUncertain, 'zoom_collector_prior_transport_unconfirmed');
    delete state.failureCode;
    for (const entry of state.observations) {
      requireValue(/^[a-z]+-[a-f0-9-]{36}\.json$/.test(entry.file), 'zoom_observation_path_invalid');
      await pinnedFile(resolve(output, entry.file), entry.sha256, { privateOnly: true });
    }
    await (ports?.inspect ?? inspectZoomBrowsers)(output, runIdentity, signal);
    ui = await (ports?.open ?? openZoomUI)({ config, output, runIdentity, signal });
    let current = await profile(), binding = await host();
    const connected = () => current.settings.connected === true && binding.bindingState === 'CONNECTED_TO_EXPECTED_HOST';
    requireValue(current.settings.connected === (binding.bindingState === 'CONNECTED_TO_EXPECTED_HOST'), 'zoom_profile_binding_disagrees');
    if (command === 'doctor' || config.action === 'profile') {
      state.status = config.executionKind === 'live' ? 'PROFILE_OBSERVED' : 'MOCK_PROFILE_OBSERVED';
    } else if (config.action === 'connect') {
      if (connected()) { state.pending = null; delete state.oauth; state.status = 'CONNECTED_OBSERVED'; }
      else if (state.pending) oauthIncomplete('normal_oauth_connection_not_observed');
      else {
        // The management/DB collector can take longer than the browser scope's
        // 15-second freshness window. Refresh through normal UI before Connect.
        current = await profile();
        binding = validateHostObservation(binding, config, latestHostRequest);
        requireValue(current.settings.connected === false && binding.bindingState === 'UNBOUND', 'zoom_profile_binding_changed_before_connect');
        state.pending = { action: 'connect', intentId: randomUUID(), atEpochMs: Date.now() }; await persist();
        await onCheckpoint({ status: 'OAUTH_USER_CHECKPOINT', account: config.account, runId: config.runId,
          instruction: 'Complete normal ZoomReviewer sign-in and consent within this bounded wait. The owned browser closes afterward; resume only checks an externally completed normal connection.' });
        const result = await ui.connect(); await observe('oauth', result);
        if (result.status === 'OAUTH_INCOMPLETE') oauthIncomplete(result.reason);
        else {
          current = await profile(); binding = await host();
          requireValue(connected(), 'zoom_oauth_binding_unconfirmed'); state.pending = null; delete state.oauth; state.status = 'CONNECTED_OBSERVED';
        }
      }
    } else {
      requireValue(connected(), 'zoom_connection_required');
      requireValue(current.settings.noteSchemaCount > 0, 'zoom_note_schema_setup_required');
      validateAuthorizationScope(binding, config.authorization);
      let schedule = await observe('schedule', await ui.schedule({ allowLists: true }));
      const enabled = () => schedule.meeting?.captureAuthorized === true && schedule.meeting.appointmentRef === config.authorization.appointmentRef;
      if (enabled()) { state.pending = null; state.status = 'AUTHORIZATION_OBSERVED'; }
      else if (state.pending) state.status = 'AUTHORIZATION_UNCERTAIN';
      else {
        requireValue(schedule.meeting?.status === 'scheduled', 'zoom_not_started_authorization_required');
        // Do not authorize an already-running meeting: this slice has no media
        // consent/recording gate yet. A normal future Schedule intent is safe.
        binding = await host(); validateAuthorizationScope(binding, config.authorization);
        current = await profile();
        requireValue(current.settings.connected && current.settings.noteSchemaCount > 0, 'zoom_profile_prerequisite_changed');
        schedule = await observe('schedule', await ui.schedule({ allowLists: true }));
        requireValue(schedule.meeting?.status === 'scheduled' && schedule.meeting.captureAuthorized === false, 'zoom_meeting_changed_before_authorization');
        state.pending = { action: 'authorize', intentId: randomUUID(), atEpochMs: Date.now() }; await persist();
        // All intervening profile, schedule and journal work may consume the
        // host receipt's lifetime. Revalidate the exact bound receipt now; the
        // UI checks this same window again after its dialog and at the POST.
        const hostWindow = makeAuthorizationWindow(binding, config, latestHostRequest);
        await observe('authorization', await ui.authorize({ hostWindow }));
        schedule = await observe('schedule', await ui.schedule({ allowLists: false }));
        requireValue(enabled(), 'zoom_authorization_not_reconciled');
        state.pending = null; state.status = 'AUTHORIZATION_OBSERVED';
      }
    }
  } catch (error) {
    state.status = 'FAIL'; state.failureCode = code(error);
    if (error.cleanup?.ownedResourcesSettled === false) cleanup = error.cleanup;
  } finally {
    if (ui) {
      try { await observe('responses', await ui.observations()); } catch { state.responseObservationIncomplete = true; }
      try { cleanup = await ui.close(); } catch { cleanup = { ownedResourcesSettled: false }; }
    }
    cleanup.collectorTransportUncertain = collectorUncertain;
    state.cleanup = cleanup; state.guardRetained = cleanup.ownedResourcesSettled !== true || collectorUncertain;
    if (state.status === 'OAUTH_INCOMPLETE') {
      const closed = cleanup.ownedResourcesSettled === true;
      state.status = closed ? 'OAUTH_INCOMPLETE_BROWSER_CLOSED' : 'OAUTH_INCOMPLETE_CLEANUP_UNCONFIRMED';
      state.oauth.reason = closed ? 'normal_oauth_incomplete_browser_closed' : 'owned_browser_cleanup_unconfirmed';
      state.oauth.explanation = 'Resume reconciles a separately completed normal OAuth connection; it does not resume the original browser. An unconnected account needs a separate explicit normal OAuth action.';
    }
    state.completedAtEpochMs = Date.now(); await persist();
    state.attempts.push({ attemptId: owner.attemptId, status: state.status, failureCode: state.failureCode,
      pending: state.pending, cleanup, completedAtEpochMs: state.completedAtEpochMs }); await persist();
    if (!state.guardRetained) await releaseGuard(guard);
  }
  return state;
}
