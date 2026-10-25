import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceGroup } from './sources.mjs';
import { atomicJSON, sha256 } from './journal.mjs';
import { inspectHALScope, startHALWatch } from './hal-watch.mjs';
import { validNativeCleanupProof } from './engine.mjs';
import { recoveryStage } from './recovery.mjs';
import { nativeIdentity, verifyBuild } from './native-identity.mjs';
import { installAdmissionObserver } from '../native/admission-observer.mjs';
import { installVisitScopeObserver } from '../native/visit-observer.mjs';
import { createDesktopObserver } from './desktop-observer.mjs';
import { projectNoteObservation } from '../native/note-observation.mjs';
import { verifyDashboard } from './dashboard.mjs';
import { inspectParticipantResources } from '../zoom/resource-owner.mjs';
import { createSessionAttempt, recoverSessionCreations, sessionReturned, sessionClosed, sessionNotDispatched,
  sessionCapsMatch, SESSION_ATTEMPT_CAPABILITY, SESSION_CREATION_TIMEOUT_MS } from './session-attempt.mjs';

const exec = promisify(execFile);
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';
const wait = ms => new Promise(r => setTimeout(r, ms));
export const IOS_OBSERVER_HASHES = Object.freeze({
  visit: sha256(installVisitScopeObserver.toString()),
  admission: sha256(installAdmissionObserver.toString() + projectNoteObservation.toString()),
});
/** Standard WebDriver actions on an independently guarded owned native target. */
export class AppiumUI {
  constructor(configPath) {
    this.configPath = configPath; this.session = null; this.sources = null; this.admission = null;
    this.lifetime = new AbortController(); this.pending = new Set(); this.webviewTail = Promise.resolve();
    this.observerLifetime = new AbortController(); this.desktop = null;
    this.uncertainMutations = new Set(); this.commandSequence = 0;
  }
  async loadConfig(scenario) {
    const bytes = await readFile(this.configPath);
    if (sha256(bytes) !== scenario.adapterSHA256) throw Error('adapter_configuration_changed');
    this.config = JSON.parse(bytes);
    if (JSON.stringify(this.config).includes('REPLACE_')) throw Error('native_configuration_incomplete');
    const url = new URL(this.config.appiumUrl);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password) throw Error('appium_loopback_required');
    this.base = this.config.appiumUrl.replace(/\/$/, '');
    if (this.config.targetId !== scenario.targetId || this.config.app.bundleId !== scenario.build.bundleId
        || String(this.config.app.build) !== String(scenario.build.number)) throw Error('native_target_identity_mismatch');
    if (JSON.stringify(this.config.admissionBinding) !== JSON.stringify(scenario.admissionBinding)) throw Error('admission_binding_mismatch');
    if (!/^[a-f0-9]{64}$/.test(this.config.accountIdentitySHA256 ?? '')) throw Error('native_account_identity_required');
    if (this.config.sources && ![undefined, 'live'].includes(this.config.sources.executionKind)) throw Error('live_sources_required');
    if (this.config.target.role === 'owned-ios-simulator'
        && this.config.sources?.participants?.some(source => source.kind === 'virtual-microphone')) {
      const custody = this.config.sources.inputCustody;
      if (!custody || !isAbsolute(custody.inventoryHelper ?? '') || !/^[a-f0-9]{64}$/.test(custody.helperSHA256 ?? '')
          || !isAbsolute(custody.expectedService?.executablePath ?? '')
          || !/^[a-f0-9]{64}$/.test(custody.expectedService?.executableSHA256 ?? '')
          || this.config.sources.participants.some(source => source.kind === 'virtual-microphone'
            && source.output?.deviceUID !== 'BlackHole2ch_UID')) throw Error('virtual_input_custody_configuration_required');
    }
    const caps = this.config.capabilities;
    if (Object.hasOwn(caps, SESSION_ATTEMPT_CAPABILITY)) throw Error('session_attempt_capability_reserved');
    if (caps['appium:noReset'] !== true || caps['appium:forceAppLaunch'] === true || caps['appium:fullReset'] === true
        || caps['appium:prerun'] !== undefined || caps['appium:postrun'] !== undefined
        || caps['appium:app'] !== undefined || (this.config.target.role === 'owned-ios-simulator'
      ? caps['appium:shouldTerminateApp'] !== false : caps['appium:skipAppKill'] !== true)) throw Error('app_retention_required');
  }
  async lockIdentity(scenario) {
    await this.loadConfig(scenario);
    this.targetFingerprint = (await nativeIdentity(this.config)).fingerprint;
    return this.targetFingerprint;
  }
  async doctor(scenario) {
    await this.loadConfig(scenario);
    const build = await verifyBuild(this.config, scenario);
    const lab = resolve(dirname(fileURLToPath(import.meta.url)), '../native/lab.py');
    const receipt = resolve(dirname(this.configPath), 'coordinator-doctor.json');
    let commandSucceeded = true;
    try { await exec('python3', [lab, 'doctor', this.configPath, '--output', receipt], { timeout: 30000, maxBuffer: 100000 }); }
    catch { commandSucceeded = false; }
    let native;
    try { native = JSON.parse(await readFile(receipt, 'utf8')); } catch { native = {}; }
    return { targetId: scenario.targetId, executionKind: 'live', ready: commandSucceeded && native.ready === true, native, build };
  }
  track(operation) {
    const pending = Promise.resolve().then(operation); this.pending.add(pending);
    pending.then(() => {}, () => {}).finally(() => this.pending.delete(pending));
    return pending;
  }
  request(path, method = 'GET', body, signal, { observerInstallation = false } = {}) {
    const active = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(30000)]);
    return this.track(async () => {
    active.throwIfAborted();
    // A lost reply cannot establish whether Appium/WDA executed the mutation.
    // Closing the session later does not undo or prove settlement of that work.
    const mutation = method === 'POST' && !['/element', '/elements', '/context', '/execute/sync'].includes(path);
    const command = mutation ? ++this.commandSequence : null;
    if (mutation) this.uncertainMutations.add(command);
    if (observerInstallation && this.observerInstallationUncertain) throw Error('observer_installation_unsettled');
    if (observerInstallation) this.observerInstallationUncertain = true;
    const response = await fetch(this.base + (this.session ? `/session/${this.session}` : '') + path, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: active });
    const data = await response.json();
    if (!response.ok || data.value?.error) throw Error('webdriver_request_failed');
    if (mutation) this.uncertainMutations.delete(command);
    if (observerInstallation) this.observerInstallationUncertain = false;
    return data.value;
    });
  }
  connect(scenario, { signal, output, recoveryOnly = false, preRecordRecovery = false } = {}) { return this.track(async () => {
    this.scenario = scenario;
    const active = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(SESSION_CREATION_TIMEOUT_MS)]);
    active.throwIfAborted();
    const c = this.config, simulator = c.target.role === 'owned-ios-simulator';
    const inventory = await fetch(`${this.base}/appium/sessions`, { signal: active });
    const sessions = await inventory.json();
    if (!inventory.ok || !Array.isArray(sessions.value)) throw Error('driver_inventory_unavailable');
    if (sessions.value.length) throw Error('existing_driver_session_unsettled');
    // Mac2 ignores the iOS no-launch capabilities and its session constructor
    // can activate the app or replace an existing driver. Recovery needs only
    // the verified passive inspector, so it must not create a Mac2 session.
    if (recoveryOnly && !simulator) {
      await this.attachDesktopObserver(scenario, active, true, preRecordRecovery);
      return;
    }
    if (!this.targetFingerprint) throw Error('session_target_identity_required');
    const capabilities = { ...c.capabilities, 'appium:bundleId': c.app.bundleId,
      ...(recoveryOnly ? { 'appium:autoLaunch': false, 'appium:forceAppLaunch': false } : {}),
      ...(simulator ? { 'appium:udid': c.target.udid } : { 'appium:appPath': c.app.path }) };
    this.creationAttempt = await createSessionAttempt({ output, scenario, base: this.base, capabilities,
      targetFingerprint: this.targetFingerprint });
    try { active.throwIfAborted(); }
    catch (error) { await sessionNotDispatched(this.creationAttempt); throw error; }
    this.sessionCreationUncertain = true;
    // Once dispatched, cancellation must not discard the eventual ownership
    // reply. Cleanup joins this tracked work; no further UI work follows abort.
    const response = await fetch(`${this.base}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilities: { alwaysMatch: this.creationAttempt.capabilities } }),
      signal: AbortSignal.timeout(SESSION_CREATION_TIMEOUT_MS) });
    const data = await response.json();
    if (!response.ok || data.value?.error) throw Error('webdriver_session_failed');
    const id = data.sessionId ?? data.value?.sessionId, returnedCaps = data.value?.capabilities;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id ?? '')
        || !sessionCapsMatch(returnedCaps, this.creationAttempt.receipt.capabilities)) throw Error('webdriver_session_ownership_unconfirmed');
    this.session = id;
    await sessionReturned(this.creationAttempt, id, returnedCaps);
    this.sessionCreationUncertain = false;
    active.throwIfAborted();
    if (!simulator) await this.attachDesktopObserver(scenario, active, recoveryOnly);
  }); }
  async attachDesktopObserver(scenario, signal, readOnly, allowMissing = false) {
    const debug = this.config.desktopInspector;
    if (!debug) throw Error('owned_desktop_inspector_required');
    const abortObserver = () => this.observerLifetime.abort();
    signal.addEventListener('abort', abortObserver, { once: true });
    if (signal.aborted) this.observerLifetime.abort();
    try {
      this.desktop = await createDesktopObserver({ config: this.config, scenario, ...debug, signal: this.observerLifetime.signal,
        readOnly, allowMissing: readOnly && allowMissing });
    } catch (error) { if (error.ownedResourcesSettled === false) this.observerCleanupUncertain = true; throw error; }
    finally { signal.removeEventListener('abort', abortObserver); }
  }
  webview(script, args = [], signal, observerInstallation = false) {
    const operation = this.webviewTail.then(async () => {
      const previous = await this.request('/context', 'GET', undefined, signal);
      const contexts = (await this.request('/contexts', 'GET', undefined, signal)).filter(item => item.startsWith('WEBVIEW'));
      if (contexts.length !== 1) throw Error('owned_webview_ambiguous');
      await this.request('/context', 'POST', { name: contexts[0] }, signal);
      try { return await this.request('/execute/sync', 'POST', { script, args }, signal, { observerInstallation }); }
      finally { await this.request('/context', 'POST', { name: previous }, signal); }
    });
    this.webviewTail = operation.catch(() => {});
    return operation;
  }
  async installObserver(signal) {
    if (!this.binding) throw Error('created_visit_binding_missing');
    if (this.desktop) return this.desktop.bindVisit(this.binding);
    const existing = await this.webview('return window.__scribeLabAdmissionObserver?.describe() ?? null;', [], signal);
    if (existing) {
      if (['runId', 'workspaceId', 'appointmentRef'].some(key => existing[key] !== this.binding[key])
          || existing.observerSHA256 !== IOS_OBSERVER_HASHES.admission) throw Error('admission_observer_binding_changed');
      return;
    }
    await this.webview(`return (${installAdmissionObserver.toString()})(arguments[0], (${projectNoteObservation.toString()}), arguments[1]);`, [this.binding, IOS_OBSERVER_HASHES.admission], signal, true);
  }
  async installVisitObserver(signal) {
    if (this.desktop) return;
    const expected = this.config.admissionBinding.runId;
    const existing = await this.webview('return window.__scribeLabVisitObserver?.describe() ?? null;', [], signal);
    if (existing) {
      if (existing.runId !== expected || existing.observerSHA256 !== IOS_OBSERVER_HASHES.visit) throw Error('visit_observer_binding_changed');
      return;
    }
    await this.webview(`return (${installVisitScopeObserver.toString()})(arguments[0]);`, [{ runId: expected, observerSHA256: IOS_OBSERVER_HASHES.visit }], signal, true);
  }
  async readAuth(signal) {
    const deadline = performance.now() + 10000;
    do {
      signal?.throwIfAborted();
      const value = this.desktop ? await this.desktop.readAuth()
        : await this.webview('return window.__scribeLabVisitObserver?.readAuth() ?? null;', [], signal);
      if (value) {
        const identitySHA256 = this.desktop ? value.identitySHA256
          : /^user_[A-Za-z0-9_]{1,250}$/.test(value.userId ?? '') ? sha256(value.userId) : null;
        if (value.source !== (this.desktop ? 'normal-desktop-auth-response' : 'normal-native-auth-response')
            || value.runId !== this.scenario.admissionBinding?.runId || value.phase !== 'ready'
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.revision ?? '')
            || !Number.isFinite(value.observedAtMonotonicMs) || !Number.isFinite(value.browserTimeOriginMs)
            || Math.abs(Date.now() - value.browserTimeOriginMs - value.observedAtMonotonicMs) > 15000
            || !/^[a-f0-9]{64}$/.test(identitySHA256 ?? '')) throw Error('native_auth_observation_invalid');
        if (identitySHA256 !== this.config.accountIdentitySHA256) throw Error('native_account_identity_mismatch');
        // The normal public user ID is hashed in memory and is never written to
        // an observation, screenshot name, journal or command output.
        return { source: value.source, runId: value.runId, phase: value.phase, revision: value.revision,
          identitySHA256, observedAtMonotonicMs: value.observedAtMonotonicMs, browserTimeOriginMs: value.browserTimeOriginMs };
      }
      await wait(200);
    } while (performance.now() < deadline);
    throw Error('normal_native_identity_not_observed');
  }
  async visitScope(created, signal) {
    const value = this.desktop ? await (created ? this.desktop.readCreated() : this.desktop.currentVisit())
      : await this.webview(created ? 'return window.__scribeLabVisitObserver?.readCreated() ?? null;'
        : 'return window.__scribeLabVisitObserver?.readCurrent() ?? null;', [], signal);
    if (!value || value.runId !== this.config.admissionBinding.runId
        || value.source !== (created ? 'normal-native-created-visit-response' : 'normal-native-mount-response')
        || !/^[0-9a-f-]{36}$/.test(value.workspaceId) || !/^appointment_[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(value.appointmentRef)
        || ['workspaceId', 'appointmentRef'].some(key => this.config.admissionBinding[key] && this.config.admissionBinding[key] !== value[key])) throw Error('current_visit_not_observed');
    return value;
  }
  async assertVisit(signal) {
    const current = await this.visitScope(false, signal);
    if (!this.binding || ['runId', 'workspaceId', 'appointmentRef'].some(key => current[key] !== this.binding[key])) throw Error('current_visit_binding_changed');
    return current;
  }
  async readAdmission(signal) {
    if (this.desktop) return this.desktop.readAdmission();
    return this.webview('return window.__scribeLabAdmissionObserver?.read() ?? null;', [], signal);
  }
  checkAdmission(receipt) {
    if (!receipt || receipt.source !== 'normal-native-admission-response' || !this.binding
        || ['runId', 'workspaceId', 'appointmentRef'].some(key => receipt[key] !== this.binding[key])
        || !/^[0-9a-f-]{36}$/.test(receipt.sessionId) || !/^[0-9a-f-]{36}$/.test(receipt.consentRecordId)
        || !Number.isFinite(receipt.observedAtMonotonicMs) || !Number.isFinite(receipt.browserTimeOriginMs)) throw Error('admission_not_observed');
    return receipt;
  }
  async readRecording(signal) {
    const result = this.desktop ? await this.desktop.readRecording()
      : await this.webview('return window.__scribeLabAdmissionObserver?.readRecording() ?? null;', [], signal);
    if (!result || result.source !== (this.desktop ? 'normal-desktop-recording-response' : 'normal-native-recording-response') || !this.admission
        || ['runId', 'workspaceId', 'appointmentRef', 'sessionId'].some(key => result[key] !== this.admission[key])
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.recorderId ?? '')
        || !Number.isSafeInteger(result.nativeRevision) || result.nativeRevision < 0
        || (this.desktop ? typeof result.pendingMutation !== 'boolean' : typeof result.busy !== 'boolean')
        || !Number.isFinite(result.observedAtMonotonicMs) || !Number.isFinite(result.browserTimeOriginMs)
        || Math.abs(Date.now() - result.browserTimeOriginMs - result.observedAtMonotonicMs) > 15000) throw Error('native_recording_state_unavailable');
    if (this.lastNativeRecording?.sessionId === result.sessionId
        && this.lastNativeRecording.recorderId !== result.recorderId) throw Error('native_recorder_identity_changed');
    if (this.lastNativeRecording?.sessionId === result.sessionId
        && this.lastNativeRecording.nativeRevision > result.nativeRevision) throw Error('native_recording_revision_regressed');
    this.lastNativeRecording = result;
    return result;
  }
  async assertFinishable(signal) {
    const current = await this.readRecording(signal);
    if (current.busy || current.pendingMutation || (this.desktop
      ? !(['recording', 'paused'].includes(current.captureState)
          && ['recording', 'stopped'].includes(current.phase))
      : !['recording', 'paused'].includes(current.phase))) throw Error('bound_recording_not_finishable');
    return current;
  }
  async readTerminal(signal) {
    const result = this.desktop ? await this.desktop.readTerminal()
      : await this.webview('return window.__scribeLabAdmissionObserver?.readTerminal() ?? null;', [], signal);
    if (!result || !this.admission
        || ['runId', 'workspaceId', 'appointmentRef', 'sessionId'].some(key => result[key] !== this.admission[key])
        || result.source !== (this.desktop ? 'normal-desktop-recording-response' : 'normal-native-recording-response')
        || !this.lastNativeRecording || result.recorderId !== this.lastNativeRecording.recorderId
        || result.busy || result.pendingMutation || !Number.isSafeInteger(result.nativeRevision)
        || !Number.isFinite(result.observedAtMonotonicMs) || !Number.isFinite(result.browserTimeOriginMs)
        || (this.desktop ? result.phase !== 'stopped' || !['uploading', 'processing', 'complete'].includes(result.captureState)
          : result.phase !== 'sealed')) throw Error('bound_terminal_state_not_observed');
    return result;
  }
  async readNote(action, signal) {
    const note = this.desktop ? await (action ? this.desktop.readNote(action) : this.desktop.readCurrentNote())
      : await this.webview(action ? 'return window.__scribeLabAdmissionObserver?.readNote(arguments[0]) ?? null;'
        : 'return window.__scribeLabAdmissionObserver?.readCurrentNote() ?? null;', [action], signal);
    if (!note || !this.admission || note.source !== 'normal-core-note-response' || action && note.action !== action
        || ['runId', 'workspaceId', 'appointmentRef'].some(key => note[key] !== this.binding[key])
        || note.session_id !== this.admission.sessionId || !/^[a-f0-9]{64}$/.test(note.note_sha256)
        || !Number.isFinite(note.observedAtMonotonicMs) || !Number.isFinite(note.browserTimeOriginMs)) throw Error('bound_note_response_not_observed');
    return note;
  }
  async restore(state, { observations, signal, output }) {
    this.output = await realpath(output);
    if (this.config.sources) {
      const resourceOwner = { runId: this.config.admissionBinding.runId, ownedRoot: resolve(this.output, 'participants') };
      const supplied = this.config.sources.resourceOwner;
      if (supplied && (supplied.runId !== resourceOwner.runId || supplied.ownedRoot !== resourceOwner.ownedRoot))
        throw Error('participant_owner_output_mismatch');
      this.sources = new SourceGroup({ ...this.config.sources, resourceOwner, target: this.config.target }, () => this.sourceObservation());
    }
    const created = observations.create_visit;
    if (created) this.binding = { runId: created.visitScope.runId, workspaceId: created.visitScope.workspaceId, appointmentRef: created.visitScope.appointmentRef };
    const consent = observations.consent;
    if (consent) this.admission = this.checkAdmission(consent.admission);
    this.lastNativeRecording = observations.record?.nativeObservation ?? null;
    this.initialMicrophoneObservation = observations.record?.nativeObservation ?? null;
    if (observations.finish) {
      this.terminal = observations.finish.nativeTerminal;
      if (!this.terminal || this.terminal.sessionId !== this.admission?.sessionId) throw Error('restored_terminal_binding_changed');
    }
    this.savedNote = observations.save?.savedNote ?? null;
    if (this.admission && !state.completed.includes('finish')) {
      const current = await this.readAdmission(signal);
      if (current) {
        this.checkAdmission(current);
        if (current.sessionId !== this.admission.sessionId || current.consentRecordId !== this.admission.consentRecordId) throw Error('restored_consent_changed');
      } else await this.readRecording(signal);
    }
    if (state.completed.includes('prepare') && !state.completed.includes('play_source') && this.sources) {
      if (state.completed.includes('record') || state.pending === 'play_source') throw Error('source_process_lost_requires_review');
      await this.sources.connect({ signal });
    }
  }
  async find(locator, signal) {
    if (!locator?.using || !locator?.value) throw Error('native_locator_missing');
    const matches = await this.request('/elements', 'POST', locator, signal);
    if (!Array.isArray(matches) || matches.length !== 1 || typeof matches[0][elementKey] !== 'string'
        || !matches[0][elementKey]) throw Error('native_locator_ambiguous_or_missing');
    return matches[0][elementKey];
  }
  async value(spec, signal) {
    const element = await this.find(spec.locator, signal);
    const displayed = await this.request(`/element/${element}/displayed`, 'GET', undefined, signal);
    if (spec.kind === 'visible') return displayed;
    if (!displayed) throw Error('element_not_visible');
    if (spec.kind === 'text') return this.request(`/element/${element}/text`, 'GET', undefined, signal);
    if (spec.kind === 'attribute' && /^[a-zA-Z][a-zA-Z0-9-]{0,60}$/.test(spec.attribute))
      return this.request(`/element/${element}/attribute/${spec.attribute}`, 'GET', undefined, signal);
    throw Error('unsupported_native_assertion');
  }
  async check(plan, signal) {
    if (!plan?.assertions?.length) throw Error('native_assertions_missing');
    const waitMs = plan.waitMs ?? 30000;
    if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 120000) throw Error('native_wait_deadline_invalid');
    const deadline = performance.now() + waitMs;
    do {
      const checks = [];
      try {
        for (const spec of plan.assertions) checks.push({ locator: JSON.stringify(spec.locator), kind: spec.kind,
          actual: await this.value(spec, signal), expected: spec.expected });
        if (checks.every(c => c.actual === c.expected)) return checks;
      } catch (error) { if (signal?.aborted) throw error; }
      await wait(200);
    } while (performance.now() < deadline && !signal?.aborted);
    throw Error('native_state_not_observed');
  }
  async observe(action, signal) {
    const plan = this.config.journey?.[action];
    let checks;
    try { checks = await this.check(plan, signal); }
    catch (error) { await this.capturePhaseArtifacts(action, signal); throw error; }
    // Capture before reading the fresh native proofs: diagnostic latency must
    // not turn an older native snapshot into the observation of this phase.
    const phaseArtifacts = await this.capturePhaseArtifacts(action, signal);
    const value = { origin: 'product-ui', executionKind: 'live', targetId: this.scenario.targetId,
      action, observedAtEpochMs: Date.now(), checks, phaseArtifacts };
    if (['sign_in', 'workspace', 'create_visit'].includes(action)) {
      value.nativeAuth = await this.readAuth(signal);
      checks.push({ locator: 'normal-native-account-identity', kind: 'attribute',
        actual: value.nativeAuth.identitySHA256, expected: this.config.accountIdentitySHA256 });
    }
    if (action === 'create_visit') {
      const scope = await this.visitScope(true, signal);
      this.binding = { runId: scope.runId, workspaceId: scope.workspaceId, appointmentRef: scope.appointmentRef };
      value.visitScope = scope;
      await this.assertVisit(signal);
    } else if (['prepare', 'consent', 'record', 'finish', 'review', 'save', 'reopen'].includes(action)) {
      value.visitScope = await this.assertVisit(signal);
      checks.push({ locator: 'normal-native-current-mount', kind: 'attribute', actual: value.visitScope.appointmentRef, expected: this.binding.appointmentRef });
    }
    if (action === 'consent') {
      this.admission = this.checkAdmission(await this.readAdmission(signal));
      value.admission = this.admission;
    }
    if (action === 'record') {
      const live = await this.sourceObservation(signal);
      Object.assign(value, { consentReceiptSHA256: sha256(JSON.stringify(this.admission)), elapsedSeconds: live.capture.elapsedSeconds,
        nativeState: live.capture.nativeState, nativeObservation: live.nativeObservation });
    }
    if (action === 'finish') value.nativeTerminal = this.terminal = await this.readTerminal(signal);
    if (['review', 'save', 'reopen'].includes(action)) {
      if (!this.terminal || this.terminal.sessionId !== this.admission?.sessionId) throw Error('bound_terminal_state_not_observed');
      // Read/prepare/save all return the real session-bound persisted Core tuple.
      let note;
      if (action === 'review') note = await this.readNote(null, signal);
      else note = await this.readNote(action === 'save' ? 'save' : 'read', signal);
      if (note.browserTimeOriginMs + note.observedAtMonotonicMs
          < this.terminal.browserTimeOriginMs + this.terminal.observedAtMonotonicMs) throw Error('note_response_precedes_capture_stop');
      if (action === 'reopen' && (!this.savedNote || ['session_id', 'note_ref', 'transcript_ref', 'note_sha256']
        .some(key => note[key] !== this.savedNote[key]) || note.requestNonce === this.savedNote.requestNonce)) throw Error('saved_note_reopen_mismatch');
      value.savedNote = note;
      if (action === 'save') this.savedNote = note;
    }
    value.observedAtEpochMs = Date.now();
    return value;
  }
  async capturePhaseArtifacts(action, signal) {
    const startedAtEpochMs = Date.now();
    const receipt = { source: 'native-ui-phase-artifacts', action, targetId: this.scenario?.targetId,
      startedAtEpochMs, artifacts: [], unavailable: [] };
    if (!/^[a-z][a-z_]{0,40}$/.test(action) || !this.output || !this.session) {
      return { ...receipt, collectionStatus: 'UNAVAILABLE', completedAtEpochMs: Date.now(),
        unavailable: [{ kind: 'collection', code: 'phase_artifact_target_unavailable' }] };
    }
    const prefix = `phase-${action}-${randomUUID()}`;
    const active = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(5000)]);
    const captures = await Promise.allSettled([
      { kind: 'screenshot', path: '/screenshot', extension: 'png' },
      { kind: 'accessibility-source', path: '/source', extension: 'xml' },
    ].map(async spec => {
      const value = await this.request(spec.path, 'GET', undefined, active);
      let bytes;
      if (spec.extension === 'png') {
        if (typeof value !== 'string' || value.length > 28000000 || value.length % 4 !== 0
            || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw Error('phase_screenshot_invalid');
        bytes = Buffer.from(value, 'base64');
        if (bytes.toString('base64') !== value || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
          throw Error('phase_screenshot_invalid');
      } else {
        if (typeof value !== 'string' || !value.trimStart().startsWith('<') || Buffer.byteLength(value) > 8000000)
          throw Error('phase_source_invalid');
        bytes = Buffer.from(value);
      }
      const capturedAtEpochMs = Date.now(), evidenceFile = `${prefix}.${spec.extension}`;
      await writeFile(resolve(this.output, evidenceFile), bytes, { mode: 0o600, flag: 'wx', signal: active });
      return { kind: spec.kind, evidenceFile, sha256: sha256(bytes), bytes: bytes.length, capturedAtEpochMs };
    }));
    for (const [index, result] of captures.entries()) {
      if (result.status === 'fulfilled') receipt.artifacts.push(result.value);
      else receipt.unavailable.push({ kind: index === 0 ? 'screenshot' : 'accessibility-source',
        code: active.aborted ? 'phase_artifact_capture_aborted' : 'phase_artifact_capture_unavailable' });
    }
    receipt.completedAtEpochMs = Date.now();
    receipt.collectionStatus = receipt.artifacts.length === 2 ? 'COMPLETE' : receipt.artifacts.length ? 'PARTIAL' : 'UNAVAILABLE';
    // A unique private sidecar survives a later assertion/proof failure. It is
    // diagnostics only and never substitutes for any product observation.
    const evidenceFile = `${prefix}.json`, bytes = Buffer.from(JSON.stringify(receipt));
    try {
      await writeFile(resolve(this.output, evidenceFile), bytes, { mode: 0o600, flag: 'wx', signal: AbortSignal.timeout(1000) });
      return { ...receipt, evidenceFile, sha256: sha256(bytes) };
    } catch {
      return { ...receipt, unavailable: [...receipt.unavailable, { kind: 'manifest', code: 'phase_artifact_manifest_unavailable' }] };
    }
  }
  async sourceObservation(signal) {
    const readers = this.config.sourceReaders;
    if (!this.admission || !readers?.state || !readers?.elapsed) throw Error('source_observers_missing');
    await this.assertVisit(signal);
    const nativeObservation = await this.readRecording(signal);
    const state = await this.value(readers.state, signal), elapsed = await this.value(readers.elapsed, signal), sessionId = nativeObservation.sessionId;
    const pieces = String(elapsed).trim().split(':').map(Number);
    if (state !== 'Recording' || nativeObservation.phase !== 'recording' || nativeObservation.busy || nativeObservation.pendingMutation
        || this.desktop && nativeObservation.captureState !== 'recording'
        || pieces.some(x => !Number.isFinite(x) || x < 0) || pieces.length < 2 || pieces.length > 3
        || pieces.slice(1).some(x => x >= 60)) throw Error('recording_not_observed');
    const elapsedSeconds = pieces.reduce((total, n) => total * 60 + n, 0);
    return { scope: 'product-ui', targetId: this.scenario.targetId, sessionId, observedAtEpochMs: Date.now(),
      consent: { sessionId, state: 'granted' }, nativeObservation,
      capture: { sessionId, state: nativeObservation.phase, nativeState: nativeObservation.phase, elapsedSeconds } };
  }
  async steps(plan, signal) {
    for (const step of plan?.actions ?? []) {
      if (signal?.aborted) throw Error('native_action_aborted');
      if (step.action === 'wait') { await this.check(step, signal); continue; }
      const element = await this.find(step.locator, signal);
      if (step.action === 'click') await this.request(`/element/${element}/click`, 'POST', {}, signal);
      else if (step.action === 'clear') await this.request(`/element/${element}/clear`, 'POST', {}, signal);
      else if (step.action === 'type') {
        const text = step.env ? process.env[step.env] : step.text;
        if (typeof text !== 'string') throw Error('input_value_missing');
        await this.request(`/element/${element}/value`, 'POST', { text }, signal);
      } else throw Error('unsupported_native_action');
    }
  }
  async perform(action, scenario, signal) {
    if (action === 'dashboard') {
      if (!this.output || !this.savedNote || !this.config.dashboard) throw Error('dashboard_configuration_incomplete');
      this.dashboardCleanupUncertain = true;
      const observation = await verifyDashboard({ config: this.config.dashboard, scenario,
        savedReceipt: this.savedNote, output: resolve(this.output, 'dashboard'), signal });
      this.dashboardCleanupUncertain = observation.cleanup?.ownedResourcesSettled !== true;
      return observation;
    }
    if (['prepare', 'consent', 'record', 'play_source', 'finish', 'review', 'save'].includes(action)) await this.assertVisit(signal);
    if (action === 'play_source') {
      if (!this.sources) throw Error('sources_not_configured');
      if (!this.sources.participants.length) throw Error('prepared_sources_missing');
      let result, sourceFailure;
      try {
        await this.startInputWatch(signal);
        if (this.inputWatchUnsafe) throw Error('virtual_input_scope_unconfirmed');
        result = await this.sources.play({ signal, quietWindow: this.config.sources.quietWindow,
          pause: async () => { await this.steps(this.config.journey.pause, signal); await this.check(this.config.journey.pause, signal); },
          resume: async () => { await this.steps(this.config.journey.resume, signal); await this.check(this.config.journey.resume, signal); } });
      } catch (error) { sourceFailure = error; }
      try { await this.stopInputWatch(); } catch (error) { sourceFailure ??= error; }
      if (sourceFailure) throw sourceFailure;
      if (this.inputWatchUnsafe) throw Error('virtual_input_scope_changed');
      if (result.executionKind !== 'live') throw Error('live_sources_required');
      const observed = await this.observe('record', signal);
      this.assertMicrophoneSignal(observed.nativeObservation, 'completed');
      const fixtureSHA256 = result.measurements.length === 1 ? result.measurements[0].fixtureSHA256
        : sha256(JSON.stringify(result.measurements.map(m => m.fixtureSHA256)));
      return { ...observed, action, fixtureSHA256, sourceState: result.sourceState,
        completedSourceFrames: result.measurements.reduce((sum, m) => sum + m.framesCompleted, 0),
        checks: [...observed.checks, { locator: 'owned-source-graph', kind: 'audio-clock', actual: result.sourceState, expected: 'ended' }],
        sourceMeasurements: result.measurements, sourceTiming: { phases: result.phases, onsetToleranceMs: result.onsetToleranceMs,
          timingScope: result.timingScope, captureTiming: result.captureTiming },
        ...(this.inputWatchSummary ? { inputScope: this.inputWatchSummary } : {}) };
    }
    if (['sign_in', 'create_visit'].includes(action)) await this.installVisitObserver(signal);
    if (action === 'create_visit') await this.readAuth(signal);
    if (action === 'prepare') await this.installObserver(signal);
    // Verify the actual recorder immediately before the final UI mutation;
    // a same-visit replacement session must never receive this run's Finish.
    if (action === 'finish') await this.assertFinishable(signal);
    if (action === 'save') await this.readNote(null, signal);
    await this.steps(this.config.journey?.[action], signal);
    if (action === 'prepare' && this.sources) await this.sources.connect({ signal });
    const observed = await this.observe(action, signal);
    if (action === 'record') this.assertMicrophoneSignal(observed.nativeObservation, 'initial');
    return observed;
  }
  async startInputWatch(signal) {
    if (this.config.target?.role !== 'owned-ios-simulator'
        || !this.config.sources?.participants?.some(source => source.kind === 'virtual-microphone')) return;
    if (!this.output || !this.config.sources.inputCustody || this.inputWatch) throw Error('virtual_input_custody_configuration_required');
    this.inputWatch = await startHALWatch({ signal,
      inspect: signal => inspectHALScope({ ...this.config.sources.inputCustody, target: this.config.target,
        signal, requireOwnedInput: true }),
      onUnsafe: async receipt => {
        this.inputWatchUnsafe = true;
        if (!this.inputWatchUnsafeReceipt) {
          this.inputWatchUnsafeReceipt = receipt;
          await atomicJSON(resolve(this.output, 'hal-input-unsafe.json'), receipt);
          this.inputWatchUnsafeEvidence = { evidenceFile: 'hal-input-unsafe.json', sha256: sha256(JSON.stringify(receipt)) };
        }
        // Close only the source group created by this coordinator. Never send
        // a stop, route change or signal to the newly observed foreign reader.
        try {
          const closed = await this.sources.cleanup();
          if (closed.ownedResourcesSettled !== true) throw Error('source_cleanup_unconfirmed');
        } catch (error) { this.inputWatchCleanupUncertain = true; throw error; }
      } });
  }
  async stopInputWatch() {
    if (!this.inputWatch) return;
    this.inputWatchStop ??= (async () => {
      const cleanup = await this.inputWatch.stop();
      const receipt = { source: 'sampled-hal-input-custody', samples: this.inputWatch.samples,
        ...(this.inputWatchUnsafeReceipt ? { unsafe: this.inputWatchUnsafeReceipt } : {}), cleanup };
      await atomicJSON(resolve(this.output, 'hal-input-scope.json'), receipt);
      this.inputWatchSummary = { evidenceFile: 'hal-input-scope.json', sha256: sha256(JSON.stringify(receipt)),
        samples: receipt.samples.length, status: cleanup.status, scope: 'sampled-hal-input-clients-and-simulator-routes',
        screenCaptureKitAbsence: 'NOT_ESTABLISHED', futureReaderExclusion: 'NOT_ESTABLISHED' };
      if (cleanup.ownedResourcesSettled !== true) { this.inputWatchCleanupUncertain = true; throw Error('input_watch_cleanup_unconfirmed'); }
      if (cleanup.status === 'BLOCKED') this.inputWatchUnsafe = true;
    })();
    return this.inputWatchStop;
  }
  assertMicrophoneSignal(native, phase) {
    if (this.config.target?.role !== 'owned-ios-simulator'
        || !this.config.sources?.participants?.some(source => source.kind === 'virtual-microphone')) return;
    const signal = native?.signal;
    if (signal?.version !== 2 || !Number.isSafeInteger(native.capturedAudioFrames) || native.capturedAudioFrames <= 0
        || !Number.isSafeInteger(signal.inputBuffers) || signal.inputBuffers <= 0
        || !Number.isSafeInteger(signal.convertedBuffers) || signal.convertedBuffers <= 0
        || signal.inputMuted !== false) throw Error('native_microphone_signal_unavailable');
    if (phase === 'initial') {
      if (signal.inputEverNonzero !== false || signal.convertedEverNonzero !== false
          || signal.inputLevel !== 0 || signal.convertedLevel !== 0) throw Error('native_microphone_initial_silence_missing');
      this.initialMicrophoneObservation = structuredClone(native);
    } else {
      const initial = this.initialMicrophoneObservation;
      if (!initial || initial.sessionId !== native.sessionId || initial.recorderId !== native.recorderId
          || signal.inputEverNonzero !== true || signal.convertedEverNonzero !== true
          || native.capturedAudioFrames <= initial.capturedAudioFrames
          || signal.inputBuffers <= initial.signal.inputBuffers || signal.convertedBuffers <= initial.signal.convertedBuffers)
        throw Error('native_microphone_signal_progress_missing');
    }
  }
  async reconcile(action, scenario, { signal } = {}) {
    if (action === 'dashboard') return this.perform(action, scenario, signal);
    // Playback cannot be replayed after losing its process. Preserve the capture
    // for inspection and require a separately named run for new source audio.
    if (action === 'play_source') throw Error('source_process_lost_requires_review');
    if (['prepare', 'consent', 'record', 'finish', 'review', 'save', 'reopen'].includes(action)) await this.assertVisit(signal);
    if (action === 'record' && !this.admission) throw Error('consent_observation_requires_recovery');
    const observation = await this.observe(action, signal);
    if (action === 'prepare' && this.sources) await this.sources.connect({ signal });
    return observation;
  }
  async failureArtifact(path) {
    if (!this.session) return;
    try { const screenshot = await this.request('/screenshot'); await writeFile(`${path}.png`, Buffer.from(screenshot, 'base64'), { mode: 0o600 }); }
    catch { /* An unavailable screenshot never changes a failed gate. */ }
  }
  async captureStateSnapshot(signal, { preRecord = false } = {}) {
    let snapshot;
    if (this.desktop) snapshot = await this.desktop.recoverySnapshot();
    else snapshot = await this.webview(`
      const visit = window.__scribeLabVisitObserver, admission = window.__scribeLabAdmissionObserver;
      if ((!visit || !admission) && !arguments[0]) return null;
      return { visitDescriptor: visit?.describe() ?? null, descriptor: admission?.describe() ?? null,
        currentVisit: visit?.readCurrent() ?? null, nativeObservation: admission?.readRecording() ?? null,
        currentNote: admission?.readCurrentNote() ?? null, closedLifecycle: admission?.readClosed() ?? null };`, [preRecord], signal);
    if (!snapshot || !Object.hasOwn(snapshot, 'descriptor') || !Object.hasOwn(snapshot, 'currentVisit')
        || !Object.hasOwn(snapshot, 'nativeObservation')) throw Error('recovery_observer_missing_or_changed');
    const observers = this.desktop ? { visit: null, admission: null, desktop: snapshot.descriptor }
      : { visit: snapshot.visitDescriptor, admission: snapshot.descriptor, desktop: null };
    let pending = 0;
    for (const [kind, descriptor] of Object.entries(observers)) {
      if (descriptor === null) {
        if (!preRecord && (this.desktop ? kind === 'desktop' : kind !== 'desktop')) throw Error('recovery_observer_missing_or_changed');
        continue;
      }
      if (!descriptor || descriptor.runId !== this.scenario.admissionBinding.runId
          || !/^[a-f0-9]{64}$/.test(descriptor.observerSHA256 ?? '')
          || kind !== 'desktop' && descriptor.observerSHA256 !== IOS_OBSERVER_HASHES[kind]
          || kind === 'desktop' && descriptor.observerSHA256 !== this.desktop.observerSHA256
          || !Number.isSafeInteger(descriptor.pendingObservedReplies) || descriptor.pendingObservedReplies < 0)
        throw Error('recovery_observer_missing_or_changed');
      pending += descriptor.pendingObservedReplies;
    }
    return { ...snapshot, observers, observerPendingReplies: pending };
  }
  async recoveryInspect({ scenario, state, observations = {}, signal, output, recoveryAuthority }) {
    // Rediscover current driver sessions. An old ID in a file never grants
    // ownership, and a pre-existing live driver remains untouched.
    const inventory = async active => {
      const response = await fetch(`${this.base}/appium/sessions`, { signal: AbortSignal.any([active, AbortSignal.timeout(10000)]) });
      const sessions = await response.json();
      if (!response.ok || !Array.isArray(sessions.value)) throw Error('recovery_driver_inventory_unavailable');
      return sessions.value;
    };
    this.recoveredSessionCreations = await recoverSessionCreations({ output, scenario, base: this.base,
      targetFingerprint: this.targetFingerprint, authority: recoveryAuthority, inventory, signal,
      close: async (id, active) => {
        const response = await fetch(`${this.base}/session/${id}`, { method: 'DELETE', signal: AbortSignal.any([active, AbortSignal.timeout(30000)]) });
        const data = await response.json(); return response.ok && !data.value?.error;
      } });
    if ((await inventory(signal)).length) throw Error('recovery_existing_driver_session_unsettled');
    const stage = recoveryStage(state, observations);
    await this.connect(scenario, { signal, output, recoveryOnly: true, preRecordRecovery: stage === 'pre-record' });
    const snapshot = await this.captureStateSnapshot(signal, { preRecord: stage === 'pre-record' });
    // A fresh process inventory corroborates the durable launch ownership
    // markers; the new adapter's empty source list is never used as proof.
    const sourcesMayExist = this.config.sources && (state.completed.includes('prepare') || state.pending === 'prepare');
    let participantInventory;
    if (sourcesMayExist) {
      if (!output) throw Error('recovery_output_missing');
      participantInventory = await inspectParticipantResources({ ownedRoot: resolve(await realpath(output), 'participants'),
        runId: scenario.admissionBinding.runId, signal });
    }
    const unresolvedOwnedResources = participantInventory?.unresolvedOwnedResources ?? [];
    return { source: 'current-native-recovery-observation', executionKind: 'live', runId: scenario.runId,
      recoveryStage: stage, observers: snapshot.observers,
      targetId: scenario.targetId, observedAtEpochMs: Date.now(), currentVisit: snapshot.currentVisit,
      nativeObservation: snapshot.nativeObservation, currentNote: snapshot.currentNote,
      closedLifecycle: snapshot.closedLifecycle,
      observerPendingReplies: snapshot.observerPendingReplies, unresolvedOwnedResources,
      recoveredSessionCreations: this.recoveredSessionCreations,
      ...(participantInventory ? { participantInventory } : {}) };
  }
  recoveryCleanup({ preserveForRecovery = true } = {}) { return this.cleanup({ preserveForRecovery }); }
  async cleanupIOSObservers(preserveForRecovery) {
    if (this.config?.target?.role !== 'owned-ios-simulator' || !this.session) return null;
    const request = async (path, method = 'GET', body) => {
      const response = await fetch(`${this.base}/session/${this.session}${path}`, { method,
        headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok || result.value?.error) throw Error('observer_cleanup_request_failed');
      return result.value;
    };
    let previous;
    try {
      previous = await request('/context');
      const contexts = (await request('/contexts')).filter(value => value.startsWith('WEBVIEW'));
      if (contexts.length !== 1) throw Error('observer_cleanup_webview_ambiguous');
      await request('/context', 'POST', { name: contexts[0] });
      return await request('/execute/sync', 'POST', { args: [this.config.admissionBinding.runId, preserveForRecovery, IOS_OBSERVER_HASHES], script: `
        const [runId, preserve, hashes] = arguments;
        const admission = window.__scribeLabAdmissionObserver, visit = window.__scribeLabVisitObserver;
        if ([admission, visit].some(observer => observer && observer.describe().runId !== runId))
          return { ownedResourcesSettled: false, observerRemoved: false };
        if (admission && (admission.describe().observerSHA256 !== hashes.admission || admission.describe().pendingObservedReplies !== 0)
            || visit && (visit.describe().observerSHA256 !== hashes.visit || visit.describe().pendingObservedReplies !== 0))
          return { ownedResourcesSettled: false, observerRemoved: false };
        if (preserve) return { ownedResourcesSettled: true, observerRetainedForRecovery: Boolean(admission || visit) };
        // Admission wraps the visit observer: remove in reverse installation order.
        if (admission && admission.uninstall()?.ownedResourcesSettled !== true)
          return { ownedResourcesSettled: false, observerRemoved: false };
        if (visit && visit.uninstall()?.ownedResourcesSettled !== true)
          return { ownedResourcesSettled: false, observerRemoved: false };
        return { ownedResourcesSettled: !window.__scribeLabAdmissionObserver && !window.__scribeLabVisitObserver,
          observerRemoved: true };` });
    } catch { return { ownedResourcesSettled: false, observerRemoved: false }; }
    finally {
      if (previous) try { await request('/context', 'POST', { name: previous }); } catch { this.observerCleanupUncertain = true; }
    }
  }
  async cleanup({ preserveForRecovery = false, captureProofAtOrAfterEpochMs, captureMayBeActive = false } = {}) {
    let nativeCaptureProof = this.cleanupNativeCaptureProof;
    if ((this.session || this.desktop) && Number.isFinite(captureProofAtOrAfterEpochMs) && !this.lifetime.signal.aborted) {
      try {
        const snapshot = await this.captureStateSnapshot(AbortSignal.timeout(10000));
        nativeCaptureProof = { source: 'current-native-cleanup-observation', executionKind: 'live',
          runId: this.scenario.runId, targetId: this.scenario.targetId, observedAtEpochMs: Date.now(),
          currentVisit: snapshot.currentVisit, nativeObservation: snapshot.nativeObservation,
          closedLifecycle: snapshot.closedLifecycle, observers: snapshot.observers,
          observerPendingReplies: snapshot.observerPendingReplies };
        this.cleanupNativeCaptureProof = nativeCaptureProof;
      } catch { /* Missing current native evidence retains capture quarantine. */ }
    }
    if (captureMayBeActive) {
      const freshStopped = validNativeCleanupProof(nativeCaptureProof, { scenario: this.scenario,
        observations: { consent: { admission: this.admission }, record: { nativeObservation: this.lastNativeRecording },
          finish: { nativeTerminal: this.terminal } }, captureProofAtOrAfterEpochMs });
      if (!freshStopped || this.pending.size !== 0 || this.uncertainMutations.size !== 0) preserveForRecovery = true;
    }
    this.lifetime.abort();
    const sourceCleanup = this.sources?.cleanup();
    // Session creation can settle after cancellation. Drain it before deciding
    // whether a session exists; a transport-lost creation retains quarantine.
    await Promise.allSettled([...this.pending, this.webviewTail]);
    const source = await sourceCleanup;
    try { await this.stopInputWatch(); } catch { this.inputWatchCleanupUncertain = true; }
    const observer = this.desktop ? await this.desktop.close({ preserveForRecovery }) : await this.cleanupIOSObservers(preserveForRecovery);
    if (observer?.ownedResourcesSettled) this.desktop = null;
    let closed = !this.session && !this.sessionCreationUncertain;
    if (this.session) {
      try {
        const response = await fetch(`${this.base}/session/${this.session}`, { method: 'DELETE', signal: AbortSignal.timeout(30000) });
        const data = await response.json();
        closed = response.ok && !data.value?.error;
        if (closed && this.creationAttempt) {
          const inventory = await fetch(`${this.base}/appium/sessions`, { signal: AbortSignal.timeout(10000) });
          const fresh = await inventory.json();
          if (!inventory.ok || !Array.isArray(fresh.value) || fresh.value.some(item => item.id === this.session
            || item.capabilities?.[SESSION_ATTEMPT_CAPABILITY] === this.creationAttempt.receipt.attemptId)) throw Error('session_cleanup_unconfirmed');
          await sessionClosed(this.creationAttempt, this.session, { source: 'owned-delete-response-and-fresh-inventory',
            deleteAcknowledged: true, freshInventoryAbsent: true, nativeAppTerminationRequested: false });
          this.sessionCreationUncertain = false;
        }
        if (closed) this.session = null;
      } catch { closed = false; /* Unconfirmed driver shutdown retains the target lease. */ }
    }
    return { source: source ?? { syntheticParticipantsClosed: true, ownedResourcesSettled: true }, observer, appiumSessionClosed: closed,
      ...(nativeCaptureProof ? { nativeCaptureProof } : {}),
      uncertainNativeMutationCount: this.uncertainMutations.size,
      observerInstallationUncertain: this.observerInstallationUncertain === true,
      ...(this.inputWatchSummary ? { inputScope: this.inputWatchSummary } : {}),
      ...(this.inputWatchUnsafeEvidence ? { inputUnsafeEvidence: this.inputWatchUnsafeEvidence } : {}),
      ownedResourcesSettled: closed && this.pending.size === 0 && this.uncertainMutations.size === 0 && !this.observerInstallationUncertain && !this.observerCleanupUncertain && !this.dashboardCleanupUncertain && !this.inputWatchCleanupUncertain
        && (!source || source.ownedResourcesSettled === true) && (!observer || observer.ownedResourcesSettled === true),
      nativeAppTerminated: false, nativeCaptureState: 'requires-product-state-inspection' };
  }
}
