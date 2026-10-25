import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { ACTIONS, Journal, atomicJSON, sha256 } from './journal.mjs';
import { acquireGuard, publishExclusiveJSON, releaseGuard, sameRunIdentity } from './guard.mjs';
import { loadObservations, validateScenario } from './engine.mjs';
import { validateDashboardConfig, validateSavedReceipt, verifyDashboardIsolation } from './dashboard.mjs';
import { implementationReceipt, journalIdentity } from './tool-identity.mjs';

const code = error => /^[a-z_]{1,100}$/.test(error?.message) ? error.message : 'account_journey_failed';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const isolated = values => new Set(values).size === values.length;

export function validateNativeAccountObservations(observations, scenario, identitySHA256) {
  for (const action of ['sign_in', 'workspace', 'create_visit']) {
    const observed = observations[action], auth = observed?.nativeAuth;
    const epoch = auth?.browserTimeOriginMs + auth?.observedAtMonotonicMs;
    if (!auth || !['normal-native-auth-response', 'normal-desktop-auth-response'].includes(auth.source)
        || auth.runId !== scenario.admissionBinding?.runId || auth.phase !== 'ready' || auth.identitySHA256 !== identitySHA256
        || !/^[a-f0-9]{64}$/.test(identitySHA256) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(auth.revision ?? '')
        || !Number.isFinite(epoch) || !Number.isFinite(observed.observedAtEpochMs)
        || observed.observedAtEpochMs - epoch > 15000 || epoch > observed.observedAtEpochMs + 50)
      throw Error('account_native_identity_unconfirmed');
  }
}

/** Validate both accounts before starting either native journey. The config's
 * exact bytes, expected account and normal hosted session store are immutable. */
export async function loadAccountMatrix(manifestPath) {
  const path = await realpath(manifestPath), bytes = await readFile(path), manifest = JSON.parse(bytes);
  if (manifest.schema !== 1 || manifest.syntheticOnly !== true || !['live', 'mock'].includes(manifest.executionKind)
      || !/^[a-z][a-z0-9-]{2,80}$/.test(manifest.runId ?? '') || JSON.stringify(manifest).includes('REPLACE_')
      || !Array.isArray(manifest.accounts) || manifest.accounts.length !== 2
      || manifest.accounts[0].id !== 'a' || manifest.accounts[1].id !== 'b') throw Error('two_account_matrix_required');
  const accounts = [];
  for (const account of manifest.accounts) {
    if (typeof account.scenarioPath !== 'string' || typeof account.nativeConfigPath !== 'string') throw Error('account_paths_required');
    const scenarioPath = await realpath(resolve(dirname(path), account.scenarioPath));
    const nativeConfigPath = await realpath(resolve(dirname(path), account.nativeConfigPath));
    const scenario = validateScenario(await json(scenarioPath)), nativeBytes = await readFile(nativeConfigPath);
    const native = JSON.parse(nativeBytes), dashboard = validateDashboardConfig(native.dashboard);
    if (scenario.executionKind !== manifest.executionKind || JSON.stringify(native).includes('REPLACE_')
        || sha256(nativeBytes) !== scenario.adapterSHA256 || native.targetId !== scenario.targetId
        || native.accountIdentitySHA256 !== dashboard.identitySHA256
        || JSON.stringify(native.admissionBinding) !== JSON.stringify(scenario.admissionBinding)) throw Error('account_configuration_mismatch');
    const storageState = await realpath(dashboard.storageState), storageBytes = await readFile(storageState);
    if (sha256(storageBytes) !== dashboard.storageStateSHA256) throw Error('hosted_session_store_changed');
    accounts.push({ id: account.id, scenarioPath, nativeConfigPath, scenario, storageState,
      nativeSHA256: sha256(nativeBytes), scenarioSHA256: sha256(JSON.stringify(scenario)),
      identitySHA256: dashboard.identitySHA256, storageStateSHA256: sha256(storageBytes) });
  }
  if (!['scenarioPath', 'nativeConfigPath', 'storageState', 'identitySHA256', 'storageStateSHA256'].every(key => isolated(accounts.map(account => account[key])))
      || !isolated(accounts.map(account => account.scenario.runId))
      || !isolated(accounts.map(account => account.scenario.admissionBinding?.runId))) throw Error('accounts_not_isolated');
  const profiles = accounts.flatMap(account => account.scenario.personas.map(persona => resolve(persona.profile)));
  if (!isolated(profiles)) throw Error('account_persona_profiles_shared');
  return { manifest, manifestSHA256: sha256(bytes), accounts };
}

async function completedAccount(account, output, executionKind) {
  const identity = await journalIdentity(account.scenario);
  const journal = await Journal.load(resolve(output, 'run.json'), identity, true, { readOnly: true });
  const expected = executionKind === 'live' ? 'UI_JOURNEY_PASS' : 'MOCK_JOURNEY_PASS';
  if (journal.state.status !== expected || journal.state.pending !== null
      || JSON.stringify(journal.state.completed) !== JSON.stringify(ACTIONS)) throw Error('account_journey_incomplete');
  const observations = await loadObservations(output, journal.state);
  const dashboard = observations.dashboard;
  if (!dashboard || dashboard.identitySHA256 !== account.identitySHA256 || dashboard.cleanup?.ownedResourcesSettled !== true
      || !dashboard.detail?.binding || !dashboard.reopenedDetail?.binding
      || JSON.stringify(dashboard.detail.binding) !== JSON.stringify(dashboard.reopenedDetail.binding)
      || dashboard.failureCode || !dashboard.checks?.length || dashboard.checks.some(check => check.actual !== check.expected)) throw Error('account_dashboard_unconfirmed');
  if (executionKind === 'live') {
    validateNativeAccountObservations(observations, account.scenario, account.identitySHA256);
    const saved = validateSavedReceipt(observations.save?.savedNote, account.scenario);
    const binding = dashboard.detail.binding, reopened = observations.reopen?.savedNote;
    if (dashboard.nativeSavedReceiptSHA256 !== sha256(JSON.stringify(saved))
        || binding.appointmentRef !== saved.appointmentRef || binding.nativeSessionId !== saved.session_id
        || binding.noteRef !== saved.note_ref || binding.transcriptRef !== saved.transcript_ref || binding.noteSHA256 !== saved.note_sha256
        || reopened?.source !== saved.source || ['runId', 'workspaceId', 'appointmentRef', 'session_id', 'note_ref', 'transcript_ref', 'note_sha256']
          .some(key => reopened[key] !== saved[key])) throw Error('account_saved_capture_binding_mismatch');
  }
  const cleanupPath = resolve(output, 'cleanup.json'), cleanupBytes = await readFile(cleanupPath), cleanup = JSON.parse(cleanupBytes);
  if (cleanup.ownedResourcesSettled !== true || cleanup.targetLeaseRetained !== false || cleanup.enginePendingOperations?.length !== 0) throw Error('account_cleanup_unconfirmed');
  return { id: account.id, status: expected, identitySHA256: account.identitySHA256,
    runJournalSHA256: sha256(await readFile(resolve(output, 'run.json'))), cleanupSHA256: sha256(cleanupBytes),
    dashboardObservationSHA256: sha256(JSON.stringify(dashboard)),
    appointmentRef: dashboard.detail.binding.appointmentRef, doctorRef: dashboard.detail.binding.doctorRef, nativeSessionId: dashboard.detail.binding.nativeSessionId,
    noteRef: dashboard.detail.binding.noteRef, transcriptRef: dashboard.detail.binding.transcriptRef,
    savedPassagePlayback: dashboard.savedPassagePlayback ?? { status: 'NOT_RUN' } };
}

/** Entry point for root's CLI. runAccount must await runJourney and its cleanup;
 * this function never starts B while A is running, failing, or uncertain. It
 * independently reads hash-bound observations instead of trusting its return. */
export async function runAccountMatrix({ manifestPath, output, runAccount, signal, resume = false, verifyIsolation = verifyDashboardIsolation }) {
  if (!(signal instanceof AbortSignal) || typeof runAccount !== 'function') throw Error('matrix_runner_and_signal_required');
  signal.throwIfAborted();
  const { manifest, manifestSHA256, accounts } = await loadAccountMatrix(manifestPath);
  const implementation = await implementationReceipt();
  await mkdir(output, { recursive: true, mode: 0o700 });
  output = await realpath(output);
  const runIdentity = { runId: manifest.runId, scenarioSHA256: manifestSHA256,
    implementationSHA256: implementation.sha256, outputCanonical: output };
  const resultPath = resolve(output, 'matrix.json');
  let priorBytes;
  if (!resume) {
    // Publish the complete run binding before a process can leave a guard. A
    // crash at any later point is recoverable only by this exact matrix.
    const initial = { schema: 1, runId: manifest.runId, executionKind: manifest.executionKind,
      manifestSHA256, implementationSHA256: implementation.sha256, runIdentity, status: 'INITIALIZING',
      accounts: [], fullAcceptance: 'NOT_RUN', startedAt: new Date().toISOString() };
    priorBytes = Buffer.from(JSON.stringify(initial) + '\n');
    try { await publishExclusiveJSON(resultPath, initial); }
    catch (error) { if (error.code === 'EEXIST') throw Error('matrix_exists_or_changed'); throw error; }
  }
  try { priorBytes ??= await readFile(resultPath); }
  catch (error) { if (error.code === 'ENOENT') throw Error('matrix_not_found'); throw error; }
  const prior = JSON.parse(priorBytes);
  if (prior.schema !== 1 || prior.runId !== manifest.runId || prior.executionKind !== manifest.executionKind
      || prior.manifestSHA256 !== manifestSHA256 || prior.implementationSHA256 !== implementation.sha256
      || !sameRunIdentity(prior.runIdentity, runIdentity) || !Array.isArray(prior.accounts)) throw Error('matrix_exists_or_changed');
  const guard = await acquireGuard(resolve(output, '.matrix-lock'), { attemptId: randomUUID(), pid: process.pid,
    host: hostname(), runIdentity }, { recoverDeadOwner: resume });
  let result;
  try {
    // A competing resumer may have acquired/released ownership since the first
    // read. Never run from that earlier state or overwrite its new receipts.
    if (!priorBytes.equals(await readFile(resultPath))) throw Error('matrix_changed_during_acquisition');
    signal.throwIfAborted();
    result = { schema: 1, runId: manifest.runId, executionKind: manifest.executionKind, manifestSHA256,
      implementationSHA256: implementation.sha256, runIdentity,
      status: 'RUNNING', accounts: [], fullAcceptance: 'NOT_RUN', startedAt: prior?.startedAt ?? new Date().toISOString() };
    await atomicJSON(resultPath, result);
    for (const account of accounts) {
      signal.throwIfAborted();
      if ((await implementationReceipt()).sha256 !== implementation.sha256) throw Error('tool_implementation_changed');
      // Files may have changed while the earlier account was running.
      if (sha256(await readFile(account.nativeConfigPath)) !== account.nativeSHA256
          || sha256(JSON.stringify(await json(account.scenarioPath))) !== account.scenarioSHA256
          || sha256(await readFile(account.storageState)) !== account.storageStateSHA256) throw Error('account_inputs_changed');
      const accountOutput = resolve(output, account.id);
      await mkdir(accountOutput, { recursive: true, mode: 0o700 });
      result.activeAccount = account.id;
      await atomicJSON(resultPath, result);
      if (!prior?.accounts?.some(item => item.id === account.id && ['UI_JOURNEY_PASS', 'MOCK_JOURNEY_PASS'].includes(item.status))) {
        let accountResume = false;
        if (resume) { try { await readFile(resolve(accountOutput, 'run.json')); accountResume = true; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
        await runAccount({ accountId: account.id, scenario: account.scenario, nativeConfigPath: account.nativeConfigPath,
          output: accountOutput, signal, resume: accountResume });
      }
      signal.throwIfAborted();
      result.accounts.push(await completedAccount(account, accountOutput, manifest.executionKind));
      result.activeAccount = null;
      await atomicJSON(resultPath, result);
    }
    if (!isolated(result.accounts.map(account => account.appointmentRef)) || !isolated(result.accounts.map(account => account.nativeSessionId))) throw Error('account_capture_scope_reused');
    result.crossAccountIsolation = [];
    result.crossAccountIsolationStatus = 'NOT_RUN';
    if (manifest.executionKind === 'live') {
      for (const [viewer, owner] of [[accounts[1], accounts[0]], [accounts[0], accounts[1]]]) {
        signal.throwIfAborted();
        if (sha256(await readFile(viewer.nativeConfigPath)) !== viewer.nativeSHA256
            || sha256(await readFile(viewer.storageState)) !== viewer.storageStateSHA256) throw Error('account_inputs_changed');
        const native = await json(viewer.nativeConfigPath);
        if ((await implementationReceipt()).sha256 !== implementation.sha256) throw Error('tool_implementation_changed');
        const ownerJournal = await Journal.load(resolve(output, owner.id, 'run.json'), await journalIdentity(owner.scenario), true, { readOnly: true });
        const ownerObservations = await loadObservations(resolve(output, owner.id), ownerJournal.state);
        const foreignSavedReceipt = ownerObservations.save.savedNote;
        const isolationOutput = resolve(output, 'isolation', `${viewer.id}-to-${owner.id}`);
        const actual = await verifyIsolation({ config: native.dashboard, scenario: viewer.scenario, foreignScenario: owner.scenario,
          foreignSavedReceipt, viewerDoctorRef: result.accounts.find(account => account.id === viewer.id).doctorRef, output: isolationOutput, signal });
        const actualBytes = await readFile(resolve(isolationOutput, 'isolation-observation.json'));
        const retained = JSON.parse(actualBytes);
        if (sha256(JSON.stringify(actual)) !== sha256(JSON.stringify(retained)) || retained.origin !== 'product-ui' || retained.executionKind !== 'live'
            || retained.failureCode || ![403, 404].includes(retained.httpStatus) || retained.denial?.httpStatus !== retained.httpStatus
            || retained.identitySHA256 !== viewer.identitySHA256 || retained.denial.identitySHA256 !== viewer.identitySHA256
            || retained.denial.actorDoctorRef !== result.accounts.find(account => account.id === viewer.id).doctorRef
            || retained.denial.activeViewAs !== false || retained.denial.viewAsTargetPresent !== false
            || retained.requestedAppointmentRef !== foreignSavedReceipt.appointmentRef || retained.foreignSavedReceiptSHA256 !== sha256(JSON.stringify(foreignSavedReceipt))
            || retained.cleanup?.ownedResourcesSettled !== true) throw Error('cross_account_isolation_unconfirmed');
        result.crossAccountIsolation.push({ viewer: viewer.id, owner: owner.id, httpStatus: retained.httpStatus,
          observationSHA256: sha256(actualBytes), observationPath: `isolation/${viewer.id}-to-${owner.id}/isolation-observation.json` });
        await atomicJSON(resultPath, result);
      }
      result.crossAccountIsolationStatus = 'BILATERAL_DENIAL_OBSERVED';
    }
    result.status = manifest.executionKind === 'live' ? 'UI_MATRIX_PASS' : 'MOCK_MATRIX_PASS';
  } catch (error) {
    if (!result) throw error;
    result.status = 'FAIL'; result.failureCode = signal.aborted ? 'matrix_aborted' : code(error);
  } finally {
    if (result) { result.finishedAt = new Date().toISOString(); await atomicJSON(resultPath, result); }
    await releaseGuard(guard);
  }
  return result;
}
