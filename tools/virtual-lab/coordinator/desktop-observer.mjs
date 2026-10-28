import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { verifyBuild } from './native-identity.mjs';
import { sha256 } from './journal.mjs';
import { projectNoteObservation } from '../native/note-observation.mjs';
import { snapshotSaveFields, SAVE_UI_SCRIPT } from './save-completion.mjs';

const exec = promisify(execFile);
const liveObservers = new WeakMap();
export const isOwnedDesktopObserver = value => liveObservers.has(value) && liveObservers.get(value) === value.readPerformance;
/** Serialized into an owned Electron 44 MAIN inspector. It wraps only existing
 * workspace/recorder handlers and subscribes to the existing renderer event APIs.
 * Passive methods never call either product request API. The separately named
 * readCurrentRecording method issues only the public recorder's read command.
 * Electron's internal handler Map is
 * version-specific: absence, replacement, or another owner fails closed. */
export async function installDesktopMainObserver(owner, projectNoteObservation = null, saveFields = null, saveUIScript = null) {
  const requireModule = typeof require === 'function' ? require : process.mainModule?.require.bind(process.mainModule);
  if (!requireModule) throw Error('desktop_main_require_unavailable');
  const electron = requireModule('electron'), uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  const ref = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[0-7][0-9a-hjkmnp-tv-z]{25}$`).test(value);
  if (!uuid(owner.runId) || !/^[a-f0-9]{64}$/.test(owner.observerSHA256 ?? '') || process.pid !== owner.pid || process.execPath !== owner.executablePath
      || electron.app.getAppPath() !== owner.appPath || !process.versions.electron?.startsWith('44.')) throw Error('desktop_main_owner_mismatch');
  const targets = electron.webContents.getAllWebContents().filter(item => !item.isDestroyed() && /^app:\/\/cosmas\//.test(item.getURL()));
  if (targets.length !== 1 || targets[0].id !== owner.webContentsId) throw Error('desktop_renderer_owner_mismatch');
  const target = targets[0], handlers = electron.ipcMain._invokeHandlers;
  const existing = globalThis.__scribeLabDesktopMainObserver;
  if (existing) {
    const prior = existing.describe?.();
    if (prior?.runId !== owner.runId || prior.pid !== owner.pid || prior.webContentsId !== target.id || prior.observerSHA256 !== owner.observerSHA256) throw Error('desktop_main_owner_mismatch');
    return prior;
  }
  const workspaceChannel = 'scribe:provider:workspace:v1', recorderChannel = 'scribe:provider:recorder:v1';
  if (!(handlers instanceof Map) || typeof handlers.get(workspaceChannel) !== 'function') throw Error('desktop_handler_map_unavailable');
  const eventKey = '__scribeLabDesktopEvents';
  const eventInstall = function (key, runId) {
    if (window[key] || !window.scribeProvider?.subscribe || !window.scribeRecorder?.subscribe) throw Error('desktop_event_api_unavailable');
    let session = null, recording = null, closed = null, sequence = 0;
    const stamp = () => ({ sequence: ++sequence, observedAtMonotonicMs: performance.now(), browserTimeOriginMs: performance.timeOrigin });
    const stopSession = window.scribeProvider.subscribe(value => {
      if (value?.kind === 'session') session = { phase: value.state?.phase, revision: value.state?.revision,
        accountIdentitySHA256: value.state?.phase === 'ready' && /^[a-f0-9]{64}$/.test(value.state?.accountIdentitySHA256 ?? '')
          ? value.state.accountIdentitySHA256 : null, ...stamp() };
      else if (['connection_closed', 'encounter_closed'].includes(value?.kind)) closed = { kind: value.kind, id: value.id, ...stamp() };
    });
    const stopRecorder = window.scribeRecorder.subscribe(value => {
      const state = value?.snapshot;
      recording = { recorderId: value?.recorderId, nativeRevision: value?.revision, sessionId: state?.sessionId,
        phase: state?.state, nativePhase: state?.desktop?.phase, elapsedSeconds: state?.elapsedSeconds,
        recordedChunks: state?.recordedChunks, queuedChunks: state?.queuedChunks, ...stamp() };
    });
    const api = Object.freeze({ runId, read: () => ({ session, recording, closed }), close: () => {
      stopSession(); stopRecorder(); session = recording = closed = null;
      if (window[key] === api) delete window[key];
    } });
    window[key] = api;
    return true;
  };
  await target.executeJavaScript(`(${eventInstall.toString()})(${JSON.stringify(eventKey)},${JSON.stringify(owner.runId)})`);
  let active = true, generation = 0, recordingGeneration = 0, mutationPending = false, pending = 0;
  let connectionId = null, revision = null, current = null, created = null, createdCandidate = null, admission = null, recording = null, terminal = null;
  let scopeBinding = null, boundVisit = null, recorderId = null, lastEvent = { session: 0, recording: 0, closed: 0 };
  let notes = {}, noteRequests = {}, noteSession = null, currentNote = null, currentNoteRequest = null;
  let saveHandoff = null, saveSequence = 0;
  let authObservation = null, authSequence = 0, authMutationsPending = 0, authEpoch = 0;
  let recordingOwner = null, closedLifecycle = null, captureMutationSequence = 0;
  const wrappers = new Map(), observedReplies = new Set();
  const stamp = () => ({ observedAtMonotonicMs: performance.now(), browserTimeOriginMs: performance.timeOrigin });
  const invalidateLifecycle = (keepOwner = false) => { captureMutationSequence++; closedLifecycle = null; if (!keepOwner) recordingOwner = null; };
  const acceptClosed = (selected, requestId, closeMethod, sequence, priorClosed = null) => {
    if (!selected || sequence !== captureMutationSequence || !uuid(requestId)) return;
    const sameClosed = priorClosed && ['sessionId', 'recorderId', 'authRevision', 'workspaceId', 'appointmentRef']
      .every(key => priorClosed[key] === selected[key]);
    closedLifecycle ??= sameClosed ? { ...priorClosed, captureMutationSequence: sequence }
      : { source: 'normal-desktop-recorder-close-response', runId: owner.runId,
      workspaceId: selected.workspaceId, appointmentRef: selected.appointmentRef, sessionId: selected.sessionId,
      recorderId: selected.recorderId, authRevision: selected.authRevision,
      recordingSource: 'normal-desktop-recording-response', nativeRevisionBeforeClose: selected.nativeRevision,
      closeRequestId: requestId, closeMethod, phase: 'closed', captureMutationSequence: sequence, ...stamp() };
  };
  const closedSnapshot = () => closedLifecycle ? { ...closedLifecycle, currentCaptureMutationSequence: captureMutationSequence,
    inspectedAtMonotonicMs: performance.now(), pendingObservedReplies: pending } : null;
  const clearCapture = () => { admission = recording = terminal = null; recorderId = null; recordingGeneration++; mutationPending = false; };
  const clearVisit = () => {
    notes = {}; noteRequests = {}; noteSession = null; currentNote = currentNoteRequest = null;
    saveHandoff = null; saveSequence++;
    generation++; current = created = null; scopeBinding = boundVisit = null; clearCapture();
    const recorder = wrappers.get(recorderChannel);
    if (recorder && handlers.get(recorderChannel) === recorder.wrapped) handlers.set(recorderChannel, recorder.original);
    wrappers.delete(recorderChannel);
  };
  const clearAuth = () => {
    invalidateLifecycle();
    clearVisit(); connectionId = revision = null; created = createdCandidate = null;
    authSequence++; authObservation = null; authEpoch = Date.now();
  };
  function acceptAuth(value, observed = stamp()) {
    const epoch = observed.browserTimeOriginMs + observed.observedAtMonotonicMs;
    if (!Number.isFinite(epoch) || epoch < authEpoch || Math.abs(Date.now() - epoch) > 15000) return false;
    if (value?.phase !== 'ready' || !uuid(value.revision)) { clearAuth(); return true; }
    const digest = /^[a-f0-9]{64}$/.test(value.accountIdentitySHA256 ?? '') ? value.accountIdentitySHA256 : null;
    if (revision && revision !== value.revision || authObservation && authObservation.identitySHA256 !== digest) clearAuth();
    revision = value.revision; authEpoch = epoch;
    authObservation = digest && authMutationsPending === 0 ? { source: 'normal-desktop-auth-response', runId: owner.runId,
      phase: 'ready', revision, identitySHA256: digest, ...observed } : null;
    return true;
  }
  function acceptRecording(value) {
    if (!active || mutationPending || !current || !admission) return;
    if (!uuid(value?.recorderId) || value.sessionId !== admission.sessionId
        || recorderId && recorderId !== value.recorderId || !Number.isSafeInteger(value.nativeRevision) || value.nativeRevision < 0
        || !['idle', 'preparing', 'ready', 'recording', 'paused', 'uploading', 'processing', 'complete', 'error'].includes(value.phase)
        || !['preparing', 'ready', 'permission_required', 'starting', 'recording', 'stopping', 'interrupted', 'stop_unconfirmed', 'stopped'].includes(value.nativePhase)
        || !['elapsedSeconds', 'recordedChunks', 'queuedChunks'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) { recording = terminal = null; return; }
    if (recording && value.nativeRevision < recording.nativeRevision) return;
    recorderId = value.recorderId;
    if (closedLifecycle) {
      const eventAt = value.browserTimeOriginMs + value.observedAtMonotonicMs;
      if (!Number.isFinite(eventAt) || eventAt > closedLifecycle.browserTimeOriginMs + closedLifecycle.observedAtMonotonicMs) invalidateLifecycle();
      return;
    }
    recordingOwner = { workspaceId: current.workspaceId, appointmentRef: current.appointmentRef,
      sessionId: value.sessionId, recorderId, nativeRevision: value.nativeRevision, authRevision: revision };
    const observed = Number.isFinite(value.observedAtMonotonicMs) && Number.isFinite(value.browserTimeOriginMs)
      ? { observedAtMonotonicMs: value.observedAtMonotonicMs, browserTimeOriginMs: value.browserTimeOriginMs } : stamp();
    if (Math.abs(Date.now() - observed.browserTimeOriginMs - observed.observedAtMonotonicMs) > 15000) { recording = null; return; }
    recording = { source: 'normal-desktop-recording-response', transport: 'electron-main-ipc', ...current,
      sessionId: value.sessionId, recorderId, nativeRevision: value.nativeRevision, phase: value.nativePhase, captureState: value.phase,
      pendingMutation: mutationPending, elapsedSeconds: value.elapsedSeconds,
      recordedChunks: value.recordedChunks, queuedChunks: value.queuedChunks, ...observed };
    recording.source = 'normal-desktop-recording-response';
    if (value.nativePhase === 'stopped' && ['uploading', 'processing', 'complete'].includes(value.phase)) terminal ??= recording;
  }
  async function refreshEvents() {
    if (!active || target.isDestroyed() || !/^app:\/\/cosmas\//.test(target.getURL())) { clearAuth(); throw Error('desktop_observer_detached'); }
    const events = await target.executeJavaScript(`window.${eventKey}?.read() ?? null`);
    if (!events) { clearAuth(); throw Error('desktop_event_observer_lost'); }
    if (events.session?.sequence > lastEvent.session) {
      lastEvent.session = events.session.sequence;
      if (acceptAuth(events.session, { observedAtMonotonicMs: events.session.observedAtMonotonicMs,
        browserTimeOriginMs: events.session.browserTimeOriginMs })) authSequence++;
    }
    if (events.closed?.sequence > lastEvent.closed) {
      lastEvent.closed = events.closed.sequence;
      if (events.closed.id === connectionId) clearAuth();
      else if (events.closed.id === current?.encounterId) clearVisit();
    }
    if (events.recording?.sequence > lastEvent.recording) {
      lastEvent.recording = events.recording.sequence;
      acceptRecording(events.recording);
    }
    attachRecorder();
  }
  function wrap(channel, project, observe) {
    const original = handlers.get(channel);
    if (typeof original !== 'function') return false;
    if (wrappers.has(channel)) {
      if (original !== wrappers.get(channel).wrapped) throw Error('desktop_handler_replaced');
      return true;
    }
    const wrapped = function (event, request) {
      // The authorized product handler remains responsible for all validation,
      // authorization and effects. Its exact return object/promise is preserved.
      let meta;
      try { if (active && event?.sender?.id === target.id) meta = project(request); } catch { clearVisit(); }
      let result;
      const settleAuth = () => { if (meta?.authMutation) { authMutationsPending--; meta.authMutation = false; } };
      try { result = original.apply(this, arguments); } catch (error) {
        settleAuth(); if (meta) clearCapture();
        if (meta?.authSequence === authSequence) clearAuth(); throw error;
      }
      if (meta) {
        pending++;
        const observed = Promise.resolve(result).then(reply => {
          settleAuth(); if (active) { try { observe(meta, reply); } catch { clearCapture(); } }
        }, () => {
          settleAuth(); if (active && meta.generation === generation) clearCapture();
          if (active && meta.authSequence === authSequence) clearAuth();
        })
          .finally(() => { pending--; observedReplies.delete(observed); });
        observedReplies.add(observed);
      }
      return result;
    };
    handlers.set(channel, wrapped); wrappers.set(channel, { original, wrapped }); return true;
  }
  function workspaceRequest(request) {
    if (!uuid(request?.requestId) || !['session_read', 'sign_in', 'sign_out', 'connect', 'disconnect', 'list', 'create', 'open', 'open_core', 'encounter_setup', 'core', 'cancel', 'recorder'].includes(request.method)
        || request.connectionId !== null && !uuid(request.connectionId) || request.encounterId !== null && !uuid(request.encounterId)) return null;
    const method = request.method, payload = request.payload;
    const closingOwner = ['list', 'open'].includes(method) && request.connectionId === connectionId ? recordingOwner : null;
    const lifecycleSequence = captureMutationSequence;
    if (['sign_in', 'sign_out', 'disconnect', 'connect'].includes(method)) clearAuth();
    if (['recorder', 'create', 'encounter_setup'].includes(method)) invalidateLifecycle();
    if (['list', 'create', 'open', 'encounter_setup', 'cancel'].includes(method)) clearVisit();
    if (method === 'create' || method === 'encounter_setup' && payload?.action === 'submit') { created = createdCandidate = null; }
    const meta = { requestId: request.requestId, method, connectionId: request.connectionId, encounterId: request.encounterId,
      generation, recordingGeneration, closingOwner, lifecycleSequence, action: payload?.action === 'submit' ? 'submit' : null };
    if (['session_read', 'sign_in', 'sign_out'].includes(method)) {
      meta.authSequence = ++authSequence;
      meta.authMutation = method !== 'session_read';
      if (meta.authMutation) authMutationsPending++;
    }
    if (method === 'open') meta.appointmentRef = ref(payload?.appointmentRef, 'appointment') ? payload.appointmentRef : null;
    if (method === 'open_core') {
      saveHandoff = null; saveSequence++;
      if (payload && Object.keys(payload).join() === 'noteRef' && ref(payload.noteRef, 'visit_note')
          && currentNote?.note_ref === payload.noteRef && request.connectionId === connectionId
          && request.encounterId === current?.encounterId && authObservation?.revision === revision && authMutationsPending === 0) {
        meta.save = { sequence: saveSequence, note: currentNote, noteRequest: currentNoteRequest,
          identitySHA256: authObservation.identitySHA256, revision, ...stamp() };
      }
    }
    if (method === 'core' && payload?.path === '/service/v1/agent/scribe/capture-admissions') {
      invalidateLifecycle();
      clearCapture(); meta.recordingGeneration = recordingGeneration; meta.admission = true;
      meta.workspaceId = uuid(payload.body?.workspace_id) ? payload.body.workspace_id : null;
      meta.requestNonce = uuid(payload.body?.request_nonce) ? payload.body.request_nonce : null;
      meta.bindingMatches = boundVisit?.appointmentRef === current?.appointmentRef && boundVisit?.workspaceId === current?.workspaceId
        && typeof scopeBinding === 'string' && payload.body?.binding_ref === scopeBinding;
    }
    if (method === 'core' && ['/service/v1/agent/scribe/capture-notes', '/service/v1/agent/scribe/note-opening'].includes(payload?.path) && current
        && payload.body?.binding_ref === scopeBinding && payload.body?.workspace_id === current.workspaceId) {
      const body = payload.body;
      if (noteSession !== body.expected_session_id) { notes = {}; noteRequests = {}; }
      noteSession = body.expected_session_id;
      meta.noteRequest = { action: body.action, expected_session_id: body.expected_session_id,
        workspace_id: body.workspace_id, binding_ref: body.binding_ref, request_nonce: body.request_nonce,
        ...(payload.path.endsWith('/note-opening') ? { transportAction: 'note_opening' } : {}) };
      meta.noteAction = meta.noteRequest.transportAction === 'note_opening' ? 'read' : body.action;
      delete notes[meta.noteAction];
      noteRequests[meta.noteAction] = request.requestId;
      currentNote = null; currentNoteRequest = request.requestId;
      saveHandoff = null; saveSequence++;
    }
    return meta;
  }
  function workspaceReply(meta, reply) {
    // ProviderWorkspaceMain awaits closeEncounter/recorder.dispose before a
    // successful list/open reply. The earlier encounter_closed event is not proof.
    const transition = reply?.result;
    const closedTransition = meta.method === 'list' ? Array.isArray(transition)
      && transition.length <= 100000 && transition.every(item => ref(item?.appointmentRef, 'appointment'))
      : meta.method === 'open' && uuid(transition?.encounterId) && uuid(transition.scope?.workspaceId)
        && transition.scope?.appointmentRef === meta.appointmentRef && transition.encounter?.appointmentRef === meta.appointmentRef
        && ref(transition.scope?.bindingRef, 'scribe_capture_binding');
    if (meta.closingOwner && reply?.requestId === meta.requestId && reply.ok === true
        && Object.keys(reply).sort().join() === 'ok,requestId,result' && closedTransition)
      acceptClosed(meta.closingOwner, meta.requestId, `workspace_${meta.method}`, meta.lifecycleSequence);
    if (meta.authSequence !== undefined) {
      if (meta.authSequence !== authSequence || meta.generation !== generation) return;
      if (reply?.requestId !== meta.requestId || reply.ok !== true) { clearAuth(); return; }
      acceptAuth(reply.result); return;
    }
    if (meta.generation !== generation || reply?.requestId !== meta.requestId || reply.ok !== true) return;
    const result = reply.result;
    if (meta.save && meta.save.sequence === saveSequence && meta.connectionId === connectionId
        && meta.encounterId === current?.encounterId && meta.save.note === currentNote && meta.save.noteRequest === currentNoteRequest
        && meta.save.revision === revision && authObservation?.identitySHA256 === meta.save.identitySHA256 && authMutationsPending === 0
        && result === null && Object.keys(reply).sort().join() === 'ok,requestId,result') {
      saveHandoff = { source: 'normal-desktop-open-core-response', runId: owner.runId,
        workspaceId: current.workspaceId, appointmentRef: current.appointmentRef, encounterId: current.encounterId,
        connectionId, revision, mountRequestId: current.requestId, openCoreRequestId: meta.requestId,
        accountIdentitySHA256: meta.save.identitySHA256, note: { ...currentNote },
        requestObservedAtMonotonicMs: meta.save.observedAtMonotonicMs, requestBrowserTimeOriginMs: meta.save.browserTimeOriginMs, ...stamp() };
    }
    if (meta.noteRequest && noteRequests[meta.noteAction] === meta.requestId
        && meta.connectionId === connectionId && meta.encounterId === current?.encounterId
        && result?.status === 200 && typeof projectNoteObservation === 'function') {
      const note = projectNoteObservation(meta.noteRequest, result.body, current);
      if (note) { notes[note.action] = note; if (currentNoteRequest === meta.requestId) currentNote = note; }
    }
    if (meta.method === 'connect') {
      if (!uuid(result?.connectionId) || !uuid(result.revision) || revision && revision !== result.revision) { clearAuth(); return; }
      connectionId = result.connectionId; revision = result.revision;
    } else if (meta.connectionId === connectionId && meta.method === 'encounter_setup' && meta.action === 'submit' && ref(result?.appointmentRef, 'appointment')) {
      createdCandidate = { requestId: meta.requestId, appointmentRef: result.appointmentRef, revision, ...stamp() };
    } else if (meta.connectionId === connectionId && meta.method === 'open') {
      const scope = result?.scope;
      if (!uuid(result?.encounterId) || !uuid(scope?.workspaceId) || !uuid(revision) || !ref(scope?.appointmentRef, 'appointment')
          || scope.appointmentRef !== meta.appointmentRef || result.encounter?.appointmentRef !== scope.appointmentRef
          || !ref(scope.bindingRef, 'scribe_capture_binding')) return;
      current = { source: 'normal-native-mount-response', transport: 'electron-main-ipc', runId: owner.runId,
        workspaceId: scope.workspaceId, appointmentRef: scope.appointmentRef, encounterId: result.encounterId,
        connectionId, revision, requestId: meta.requestId, ...stamp() };
      scopeBinding = scope.bindingRef;
      if (recordingOwner && (recordingOwner.workspaceId !== current.workspaceId || recordingOwner.appointmentRef !== current.appointmentRef)) invalidateLifecycle();
      if (createdCandidate?.appointmentRef === current.appointmentRef && createdCandidate.revision === revision)
        created = { ...current, source: 'normal-native-created-visit-response', requestId: createdCandidate.requestId,
          scopeObservedByRequestId: current.requestId, createdAtMonotonicMs: createdCandidate.observedAtMonotonicMs };
    } else if (meta.admission && meta.connectionId === connectionId && meta.encounterId === current?.encounterId
        && meta.recordingGeneration === recordingGeneration && meta.bindingMatches && meta.workspaceId === current.workspaceId) {
      const body = result?.body;
      if (result.status !== 200 || body?.status !== 'admitted' || body.workspace_id !== current.workspaceId
          || body.appointment_ref !== current.appointmentRef || body.request_nonce !== meta.requestNonce
          || body.binding_ref !== scopeBinding || !uuid(body.session_id) || !uuid(body.consent_record_id)
          || !ref(body.operation_ref, 'scribe_admission')) return;
      admission = { ...current, source: 'normal-native-admission-response', requestId: meta.requestId,
        requestNonce: meta.requestNonce, sessionId: body.session_id, consentRecordId: body.consent_record_id,
        operationRef: body.operation_ref, ...stamp() };
    }
  }
  function attachRecorder() {
    wrap(recorderChannel, request => {
      if (!uuid(request?.requestId)) return null;
      if (request.kind === 'deactivate') {
        const selected = recordingOwner, priorClosed = closedLifecycle;
        invalidateLifecycle(true);
        recording = terminal = null; recordingGeneration++; mutationPending = true;
        return { requestId: request.requestId, recorderId: request.recorderId, closingOwner: selected,
          lifecycleSequence: captureMutationSequence, priorClosed, close: true };
      }
      if (request.kind !== 'read') invalidateLifecycle(true);
      if (!admission) return null;
      const mutation = request.kind !== 'read';
      if (mutation) { recording = terminal = null; recordingGeneration++; mutationPending = true; }
      return { requestId: request.requestId, recorderId: request.recorderId, mutation, generation, recordingGeneration };
    }, (meta, reply) => {
      if (meta.close) {
        if (meta.lifecycleSequence !== captureMutationSequence) return;
        mutationPending = false;
        if (meta.closingOwner?.recorderId === meta.recorderId && reply?.requestId === meta.requestId
            && reply.ok === true && reply.state === null && Object.keys(reply).sort().join() === 'ok,requestId,state')
          acceptClosed(meta.closingOwner, meta.requestId, 'deactivate', meta.lifecycleSequence, meta.priorClosed);
        return;
      }
      if (meta.generation !== generation || meta.recordingGeneration !== recordingGeneration) return;
      if (meta.mutation) mutationPending = false;
      if (reply?.requestId !== meta.requestId || reply.ok !== true || !reply.state) { recording = null; return; }
      const state = reply.state, snapshot = state.snapshot;
      if (meta.recorderId && state.recorderId !== meta.recorderId) { recording = null; return; }
      acceptRecording({ recorderId: state.recorderId, nativeRevision: state.revision, sessionId: snapshot?.sessionId,
        phase: snapshot?.state, nativePhase: snapshot?.desktop?.phase, elapsedSeconds: snapshot?.elapsedSeconds,
        recordedChunks: snapshot?.recordedChunks, queuedChunks: snapshot?.queuedChunks });
    });
  }
  try { wrap(workspaceChannel, workspaceRequest, workspaceReply); attachRecorder(); }
  catch (error) {
    active = false;
    for (const [channel, { original, wrapped }] of wrappers) if (handlers.get(channel) === wrapped) handlers.set(channel, original);
    await target.executeJavaScript(`window.${eventKey}?.close()`); throw error;
  }
  async function readSaveRenderer(script) {
    await refreshEvents();
    const selected = current, note = currentNote, epoch = generation, account = authObservation?.identitySHA256;
    if (!selected || !note || !account || authMutationsPending !== 0) return null;
    const result = await target.executeJavaScript(script);
    await refreshEvents();
    return current === selected && currentNote === note && generation === epoch
      && authObservation?.identitySHA256 === account && authMutationsPending === 0 ? result : null;
  }
  const api = Object.freeze({
    async bindVisit(scope) {
      await refreshEvents();
      if (!current || scope?.runId !== owner.runId || scope.workspaceId !== current.workspaceId
          || scope.appointmentRef !== current.appointmentRef || scope.revision && scope.revision !== current.revision) throw Error('desktop_visit_binding_mismatch');
      boundVisit = { workspaceId: current.workspaceId, appointmentRef: current.appointmentRef }; clearCapture();
      return { ...current };
    },
    describe: () => ({ runId: owner.runId, pid: process.pid, webContentsId: target.id, observerSHA256: owner.observerSHA256, pendingObservedReplies: pending }),
    async recoverySnapshot() {
      await refreshEvents();
      return { descriptor: api.describe(), currentVisit: current && { ...current },
        nativeObservation: recording && { ...recording }, currentNote: currentNote && { ...currentNote }, closedLifecycle: closedSnapshot() };
    },
    async retainForRecovery() {
      await Promise.allSettled([...observedReplies]);
      return { observerRetainedForRecovery: true, pendingObservedReplies: pending, ownedResourcesSettled: pending === 0 };
    },
    async read(kind) {
      await refreshEvents();
      const value = { created, current, admission, recording, terminal }[kind];
      if (!['created', 'current', 'admission', 'recording', 'terminal'].includes(kind)) throw Error('desktop_observation_kind');
      if (kind === 'recording' && (!value || Math.abs(Date.now() - value.browserTimeOriginMs - value.observedAtMonotonicMs) > 15000)) return null;
      return value ? { ...value } : null;
    },
    async readNote(action) { await refreshEvents(); return notes[action] ? { ...notes[action] } : null; },
    async readCurrentNote() { await refreshEvents(); return currentNote ? { ...currentNote } : null; },
    async readSaveHandoff() { await refreshEvents(); return saveHandoff ? { ...saveHandoff, note: { ...saveHandoff.note }, pendingObservedReplies: pending } : null; },
    async readSaveFields(order) {
      if (typeof saveFields !== 'function' || !Array.isArray(order) || !order.length || order.length > 100
          || order.some(key => typeof key !== 'string' || !key.trim() || key.length > 200)
          || JSON.stringify(order) !== JSON.stringify(currentNote?.field_order)) return null;
      return readSaveRenderer(`(${saveFields.toString()})(${JSON.stringify(order)})`);
    },
    async readSaveUI() { return typeof saveUIScript === 'string' ? readSaveRenderer(`(()=>{${saveUIScript}})()`) : null; },
    async readClosed() { await refreshEvents(); return closedSnapshot(); },
    async readAuth() {
      await refreshEvents();
      const age = authObservation && Date.now() - authObservation.browserTimeOriginMs - authObservation.observedAtMonotonicMs;
      return authObservation && authMutationsPending === 0 && age >= 0 && age <= 15000 ? { ...authObservation } : null;
    },
    async readCurrentRecording() {
      await refreshEvents();
      const auth = await api.readAuth(), retained = recording && { ...recording };
      if (!auth || !admission || !retained || !uuid(recorderId) || mutationPending || pending !== 0
          || !current || !boundVisit || current.workspaceId !== boundVisit.workspaceId
          || current.appointmentRef !== boundVisit.appointmentRef || retained.sessionId !== admission.sessionId)
        throw Error('desktop_current_read_scope_unconfirmed');
      const selected = { recorderId, generation, recordingGeneration, authEpoch, admission: JSON.stringify(admission) };
      const requestId = requireModule('node:crypto').randomUUID(), invokedAtMonotonicMs = performance.now();
      // Public IPC kind=read only returns the current getter; it performs no
      // recorder operation. The installed normal wrapper observes its real
      // reply and timestamps that reply, never re-dates the retained event.
      const reply = await target.executeJavaScript(`(async()=>{const r=await window.scribeRecorder.request(${JSON.stringify({ kind: 'read', requestId, recorderId })});return {requestId:r?.requestId,ok:r?.ok,recorderId:r?.state?.recorderId,revision:r?.state?.revision,sessionId:r?.state?.snapshot?.sessionId};})()`);
      await refreshEvents();
      const afterAuth = await api.readAuth();
      if (!reply || reply.requestId !== requestId || reply.ok !== true || reply.recorderId !== selected.recorderId
          || reply.sessionId !== admission?.sessionId || reply.revision !== recording?.nativeRevision
          || recorderId !== selected.recorderId || generation !== selected.generation
          || recordingGeneration !== selected.recordingGeneration || authEpoch !== selected.authEpoch
          || JSON.stringify(admission) !== selected.admission || mutationPending || pending !== 0
          || !afterAuth || afterAuth.revision !== auth.revision || afterAuth.identitySHA256 !== auth.identitySHA256
          || !recording || recording.observedAtMonotonicMs < invokedAtMonotonicMs || recording.pendingMutation !== false)
        throw Error('desktop_current_read_identity_changed');
      return { source: 'explicit-public-desktop-recorder-read', requestId, runId: owner.runId,
        invokedAtMonotonicMs, observedAtMonotonicMs: performance.now(), browserTimeOriginMs: performance.timeOrigin,
        retainedEvent: retained, recording: { ...recording }, admission: { ...admission }, auth: { ...afterAuth },
        command: 'read', productMutation: false };
    },
    async readPerformance() {
      // Read only the actual host's bounded metadata file. No diagnostic event
      // is created, and no recorder request or audio sample is issued/read.
      await refreshEvents();
      const fs = requireModule('node:fs'), path = requireModule('node:path'), crypto = requireModule('node:crypto');
      const profile = electron.app.getPath('userData'), file = path.join(profile, 'runtime-diagnostics-v1.jsonl');
      if (fs.realpathSync(profile) !== profile) throw Error('desktop_timing_profile_changed');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let diagnostics;
      try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o077)
            || info.size > 65536) throw Error('desktop_timing_file_invalid');
        const bytes = Buffer.alloc(info.size), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
        const after = fs.fstatSync(fd);
        if (count !== bytes.length || after.ino !== info.ino || after.dev !== info.dev || after.size < info.size)
          throw Error('desktop_timing_read_changed');
        const text = bytes.toString('utf8');
        if (text && !text.endsWith('\n')) throw Error('desktop_timing_partial_line');
        const events = [];
        for (const line of text.split('\n').filter(Boolean)) {
          const value = JSON.parse(line);
          if (value?.pid !== process.pid) continue;
          if (!['host_open', 'window_ready', 'audio_start_pending', 'audio_ready', 'audio_start_timeout',
            'audio_failed', 'audio_packet_invalid', 'audio_chunk_commit_failed', 'audio_stop_confirmed',
            'audio_permission_required', 'audio_device_changed', 'audio_session_locked', 'audio_clock_discontinuity', 'audio_overflow',
            'provider_record_to_native_ready', 'provider_consent_to_ready', 'provider_recorder_prepare'].includes(value.event)) continue;
          const keys = Object.keys(value).sort().join();
          if (![ 'capture_attempt,event,monotonic_ns,pid,utc', 'capture_attempt,duration_ms,event,monotonic_ns,pid,utc'].includes(keys)
              || !/^[0-9]{1,24}$/.test(value.monotonic_ns ?? '') || !Number.isSafeInteger(value.capture_attempt)
              || value.capture_attempt < 0 || !Number.isFinite(Date.parse(value.utc))
              || value.duration_ms !== undefined && (!Number.isFinite(value.duration_ms) || value.duration_ms < 0 || value.duration_ms > 3600000))
            throw Error('desktop_timing_event_invalid');
          events.push(value);
        }
        diagnostics = { file: 'runtime-diagnostics-v1.jsonl', device: info.dev, inode: info.ino,
          bytes: count, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), events };
      } finally { fs.closeSync(fd); }
      return { source: 'owned-desktop-performance-snapshot', runId: owner.runId, pid: process.pid,
        executablePath: process.execPath, appPath: electron.app.getAppPath(), profile,
        hostname: requireModule('node:os').hostname(), mainMonotonicNs: process.hrtime.bigint().toString(),
        pendingObservedReplies: pending, admission: admission && { ...admission },
        recording: recording && { ...recording }, auth: authObservation && { ...authObservation }, diagnostics };
    },
    async uninstall() {
      if (pending !== 0 || [...wrappers].some(([channel, value]) => handlers.get(channel) !== value.wrapped))
        return { observerRemoved: false, observerRetainedForRecovery: true,
          pendingObservedReplies: pending, ownedResourcesSettled: false };
      active = false; clearAuth();
      for (const [channel, { original, wrapped }] of wrappers) if (handlers.get(channel) === wrapped) handlers.set(channel, original);
      await target.executeJavaScript(`window.${eventKey}?.close()`);
      if (globalThis.__scribeLabDesktopMainObserver === api) delete globalThis.__scribeLabDesktopMainObserver;
      return { observerRemoved: true, pendingObservedReplies: pending, ownedResourcesSettled: pending === 0 };
    },
  });
  globalThis.__scribeLabDesktopMainObserver = api;
  return api.describe();
}

export function validateInspectorEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
      || !url.port || Number(url.port) < 1024 || url.pathname !== '/' || url.search || url.hash) throw Error('owned_inspector_endpoint_required');
  return url;
}
async function inside(path, root) {
  const actual = await realpath(path), parent = await realpath(root), rel = relative(parent, actual);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('inspector_path_outside_candidate');
  return actual;
}
async function inspectorClient(url, signal) {
  const response = await fetch(new URL('/json/list', url), { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
  const targets = await response.json();
  if (!response.ok || !Array.isArray(targets) || targets.length !== 1) throw Error('owned_inspector_target_ambiguous');
  const target = targets[0], socketUrl = new URL(target.webSocketDebuggerUrl);
  if (socketUrl.protocol !== 'ws:' || socketUrl.hostname !== '127.0.0.1' || socketUrl.port !== url.port
      || socketUrl.username || socketUrl.password || socketUrl.search || socketUrl.hash || socketUrl.pathname !== `/${target.id}`) throw Error('owned_inspector_target_mismatch');
  const socket = new WebSocket(socketUrl), pending = new Map(); let sequence = 0, uncertain = false;
  await new Promise((yes, no) => { const timer = setTimeout(() => { socket.close(); no(Error('inspector_connect_timeout')); },10000);
    socket.addEventListener('open', () => { clearTimeout(timer); yes(); }, { once:true });
    socket.addEventListener('error', () => { clearTimeout(timer); no(Error('inspector_connect_failed')); }, { once:true }); });
  socket.addEventListener('message', event => {
    let message; try { message = JSON.parse(String(event.data)); } catch { return; }
    const call = pending.get(message.id); if (!call) return; pending.delete(message.id); clearTimeout(call.timer);
    if (message.error) call.reject(Error('inspector_command_failed')); else call.resolve(message.result);
  });
  const close = () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(Error('inspector_closed')); } pending.clear(); socket.close(); };
  return { targetId: target.id, uncertain: () => uncertain, async evaluate(expression, { cleanup = false } = {}) {
    if (!cleanup) signal.throwIfAborted();
    const id = ++sequence;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { uncertain = true; pending.delete(id); reject(Error('inspector_command_timeout')); },10000);
      pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));
    });
    if (!cleanup) signal.throwIfAborted();
    if (result.exceptionDetails || result.result?.subtype === 'error') throw Error('desktop_observer_evaluation_failed');
    return result.result?.value;
  }, close };
}

/** Run on the owned Mac, with an explicitly launched `--inspect=127.0.0.1:PORT`
 * candidate. No renderer-debug port, application request, token or native action
 * is issued. Appium remains the only UI driver. Close removes only this observer. */
export async function createDesktopObserver({ config, scenario, endpoint, pid, executablePath, appPath, signal, readOnly = false, allowMissing = false, discoverCurrentProcess = false }) {
  if (!(signal instanceof AbortSignal) || typeof discoverCurrentProcess !== 'boolean'
      || (discoverCurrentProcess ? pid !== undefined : !Number.isSafeInteger(pid) || pid <= 0)
      || !['owned-macos-guest','owned-macos-lab'].includes(config.target.role)
      || allowMissing && !readOnly) throw Error('owned_desktop_inspector_required');
  signal.throwIfAborted(); const url = validateInspectorEndpoint(endpoint);
  await verifyBuild(config,scenario);
  const executable = await inside(executablePath,config.app.path), application = await inside(appPath,config.app.path);
  const listener = (await exec('lsof',['-nP',`-iTCP:${url.port}`,'-sTCP:LISTEN','-Fpn'],{timeout:10000})).stdout.trim().split('\n');
  if (discoverCurrentProcess) {
    const rows = listener.filter(line => line.startsWith('p'));
    if (rows.length !== 1 || !/^p[1-9][0-9]*$/.test(rows[0])) throw Error('inspector_current_process_ambiguous');
    pid = Number(rows[0].slice(1));
  }
  if (listener.filter(line=>line.startsWith('p')).some(line=>line!==`p${pid}`)
      || !listener.includes(`p${pid}`) || listener.filter(line=>line.startsWith('n')).some(line=>line!==`n127.0.0.1:${url.port}`)) throw Error('inspector_listener_owner_mismatch');
  const command = (await exec('ps',['-p',String(pid),'-o','comm='],{timeout:10000})).stdout.trim();
  if (await realpath(command) !== executable) throw Error('inspector_process_path_mismatch');
  const processRow = (await exec('ps',['-p',String(pid),'-o','pid=,lstart=,comm='],{timeout:10000})).stdout.trim();
  if (!processRow.startsWith(`${pid} `) || !processRow.endsWith(command)) throw Error('inspector_process_identity_unconfirmed');
  const client = await inspectorClient(url,signal); let installationAttempted = false;
  try {
    const identity = await client.evaluate(`(()=>{const r=typeof require==='function'?require:process.mainModule?.require.bind(process.mainModule);const e=r?.('electron');return {pid:process.pid,executablePath:process.execPath,appPath:e?.app.getAppPath(),version:process.versions.electron,targets:e?.webContents.getAllWebContents().filter(w=>!w.isDestroyed()&&/^app:\\/\\/cosmas\\//.test(w.getURL())).map(w=>({id:w.id,url:w.getURL()}))};})()`);
    if (identity?.pid !== pid || identity.executablePath !== executable || identity.appPath !== application
        || !identity.version?.startsWith('44.') || identity.targets?.length !== 1) throw Error('inspector_candidate_identity_mismatch');
    const owner = { runId:scenario.admissionBinding.runId,observerSHA256:sha256(installDesktopMainObserver.toString() + projectNoteObservation.toString() + snapshotSaveFields.toString() + SAVE_UI_SCRIPT),pid,executablePath:executable,appPath:application,webContentsId:identity.targets[0].id };
    if (readOnly) {
      const prior = await client.evaluate('globalThis.__scribeLabDesktopMainObserver?.describe() ?? null');
      if (prior === null && allowMissing) return missingDesktopObserver(client, owner.observerSHA256);
      if (!prior || ['runId', 'observerSHA256', 'pid', 'webContentsId'].some(key => prior[key] !== owner[key]))
        throw Error('desktop_recovery_observer_missing_or_changed');
    } else {
      installationAttempted = true;
      await client.evaluate(`(${installDesktopMainObserver.toString()})(${JSON.stringify(owner)}, (${projectNoteObservation.toString()}), (${snapshotSaveFields.toString()}), ${JSON.stringify(SAVE_UI_SCRIPT)})`);
    }
    const read = kind => client.evaluate(`globalThis.__scribeLabDesktopMainObserver.read(${JSON.stringify(kind)})`);
    const handle = { targetId:client.targetId, observerSHA256:owner.observerSHA256,
      identity: Object.freeze({ pid, executablePath: executable, appPath: application, processRow }),
      bindVisit:scope=>client.evaluate(`globalThis.__scribeLabDesktopMainObserver.bindVisit(${JSON.stringify(scope)})`), readCreated:()=>read('created'), currentVisit:()=>read('current'), readAdmission:()=>read('admission'), readRecording:()=>read('recording'), readTerminal:()=>read('terminal'),
      readClosed:()=>client.evaluate('globalThis.__scribeLabDesktopMainObserver.readClosed()'),
      readNote:action=>client.evaluate(`globalThis.__scribeLabDesktopMainObserver.readNote(${JSON.stringify(action)})`),
      readCurrentNote:()=>client.evaluate('globalThis.__scribeLabDesktopMainObserver.readCurrentNote()'),
      readSaveHandoff:()=>client.evaluate('globalThis.__scribeLabDesktopMainObserver.readSaveHandoff()'),
      readSaveFields:order=>client.evaluate(`globalThis.__scribeLabDesktopMainObserver.readSaveFields(${JSON.stringify(order)})`),
      readSaveUI:()=>client.evaluate('globalThis.__scribeLabDesktopMainObserver.readSaveUI()'),
      readAuth:()=>client.evaluate('globalThis.__scribeLabDesktopMainObserver.readAuth()'),
      readCurrentRecording:()=>client.evaluate('globalThis.__scribeLabDesktopMainObserver.readCurrentRecording()'),
      readPerformance:()=>client.evaluate('globalThis.__scribeLabDesktopMainObserver.readPerformance()'),
      recoverySnapshot:()=>client.evaluate('globalThis.__scribeLabDesktopMainObserver.recoverySnapshot()'),
      async close({ preserveForRecovery = false } = {}) { let result; try {
        result=await client.evaluate(preserveForRecovery
          ? 'globalThis.__scribeLabDesktopMainObserver?.retainForRecovery()'
          : 'globalThis.__scribeLabDesktopMainObserver?.uninstall()', {cleanup:true}); }
        catch { result={ownedResourcesSettled:false,observerRemoved:false}; } finally { client.close(); }
        liveObservers.delete(handle);
        return {...result,ownedResourcesSettled:result?.ownedResourcesSettled === true && !client.uncertain(),nativeAppTerminated:false}; } };
    liveObservers.set(handle, handle.readPerformance); return handle;
  } catch(error) {
    let removed = !installationAttempted;
    if(installationAttempted) { try { const result = await client.evaluate('globalThis.__scribeLabDesktopMainObserver?.uninstall()', {cleanup:true}); removed = result?.ownedResourcesSettled === true; } catch { removed = false; } }
    client.close();
    if (!removed || client.uncertain()) throw Object.assign(Error('desktop_observer_cleanup_uncertain', {cause:error}), {ownedResourcesSettled:false});
    throw error;
  }
}

/** A verified owned inspector with an actually absent observer. This handle never
 * installs or removes callbacks, and refuses a later observer instead of claiming it. */
export function missingDesktopObserver(client, observerSHA256) {
  if (!/^[a-f0-9]{64}$/.test(observerSHA256 ?? '')) throw Error('desktop_observer_identity_required');
  let closed = false;
  const readAbsent = async (options = {}) => {
    if (closed) throw Error('desktop_inspector_closed');
    const value = await client.evaluate('globalThis.__scribeLabDesktopMainObserver?.describe() ?? null', options);
    if (value !== null) throw Error('desktop_recovery_observer_appeared');
    return { descriptor: null, currentVisit: null, nativeObservation: null, currentNote: null };
  };
  return { targetId: client.targetId, observerSHA256, recoverySnapshot: () => readAbsent(), async close() {
    let absent = false;
    try { await readAbsent({ cleanup: true }); absent = true; }
    catch { /* A lost lookup or newly present observer is never treated as absence. */ }
    finally { closed = true; client.close(); }
    return { ownedResourcesSettled: absent && !client.uncertain(), observerRemoved: false, observerAbsent: absent, nativeAppTerminated: false };
  } };
}
