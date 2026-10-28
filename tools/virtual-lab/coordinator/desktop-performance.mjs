import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { realpath, stat } from 'node:fs/promises';
import { dirname, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { observeUIActionCalls, retainNativePerformanceEvidence } from './native-performance.mjs';
import { AppiumUI } from './appium-ui.mjs';
import { isOwnedDesktopObserver } from './desktop-observer.mjs';
import { sha256 } from './journal.mjs';
import { publishExclusiveJSON } from './guard.mjs';

// User target frozen before the first trial. The engine's existing provisional
// recordReadyMs=3000 is unchanged and includes its separately reported work.
export const DESKTOP_RECORD_TARGET_MS = 5000;
const CAP_MS = 10000, MAX_SAMPLES = 200;
const ns = () => process.hrtime.bigint().toString();
const need = (value, code) => { if (!value) throw Error(`desktop_performance_${code}`); };
const numberNs = value => { need(typeof value === 'string' && /^[0-9]{1,24}$/.test(value), 'clock_invalid'); return BigInt(value); };
const same = (a, b, keys) => keys.every(key => a?.[key] === b?.[key]);
const scopeKeys = ['runId', 'workspaceId', 'appointmentRef', 'sessionId'];
const identityKeys = ['runId', 'pid', 'executablePath', 'appPath', 'profile', 'hostname'];
const failureEvents = ['audio_start_timeout', 'audio_failed', 'audio_packet_invalid', 'audio_chunk_commit_failed',
  'audio_permission_required', 'audio_device_changed', 'audio_session_locked', 'audio_clock_discontinuity', 'audio_overflow'];

function initialReady(first) {
  const initial = first?.recording, admission = first?.admission;
  need(initial?.source === 'normal-desktop-recording-response' && initial.phase === 'ready' && initial.captureState === 'ready'
    && initial.pendingMutation === false && initial.elapsedSeconds === 0 && initial.recordedChunks === 0 && initial.queuedChunks === 0,
  'initial_ready_zero_required');
  need(admission?.source === 'normal-native-admission-response' && same(initial, admission, scopeKeys)
    && initial.revision === admission.revision && typeof admission.consentRecordId === 'string', 'admission_unconfirmed');
}

function checkedSample(sample, initial) {
  const value = sample.value;
  need(value?.source === 'owned-desktop-performance-snapshot' && same(value, initial, identityKeys), 'owner_changed');
  const before = numberNs(sample.invokedNs), after = numberNs(sample.returnedNs), main = numberNs(value.mainMonotonicNs);
  need(after >= before, 'clock_regressed');
  need(JSON.stringify(value.admission) === JSON.stringify(initial.admission), 'admission_changed');
  need(value.auth?.source === 'normal-desktop-auth-response' && value.auth.phase === 'ready'
    && same(value.auth, initial.auth, ['runId', 'revision', 'identitySHA256']), 'auth_changed');
  need(value.diagnostics?.file === 'runtime-diagnostics-v1.jsonl'
    && same(value.diagnostics, initial.diagnostics, ['device', 'inode'])
    && Array.isArray(value.diagnostics.events) && value.diagnostics.events.length <= 512, 'diagnostic_owner_changed');
  for (const row of value.diagnostics.events) {
    need(row.pid === value.pid && Number.isSafeInteger(row.capture_attempt) && row.capture_attempt >= 0, 'event_scope_invalid');
    need(numberNs(row.monotonic_ns) <= main, 'event_from_future');
  }
  if (value.recording) need(value.recording.source === 'normal-desktop-recording-response'
    && typeof value.recording.pendingMutation === 'boolean' && same(value.recording, initial.recording, [...scopeKeys, 'recorderId'])
    && value.recording.revision === initial.admission.revision
    && Number.isSafeInteger(value.recording.nativeRevision) && value.recording.nativeRevision >= initial.recording.nativeRevision,
  'recording_scope_changed');
  return { offsetLower: main - after, offsetUpper: main - before, before, after, main };
}

/** Pure consistency analysis, never a live authority or capture grant. A bound
 * >=1 second counter proves at least16000 accepted converted PCM16 frames by
 * the read's return. The exact first native/converted buffer time is unavailable. */
export function analyzeDesktopRecordPerformance({ samples, timeline }) {
  need(Array.isArray(samples) && samples.length >= 2 && samples.length <= MAX_SAMPLES, 'sample_count_invalid');
  const first = samples[0].value, initial = first?.recording, admission = first?.admission;
  initialReady(first);
  need(timeline?.status === 'OBSERVED' && timeline.action === 'record' && timeline.assertionAction === 'record'
    && timeline.commands?.length === 1 && timeline.commands[0].kind === 'click'
    && timeline.commands[0].status === 'FULFILLED' && timeline.checks?.length === 1
    && timeline.checks[0].status === 'FULFILLED', 'normal_click_or_visible_state_unconfirmed');
  const click = timeline.commands[0], start = numberNs(click.invokedNs), ack = numberNs(click.settledNs);
  const visible = numberNs(timeline.checks[0].settledNs);
  need(ack >= start && visible >= start && numberNs(samples[0].returnedNs) <= start, 'action_order_invalid');
  let lower, upper, previous = -1n;
  for (const sample of samples) {
    const s = checkedSample(sample, first);
    need(s.before >= previous, 'samples_out_of_order'); previous = s.after;
    lower = lower === undefined || s.offsetLower > lower ? s.offsetLower : lower;
    upper = upper === undefined || s.offsetUpper < upper ? s.offsetUpper : upper;
  }
  need(lower <= upper, 'clock_mapping_inconsistent');
  const last = samples.at(-1).value, baseline = first.diagnostics.events;
  need(baseline.length > 0 && last.diagnostics.events.some(row => JSON.stringify(row) === JSON.stringify(baseline.at(-1))), 'baseline_anchor_lost');
  const attempt = Math.max(...baseline.map(row => row.capture_attempt)) + 1;
  const events = last.diagnostics.events.filter(row => row.capture_attempt === attempt);
  need(last.diagnostics.events.every(row => row.capture_attempt <= attempt), 'another_capture_attempt_observed');
  const starts = events.filter(row => row.event === 'audio_start_pending'), ready = events.filter(row => row.event === 'audio_ready');
  need(starts.length === 1 && ready.length === 1 && !events.some(row => failureEvents.includes(row.event)), 'native_ready_unconfirmed');
  need(numberNs(starts[0].monotonic_ns) - upper >= start && numberNs(ready[0].monotonic_ns) >= numberNs(starts[0].monotonic_ns), 'native_attempt_precedes_input');
  const accepted = samples.slice(1).find(sample => sample.value.pendingObservedReplies === 0
    && sample.value.recording?.pendingMutation === false
    && sample.value.recording?.phase === 'recording' && sample.value.recording.captureState === 'recording'
    && Number.isSafeInteger(sample.value.recording.elapsedSeconds) && sample.value.recording.elapsedSeconds >= 1
    && sample.value.recording.nativeRevision > initial.nativeRevision);
  need(accepted, 'accepted_converted_audio_not_observed');
  const readyUpperNs = numberNs(ready[0].monotonic_ns) - lower;
  const acceptedUpperNs = numberNs(accepted.returnedNs);
  need(acceptedUpperNs >= readyUpperNs && visible <= previous, 'readiness_order_invalid');
  const ms = value => Number(value - start) / 1e6;
  const nativeReady = Math.max(ms(readyUpperNs), ms(acceptedUpperNs)), visibleMs = ms(visible);
  const opened = baseline.filter(row => row.event === 'host_open'), window = baseline.filter(row => row.event === 'window_ready');
  const startupMs = opened.length === 1 && window.length === 1
    && numberNs(window[0].monotonic_ns) >= numberNs(opened[0].monotonic_ns)
    ? Number(numberNs(window[0].monotonic_ns) - numberNs(opened[0].monotonic_ns)) / 1e6 : null;
  return { schema: 1, source: 'desktop-record-readiness-analysis', status: 'EVIDENCE_CONSISTENT',
    runId: first.runId, sessionId: admission.sessionId, consentRecordId: admission.consentRecordId,
    recorderId: initial.recorderId, pid: first.pid, captureAttempt: attempt,
    startBoundary: 'RAW_ADAPTER_INVOCATION_NOT_PHYSICAL_TOUCH',
    clickAcknowledgedMs: ms(ack), nativeReadyAcknowledgmentUpperMs: ms(readyUpperNs),
    acceptedConvertedAudioUpperMs: ms(acceptedUpperNs), acceptedFramesLowerBound: accepted.value.recording.elapsedSeconds * 16000,
    nativeReadyUpperMs: nativeReady, visibleRecordingUpperMs: visibleMs,
    nativeReadyUnder5Seconds: nativeReady < DESKTOP_RECORD_TARGET_MS,
    visibleRecordingUnder5Seconds: visibleMs < DESKTOP_RECORD_TARGET_MS,
    userTargetMs: DESKTOP_RECORD_TARGET_MS, existingEngineRecordReadyMs: 3000,
    engineBudgetChanged: false, enginePhaseIncludesCheckpointWait: true,
    processHostOpenToWindowReadyMs: startupMs, coldOrWarmLaunchQualification: 'REQUIRES_SEPARATE_OBSERVED_LAUNCH_DISPATCH',
    preparationDurationDiagnostics: baseline.filter(row => ['provider_consent_to_ready', 'provider_recorder_prepare'].includes(row.event)),
    exactFirstNativeBufferTimestamp: 'UNAVAILABLE', exactFirstConvertedBufferTimestamp: 'UNAVAILABLE',
    nonzeroMarkerAndSavedAudio: 'REQUIRES_SEPARATE_SOURCE_AND_PERSISTENCE_PROOF',
    clockOffsetNs: { lower: lower.toString(), upper: upper.toString() },
    nativeReadyEvent: ready[0], rendererDurationDiagnostic: events.filter(row => row.event === 'provider_record_to_native_ready') };
}

/** Retain the full normal setup/action interval on the controller's monotonic
 * clock. It is not a physical-input or cold-launch measurement. No result body,
 * identity claims or credentials are copied into this metadata artifact. */
export async function observeDesktopPhase({ ui, phase, output, invoke }) {
  need(ui instanceof AppiumUI && ['connect', 'sign_in', 'workspace', 'create_visit', 'prepare', 'consent'].includes(phase)
    && typeof invoke === 'function' && await realpath(output) === output, 'phase_contract_invalid');
  const directory = await stat(output);
  need(directory.isDirectory() && directory.uid === process.getuid() && !(directory.mode & 0o077), 'private_output_required');
  const invokedNs = ns(); let result, failed = false, error;
  try { result = await invoke(); } catch (value) { failed = true; error = value; }
  const settledNs = ns(), receipt = { schema: 1, source: 'normal-desktop-phase-interval', phase,
    status: failed ? 'REJECTED' : 'FULFILLED', invokedNs, settledNs,
    elapsedMs: Number(BigInt(settledNs) - BigInt(invokedNs)) / 1e6,
    processIdentity: ui.desktop?.identity ?? null, authority: 'NONE',
    boundary: 'MAINTAINED_ADAPTER_CALL', includesSetupAndProof: true,
    coldOrWarmLaunchQualification: 'NOT_ESTABLISHED_BY_PHASE_INTERVAL' };
  try { await publishExclusiveJSON(resolve(output, `desktop-phase-${phase}-${randomUUID()}.json`), receipt); }
  catch (value) { if (!failed) throw value; }
  if (failed) throw error;
  return result;
}

/** Observe one normal adapter invocation in the maintained coordinator. The
 * callback must be the already-authorized ordinary perform(record). This helper
 * neither creates a command nor restarts/retries it. Scope/source waits precede
 * entry, and runJourney retains its full phase interval separately. */
export async function collectDesktopRecordPerformance({ ui, invoke, profileDirectory, evidencePath, signal }) {
  need(signal instanceof AbortSignal, 'signal_required'); signal.throwIfAborted();
  need(ui instanceof AppiumUI && isOwnedDesktopObserver(ui.desktop) && ui.desktop.readPerformance && typeof invoke === 'function'
    && ['owned-macos-lab', 'owned-macos-guest'].includes(ui.config?.target?.role)
    && ui.config.target.hostname === hostname() && ui.session
    && ['rawRequest', 'check', 'find', 'readRecording', 'steps', 'observe'].every(key => ui[key] === AppiumUI.prototype[key])
    && !ui.pending.size && !ui.uncertainMutations.size && !ui.inputSafetyUncertain, 'normal_owned_adapter_required');
  need(typeof evidencePath === 'string' && resolve(evidencePath) === evidencePath && dirname(evidencePath) === ui.output
    && /^performance-record-[a-f0-9-]{36}\.json$/.test(basename(evidencePath)) && await realpath(ui.output) === ui.output,
  'evidence_path_invalid');
  const output = await stat(ui.output);
  need(output.isDirectory() && output.uid === process.getuid() && !(output.mode & 0o077), 'private_output_required');
  const samples = [], sample = async () => {
    const invokedNs = ns(), value = await ui.desktop.readPerformance(), returnedNs = ns();
    need(samples.length < MAX_SAMPLES, 'sample_limit');
    need(value.profile === profileDirectory && value.pid === ui.desktop.identity.pid
      && value.executablePath === ui.desktop.identity.executablePath
      && value.appPath === ui.desktop.identity.appPath && value.hostname === hostname()
      && value.runId === ui.scenario.admissionBinding.runId, 'live_owner_changed');
    // Preserve initial/final events and every intermediate file identity/hash.
    // Do not duplicate a64KiB diagnostic history in each of200 samples.
    if (samples.length > 1) samples.at(-1).value.diagnostics.events = [];
    const result = { invokedNs, returnedNs, value }; samples.push(result); return result;
  };
  const started = performance.now(), initial = (await sample()).value; initialReady(initial); signal.throwIfAborted();
  const age = Date.now() - initial.auth?.browserTimeOriginMs - initial.auth?.observedAtMonotonicMs;
  need(initial.pendingObservedReplies === 0 && initial.auth?.source === 'normal-desktop-auth-response'
    && initial.auth.phase === 'ready' && initial.auth.identitySHA256 === ui.config.accountIdentitySHA256
    && initial.auth.revision === initial.admission.revision && age >= 0 && age <= 15000
    && JSON.stringify(initial.admission) === JSON.stringify(ui.admission), 'fresh_current_admission_required');
  const timeline = observeUIActionCalls(ui, 'record');
  let finished = false, samplingFailed = false, actionFailed = false, persistenceFailed = false;
  let actionFailure, persistenceFailure, result, observedTimeline;
  const sampling = (async () => {
    while (!finished && performance.now() - started < CAP_MS && samples.length < MAX_SAMPLES) {
      await delay(50, undefined, { signal });
      if (!finished) await sample();
    }
  })().catch(() => { samplingFailed = true; });
  try {
    result = await invoke();
    while (!samplingFailed && performance.now() - started < CAP_MS
      && !samples.some(s => s.value.pendingObservedReplies === 0 && s.value.recording?.pendingMutation === false
        && s.value.recording.phase === 'recording' && s.value.recording.captureState === 'recording' && s.value.recording.elapsedSeconds >= 1))
      await delay(50, undefined, { signal });
  } catch (error) { actionFailed = true; actionFailure = error; }
  finally {
    finished = true; await sampling; // No detached reader or second input after abort.
    if (!actionFailed && !samplingFailed && !signal.aborted) {
      try { await sample(); } catch { samplingFailed = true; }
    }
    observedTimeline = timeline.close();
    const evidence = { schema: 1, source: 'owned-desktop-record-performance', executionKind: 'live',
      status: 'UNQUALIFIED', samples, timeline: observedTimeline, userTargetMs: DESKTOP_RECORD_TARGET_MS,
      existingEngineRecordReadyMs: 3000, authority: 'NONE', elapsedMs: performance.now() - started,
      analysis: null, observationSHA256: result ? sha256(JSON.stringify(result)) : null };
    try {
      need(!actionFailed && !samplingFailed && !signal.aborted, 'action_or_sampling_failed');
      need(result?.origin === 'product-ui' && result.executionKind === 'live' && result.action === 'record'
        && result.targetId === ui.scenario.targetId && result.nativeObservation?.source === 'normal-desktop-recording-response'
        && result.nativeObservation.phase === 'recording', 'normal_result_unconfirmed');
      evidence.analysis = analyzeDesktopRecordPerformance(evidence); evidence.status = 'MEASURED';
    } catch (error) { evidence.reason = /^desktop_performance_[a-z_]+$/.test(error?.message) ? error.message : error?.name ?? 'UnknownError'; }
    evidence.diagnosticRetention = 'INITIAL_AND_FINAL_EVENTS_INTERMEDIATE_FILE_HASHES';
    try { await retainNativePerformanceEvidence(evidencePath, ui.output, evidence); } catch (error) { persistenceFailed = true; persistenceFailure = error; }
  }
  if (actionFailed) throw actionFailure;
  if (persistenceFailed) throw persistenceFailure;
  return result;
}

/** Place this class INSIDE a before-Record checkpoint wrapper: the checkpoint
 * waits first, then its super.perform reaches this measurement and normal UI.
 * Process identity is freshly discovered by createDesktopObserver each session;
 * no PID is stored in this reusable class or named-scenario configuration. */
export function withDesktopRecordPerformance(Base, { profileDirectory }) {
  need(Base === AppiumUI && typeof profileDirectory === 'string', 'maintained_base_required');
  return class extends Base {
    async connect(scenario, options) {
      return observeDesktopPhase({ ui: this, phase: 'connect', output: await realpath(options.output),
        invoke: () => super.connect(scenario, options) });
    }
    async perform(action, scenario, signal) {
      if (['sign_in', 'workspace', 'create_visit', 'prepare', 'consent'].includes(action))
        return observeDesktopPhase({ ui: this, phase: action, output: this.output, invoke: () => super.perform(action, scenario, signal) });
      if (action !== 'record') return super.perform(action, scenario, signal);
      return collectDesktopRecordPerformance({ ui: this, signal, profileDirectory,
        evidencePath: resolve(this.output, `performance-record-${randomUUID()}.json`),
        invoke: () => super.perform(action, scenario, signal) });
    }
  };
}
