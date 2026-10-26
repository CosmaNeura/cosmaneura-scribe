import { projectNativeTimingHistory, buildNativeTimingMeasurement } from './native-timing.mjs';
import { boundNativeResponse } from './kernel-clock.mjs';
import { NATIVE_PERFORMANCE_BUDGETS_NS } from './kernel-clock-collector.mjs';
import { requireOwnedJournalExport } from './native-journal-export.mjs';
import { sha256 } from './journal.mjs';
import { publishExclusiveJSON } from './guard.mjs';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { AppiumUI, IOS_OBSERVER_HASHES } from './appium-ui.mjs';

const ns = () => process.hrtime.bigint().toString();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const scopeKeys = ['runId', 'workspaceId', 'appointmentRef', 'sessionId', 'recorderId', 'authRevision'];
const fail = code => Error(`native_performance_${code}`);
const endpoints = ['sourceReadyReceived', 'firstInputBuffer', 'firstConvertedBuffer', 'readyAccepted',
  'firstPacketPersistenceStarted', 'firstPacketPersistenceCompleted'];
const scopesEqual = (a, b) => scopeKeys.every(key => a?.[key] === b?.[key]);
const clones = value => structuredClone(value);
const liveTimelines = new WeakSet();
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function admissionMetadata(value) {
  const keys = ['runId', 'workspaceId', 'sessionId', 'consentRecordId', 'revision', 'requestId', 'requestNonce'];
  if (value?.source !== 'normal-native-admission-response' || !keys.every(key => uuid(value[key]))
      || !/^appointment_[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(value.appointmentRef ?? '')) throw fail('admission_unconfirmed');
  return { source: value.source, appointmentRef: value.appointmentRef, ...Object.fromEntries(keys.map(key => [key, value[key]])) };
}

/** Observe only an existing adapter invocation. No command is created, delayed,
 * replayed or swallowed. The original methods and promises are preserved.
 * The measured start is the raw adapter call, not physical touch or wire arrival. */
export function observeUIActionCalls(ui, action, { assertionAction = action } = {}) {
  if (!ui?.session || !ui.config?.journey?.[action] || typeof ui.rawRequest !== 'function'
      || typeof ui.check !== 'function' || typeof ui.find !== 'function')
    throw fail('action_contract_invalid');
  const plan = ui.config.journey[action], assertionPlan = ui.config.journey[assertionAction];
  if (!assertionPlan || plan.actions?.length !== 1 || plan.actions[0].action !== 'click' || !plan.actions[0].locator)
    throw fail('single_configured_click_required');
  const originalRequest = ui.rawRequest, originalCheck = ui.check, originalFind = ui.find;
  const configuredPlanSHA256 = sha256(JSON.stringify(plan)), assertionPlanSHA256 = sha256(JSON.stringify(assertionPlan));
  const session = ui.session, commands = [], checks = [];
  let active = true, overflow = false, ownershipLost = false, resolvedElement = null, configuredFinds = 0;
  const watch = (invoke, list, kind) => {
    const event = { kind, invokedNs: ns(), settledNs: null, status: 'PENDING' };
    if (list.length < 16) list.push(event); else overflow = true;
    try {
      const promise = invoke();
      if (!promise || typeof promise.then !== 'function') { event.status = 'INVALID'; return promise; }
      promise.then(() => { if (active) { event.settledNs = ns(); event.status = 'FULFILLED'; } },
        () => { if (active) { event.settledNs = ns(); event.status = 'REJECTED'; } });
      return promise;
    } catch (error) { event.settledNs = ns(); event.status = 'REJECTED'; throw error; }
  };
  const request = function (...args) {
    const [path, method = 'GET', , , options = {}] = args;
    const click = method === 'POST' && /^\/element\/[^/]+\/click$/.test(path);
    const otherInput = method === 'DELETE' || method === 'POST' && !click
      && !['/element', '/elements', '/context'].includes(path)
      && !(['/execute/sync', '/execute/async'].includes(path) && (options.readOnlyObservation || options.observerInstallation));
    const configuredClick = click && path === `/element/${resolvedElement}/click`;
    if (click) resolvedElement = null;
    return click || otherInput ? watch(() => originalRequest.apply(this, args), commands, configuredClick ? 'click' : 'other-input')
      : originalRequest.apply(this, args);
  };
  const check = function (...args) {
    return args[0] === assertionPlan ? watch(() => originalCheck.apply(this, args), checks, 'ui-assertions')
      : originalCheck.apply(this, args);
  };
  const find = function (...args) {
    const promise = originalFind.apply(this, args);
    if (!commands.length && args[0] === plan.actions[0].locator) {
      configuredFinds++;
      promise.then(element => { if (active && typeof element === 'string' && element.length) resolvedElement = element; }, () => {});
    }
    return promise;
  };
  ui.rawRequest = request; ui.check = check; ui.find = find;
  return Object.freeze({
    close() {
      if (active) {
        ownershipLost = ui.rawRequest !== request || ui.check !== check || ui.find !== find || ui.session !== session
          || sha256(JSON.stringify(plan)) !== configuredPlanSHA256 || sha256(JSON.stringify(assertionPlan)) !== assertionPlanSHA256;
        if (ui.rawRequest === request) ui.rawRequest = originalRequest;
        if (ui.check === check) ui.check = originalCheck;
        if (ui.find === find) ui.find = originalFind;
        active = false;
      }
      const valid = !overflow && !ownershipLost && configuredFinds === 1 && commands.length === 1
        && commands.every(event => event.kind === 'click' && event.status === 'FULFILLED')
        && checks.length === 1 && checks[0].status === 'FULFILLED';
      return { source: 'normal-ui-adapter-action-observation', action, assertionAction, session, configuredFinds, expectedClicks: 1,
        configuredPlanSHA256, assertionPlanSHA256,
        commands: clones(commands), checks: clones(checks), status: valid ? 'OBSERVED' : 'UNQUALIFIED',
        overflow, ownershipLost, authority: 'NONE', boundary: 'RAW_ADAPTER_INVOCATION_NOT_PHYSICAL_TOUCH',
        browserPrecision: 'UNKNOWN' };
    },
  });
}

function eventWindow(historyBefore, historyAfter, before, after, window) {
  const firstHistory = projectNativeTimingHistory(historyBefore), lastHistory = projectNativeTimingHistory(historyAfter);
  const first = firstHistory.samples.at(-1), last = lastHistory.samples.at(-1);
  if (!first || !last || !scopesEqual(first, last) || first.runId !== before.runId || last.runId !== after.runId
      || last.nativeRevision <= first.nativeRevision || last.sample.captureAttempt !== first.sample.captureAttempt + 1)
    throw fail('attempt_scope_changed');
  if (['invalidSamples', 'unavailableSamples', 'discardedRevisionSamples'].some(key => lastHistory[key] !== firstHistory[key])
      || lastHistory.evictedSamples < firstHistory.evictedSamples
      || !lastHistory.samples.some(value => eq(value, first))) throw fail('observer_window_incomplete');
  const analysis = buildNativeTimingMeasurement({ history: lastHistory, journalBytes: after.bytes });
  const events = analysis.journal.events.filter(value => value.captureAttempt === last.sample.captureAttempt);
  const starts = events.filter(value => value.event === 'startRequested');
  if (starts.length !== 1 || events[0] !== starts[0] || events.some(value => value.droppedEvents !== 0)
      || last.sample.droppedEvents !== 0 || BigInt(starts[0].monotonicNs) < BigInt(window.nativeWindowStartNs)
      || events.some(value => BigInt(value.monotonicNs) > BigInt(last.sample.monotonicNs)))
    throw fail('journal_window_incomplete');
  return { first, last, events, journal: analysis.journal,
    retention: { before: firstHistory.evictedSamples, after: lastHistory.evictedSamples,
      requiredObserverAnchorRetained: true, requiredJournalStartRetained: true,
      admissionBudgetAndQueueDropsInAttempt: 0, wholeJournalCompleteness: 'UNKNOWN',
      ringEvictionAndWriteFailureAccountedByDropCounter: false } };
}

function uiProof(observation, scope, targetId) {
  const native = observation?.nativeObservation, signal = native?.signal, timing = native?.timingObservation;
  if (observation?.origin !== 'product-ui' || observation.executionKind !== 'live' || observation.targetId !== targetId
      || !Array.isArray(observation.checks) || !observation.checks.length
      || observation.checks.some(check => check.actual !== check.expected)
      || native?.source !== 'normal-native-recording-response' || native.phase !== 'recording' || native.busy !== false
      || !scopesEqual(timing, scope) || native.nativeRevision !== timing.nativeRevision
      || !scopeKeys.slice(0, 5).every(key => native[key] === scope[key])
      || timing.sample.captureAttempt !== scope.sample.captureAttempt || signal?.version !== 2
      || !Number.isSafeInteger(native.capturedAudioFrames) || native.capturedAudioFrames <= 0
      || !Number.isSafeInteger(signal.inputBuffers) || signal.inputBuffers <= 0
      || !Number.isSafeInteger(signal.convertedBuffers) || signal.convertedBuffers <= 0 || signal.inputMuted !== false)
    throw fail('native_input_not_observed');
  return { requestId: timing.requestId, nativeRevision: timing.nativeRevision, captureAttempt: timing.sample.captureAttempt,
    capturedAudioFrames: native.capturedAudioFrames, inputBuffers: signal.inputBuffers,
    convertedBuffers: signal.convertedBuffers, inputMuted: false, acousticArrival: 'NOT_MEASURED' };
}

function retainedSample(history, value) {
  const projected = projectNativeTimingHistory({ ...history, samples: [value] }).samples[0];
  return projectNativeTimingHistory(history).samples.some(sample => eq(sample, projected));
}

/** Pure consistency analysis of supplied metadata. It cannot authenticate an
 * export or qualify a live run. The live entry additionally requires the reader's brand. */
export function analyzeNativePerformanceEvidence({ phase, timeline, before, after, historyBefore, historyAfter, window, observation, initialRecording, admission }) {
  if (!['record', 'resume'].includes(phase)) throw fail('native_phase_unsupported');
  if (before?.source !== 'owned-ios-native-journal-export' || after?.source !== before.source
      || !Buffer.isBuffer(after.bytes) || sha256(after.bytes) !== after.sha256
      || after.status !== 'READ' || !eq(before.process, after.process) || !eq(before.build, after.build)
      || ['runId', 'targetId', 'container', 'path', 'hostname', 'hardwareSHA256', 'bootSessionUUID'].some(key => before[key] !== after[key])
      || ['hostname', 'hardwareSHA256', 'bootSessionUUID'].some(key => after[key] !== window.identity?.[key])
      || window.runId !== after.runId || window.qualification !== 'CLOCK_MAPPING_ONLY') throw fail('journal_owner_changed');
  if (timeline.status !== 'OBSERVED' || timeline.commands.length !== 1
      || timeline.action !== phase || timeline.configuredFinds !== 1
      || timeline.commands[0].kind !== 'click' || timeline.checks.length !== 1) throw fail('action_unqualified');
  const data = eventWindow(historyBefore, historyAfter, before, after, window);
  admission = admissionMetadata(admission);
  if (['runId', 'workspaceId', 'appointmentRef', 'sessionId'].some(key => admission[key] !== data.last[key])
      || admission.revision !== data.last.authRevision) throw fail('admission_scope_changed');
  if (initialRecording?.source !== 'normal-native-recording-response' || initialRecording.busy !== false
      || initialRecording.phase !== (phase === 'record' ? 'ready' : 'paused')
      || !scopesEqual(initialRecording.timingObservation, data.first)
      || initialRecording.timingObservation.sample.captureAttempt !== data.first.sample.captureAttempt
      || !retainedSample(historyBefore, initialRecording.timingObservation))
    throw fail('initial_native_phase_unconfirmed');
  const input = uiProof(observation, data.last, after.targetId);
  // Require the actual recording proof's request in the retained normal history.
  if (!retainedSample(historyAfter, observation.nativeObservation.timingObservation)) throw fail('input_reply_not_retained');
  const command = timeline.commands[0], actionNs = BigInt(command.invokedNs), uiNs = BigInt(timeline.checks[0].settledNs);
  if (uiNs < actionNs || BigInt(command.settledNs) < actionNs || uiNs > BigInt(window.nodeWindowEndNs)
      || BigInt(command.settledNs) > BigInt(window.nodeWindowEndNs)) throw fail('action_clock_changed');
  // A new attempt after the baseline can still precede this click. Attribute
  // only when the entire mapped start interval is at or after its invocation.
  const startBound = boundNativeResponse({ window, nodeActionLowerNs: command.invokedNs, nodeActionUpperNs: command.invokedNs,
    nativeEventNs: data.events[0].monotonicNs, budgetNs: NATIVE_PERFORMANCE_BUDGETS_NS[phase] });
  if (BigInt(startBound.lowerNs) < 0n) throw fail('start_not_attributed_to_action');
  const actionToNativeStart = { lowerNs: startBound.lowerNs, upperNs: startBound.upperNs,
    attribution: 'NOT_BEFORE_OBSERVED_ACTION' };
  const measurements = endpoints.map(event => {
    const matches = data.events.filter(value => value.event === event);
    if (matches.length !== 1) return { event, status: matches.length ? 'AMBIGUOUS' : 'NOT_OBSERVED', qualification: 'NOT_ESTABLISHED' };
    const nativeNs = matches[0].monotonicNs;
    if (BigInt(nativeNs) < BigInt(data.events[0].monotonicNs)) throw fail('event_precedes_start');
    const bounded = boundNativeResponse({ window, nodeActionLowerNs: command.invokedNs, nodeActionUpperNs: command.invokedNs,
      nativeEventNs: nativeNs, budgetNs: NATIVE_PERFORMANCE_BUDGETS_NS[phase] });
    return { event, status: 'MEASURED', nativeNs, nativeFromStartNs: (BigInt(nativeNs) - BigInt(data.events[0].monotonicNs)).toString(),
      commandToEvent: event === 'readyAccepted' ? bounded : { lowerNs: bounded.lowerNs, upperNs: bounded.upperNs,
        budgetNs: null, budgetResult: 'NOT_APPLICABLE' }, budgetApplicable: event === 'readyAccepted' };
  });
  const ordered = ['sourceReadyReceived', 'firstInputBuffer', 'firstConvertedBuffer', 'readyAccepted']
    .map(event => measurements.find(value => value.event === event));
  if (ordered.some(value => value.status !== 'MEASURED')
      || ordered.some((value, index) => index && BigInt(value.nativeNs) < BigInt(ordered[index - 1].nativeNs)))
    throw fail('readiness_events_incomplete');
  return { source: 'owned-native-action-performance', phase, scope: Object.fromEntries(scopeKeys.map(key => [key, data.last[key]])),
    admission, admissionMetadataSHA256: sha256(JSON.stringify(admission)),
    captureAttempt: data.last.sample.captureAttempt, process: after.process, build: after.build, journalSHA256: after.sha256,
    timeline: clones(timeline), clockWindow: clones(window), retention: data.retention, input, actionToNativeStart,
    readinessBudgetNs: NATIVE_PERFORMANCE_BUDGETS_NS[phase], budgetBasis: 'PROSPECTIVE_ENGINEERING_NOT_USER_SLA', measurements,
    commandRoundTripNs: (BigInt(command.settledNs) - actionNs).toString(),
    commandToUIAssertionsNs: (uiNs - actionNs).toString(), toolWaitsSubtracted: false,
    boundary: 'RAW_ADAPTER_INVOCATION_TO_NATIVE_EVENT_INCLUDES_DRIVER_TRANSPORT', browserPrecision: 'UNKNOWN',
    readinessBudgetResult: measurements.find(value => value.event === 'readyAccepted')?.commandToEvent?.budgetResult ?? 'NOT_ESTABLISHED',
    qualification: 'SUPPLIED_EVIDENCE_CONSISTENCY_ONLY', fullWorkflowAcceptance: 'NOT_ESTABLISHED', acousticArrival: 'NOT_MEASURED' };
}

export function bindNativePerformanceEvidence(value) {
  requireOwnedJournalExport(value.before); requireOwnedJournalExport(value.after);
  if (!liveTimelines.has(value.timeline)) throw fail('normal_adapter_action_unconfirmed');
  return { ...analyzeNativePerformanceEvidence(value), qualification: 'NATIVE_ACTION_MEASUREMENT_ONLY' };
}

async function timingHistory(ui, signal) {
  const observed = await ui.webview(`const o = window.__scribeLabAdmissionObserver;
    return o ? { descriptor: o.describe(), history: o.readTiming?.() ?? null } : null;`, [], signal);
  if (observed?.descriptor?.observerSHA256 !== IOS_OBSERVER_HASHES.admission
      || ['runId', 'workspaceId', 'appointmentRef'].some(key => observed.descriptor[key] !== ui.binding?.[key]))
    throw fail('observer_changed');
  const history = projectNativeTimingHistory(observed.history);
  if (history.samples.some(sample => sample.sessionId !== ui.admission?.sessionId)) throw fail('observer_scope_changed');
  return history;
}

async function evidenceDestination(path, output) {
  if (typeof path !== 'string' || resolve(path) !== path || dirname(path) !== output
      || !/^performance-(record|resume)-[a-f0-9-]{36}\.json$/.test(basename(path))
      || await realpath(output) !== output) throw fail('evidence_path_unconfirmed');
  const directory = await stat(output);
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077)) throw fail('evidence_directory_not_private');
}

/** Exclusive, private metadata publication; an existing result is never replaced.
 * The bounded payload uses the same fsynced file/directory writer as the journal. */
export async function retainNativePerformanceEvidence(path, output, evidence) {
  await evidenceDestination(path, output);
  const bytes = Buffer.from(JSON.stringify(evidence) + '\n');
  if (bytes.length > 1048576) throw fail('evidence_too_large');
  await publishExclusiveJSON(path, evidence);
  return { path, sha256: sha256(bytes), byteLength: bytes.length };
}

const recordingMetadata = value => value ? { source: value.source, phase: value.phase, busy: value.busy,
  ...Object.fromEntries(scopeKeys.slice(0, 5).map(key => [key, value[key]])), nativeRevision: value.nativeRevision,
  observedAtMonotonicMs: value.observedAtMonotonicMs, browserTimeOriginMs: value.browserTimeOriginMs,
  capturedAudioFrames: value.capturedAudioFrames, timingObservation: value.timingObservation,
  signal: value.signal ? { version: value.signal.version, inputBuffers: value.signal.inputBuffers,
    convertedBuffers: value.signal.convertedBuffers, inputMuted: value.signal.inputMuted } : null } : null;

/** Diagnostic wrapper around exactly one existing normal action. The action's
 * original result/error is preserved; collection failure grants no authority.
 * Callers retain the receipt even when the normal action itself fails. */
export async function collectNativePerformanceAction({ ui, phase, invoke, clock, exportJournal, evidencePath, signal }) {
  if (!['record', 'resume'].includes(phase) || typeof invoke !== 'function'
      || typeof exportJournal !== 'function'
      || ui?.pending?.size || ui?.uncertainMutations?.size || ui?.inputSafetyUncertain)
    throw fail('action_precondition');
  signal?.throwIfAborted();
  // A fake object or replaced request method cannot promote a consistency-only
  // fixture into a normal adapter action. This import itself performs no UI IO.
  if (!(ui instanceof AppiumUI) || ['rawRequest', 'check', 'find', 'readRecording', 'webview', 'rawWebview', 'steps', 'observe']
    .some(key => ui[key] !== AppiumUI.prototype[key])
      || ui.config?.target?.role !== 'owned-ios-simulator') throw fail('normal_adapter_required');
  await evidenceDestination(evidencePath, ui.output);
  const admission = admissionMetadata(ui.admission);
  const initialRecording = await ui.readRecording(signal);
  if (initialRecording.phase !== (phase === 'record' ? 'ready' : 'paused') || initialRecording.busy !== false)
    throw fail('initial_native_phase_unconfirmed');
  const before = requireOwnedJournalExport(await exportJournal({ signal, allowMissing: true }));
  const historyBefore = await timingHistory(ui, signal);
  if (!historyBefore.samples.length) throw fail('baseline_native_sample_missing');
  const firstClock = await clock.sample({ signal });
  const observer = observeUIActionCalls(ui, phase, { assertionAction: 'record' });
  let result, originalError, timeline, after, historyAfter, window, receipt, lastClock, journalValid = false, actionFailed = false;
  try { result = await invoke(); } catch (error) { originalError = error; actionFailed = true; }
  finally { timeline = observer.close(); liveTimelines.add(timeline); }
  try {
    after = requireOwnedJournalExport(await exportJournal({ signal })); historyAfter = await timingHistory(ui, signal);
    buildNativeTimingMeasurement({ history: historyAfter, journalBytes: after.bytes }); journalValid = true;
    lastClock = await clock.sample({ signal }); window = clock.window(firstClock, lastClock);
    if (actionFailed) throw fail('normal_action_failed');
    if (!eq(admission, admissionMetadata(ui.admission))) throw fail('admission_changed');
    receipt = bindNativePerformanceEvidence({ phase, timeline, before, after, historyBefore, historyAfter, window, observation: result, initialRecording, admission });
  } catch {
    receipt = { source: 'owned-native-action-performance', phase, qualification: 'NOT_ESTABLISHED', timeline,
      collectionStatus: actionFailed ? 'NORMAL_ACTION_FAILED' : 'EVIDENCE_INCOMPLETE', fullWorkflowAcceptance: 'NOT_ESTABLISHED' };
  }
  const exportMetadata = value => value ? { ...value, bytes: undefined } : null;
  const evidence = { receipt, admission, before: exportMetadata(before), after: exportMetadata(after),
    journalBytesBase64: journalValid ? after.bytes.toString('base64') : null,
    historyBefore, historyAfter: historyAfter ?? null, initialRecording: recordingMetadata(initialRecording),
    observation: result ? { origin: result.origin, executionKind: result.executionKind, targetId: result.targetId,
      checks: result.checks?.map(check => ({ actual: check.actual === check.expected, expected: true })),
      phaseArtifact: result.phaseArtifacts ? { evidenceFile: result.phaseArtifacts.evidenceFile, sha256: result.phaseArtifacts.sha256 } : null,
      nativeObservation: recordingMetadata(result.nativeObservation), assertions: 'MATCH_PROJECTION_VALUES_OMITTED' } : null,
    clock: clock.snapshot(), clockLaunch: clock.launchReceipt,
    clockSampleNonces: { before: firstClock.nonce ?? null, after: lastClock?.nonce ?? null }, originalActionFailed: actionFailed };
  let retentionError, retention;
  try { retention = await retainNativePerformanceEvidence(evidencePath, ui.output, evidence); } catch (error) { retentionError = error; }
  if (actionFailed) throw originalError;
  if (retentionError) throw fail('evidence_not_retained');
  return { result, receipt, retention };
}
