/** Lab-only observer of the existing, authorized Capacitor admission reply.
 * Inject into an owned debug WebView before the normal consent/preparation UI.
 * It does not create requests or retain tokens, attestation, body or audio URLs.
 */
export function installAdmissionObserver(binding, projectNoteObservation = null, observerSHA256 = null) {
  const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
  const ref = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[0-7][0-9a-hjkmnp-tv-z]{25}$`, "u").test(value);
  if (!uuid(binding?.runId) || !uuid(binding?.workspaceId) || !ref(binding?.appointmentRef, "appointment")) {
    throw new Error("owned synthetic admission binding is required");
  }
  binding = Object.freeze({ runId: binding.runId, workspaceId: binding.workspaceId, appointmentRef: binding.appointmentRef });
  const cap = window.Capacitor;
  if (!cap || typeof cap.nativePromise !== "function") throw new Error("native WebView bridge unavailable");
  if (window.__scribeLabAdmissionObserver) throw new Error("admission observer already installed");
  if (observerSHA256 !== null && !/^[a-f0-9]{64}$/.test(observerSHA256)) throw new Error("invalid observer identity");
  const original = cap.nativePromise;
  let pendingObservedReplies = 0;
  let receipt = null, recording = null, terminal = null, recorderId = null, mountRef = null, nativeRevision = 0, generation = 0;
  let recordingGeneration = 0, mutationPending = false;
  let notes = {}, noteRequests = {}, noteSession = null, noteGeneration = 0, currentNote = null, currentNoteRequest = null;
  let recordingOwner = null, closedLifecycle = null, captureMutationSequence = 0, currentScopeMatches = true;
  const invalidateLifecycle = (keepOwner = false) => {
    captureMutationSequence++; closedLifecycle = null;
    if (!keepOwner) recordingOwner = null;
  };
  // Exact metadata emitted by NativeProviderRecordingBridge/PCMSignalMonitor.
  // Unknown or malformed feedback is unavailable, never the previous sample.
  function signalProjection(envelope) {
    const value = envelope?.signal;
    if (envelope?.version !== 2 || !value || typeof value !== 'object') return null;
    const count = n => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647;
    const age = n => n === null || Number.isSafeInteger(n) && n >= 0 && n <= 86400000;
    const level = n => Number.isFinite(n) && n >= 0 && n <= 1;
    if (!count(value.inputBuffers) || !count(value.convertedBuffers)
        || typeof value.inputEverNonzero !== 'boolean' || typeof value.convertedEverNonzero !== 'boolean'
        || !level(value.inputLevel) || !level(value.convertedLevel)
        || !age(value.inputAgeMs) || !age(value.convertedAgeMs)
        || !Number.isSafeInteger(value.zeroInputMs) || value.zeroInputMs < 0 || value.zeroInputMs > 86400000
        || !['none', 'built_in', 'bluetooth', 'wired', 'usb', 'other'].includes(value.route)
        || typeof value.inputMuted !== 'boolean') return null;
    return Object.freeze({ version: 2, inputBuffers: value.inputBuffers, convertedBuffers: value.convertedBuffers,
      inputEverNonzero: value.inputEverNonzero, convertedEverNonzero: value.convertedEverNonzero,
      inputLevel: value.inputLevel, convertedLevel: value.convertedLevel,
      inputAgeMs: value.inputAgeMs, convertedAgeMs: value.convertedAgeMs,
      zeroInputMs: value.zeroInputMs, route: value.route, inputMuted: value.inputMuted });
  }
  const copyRecording = value => value ? { ...value, signal: value.signal ? { ...value.signal } : null } : null;
  function wrapped(plugin, method, options, ...rest) {
    // The app receives the exact original promise and result.
    let result;
    try { result = original.call(this, plugin, method, options, ...rest); }
    catch (error) {
      if (plugin === 'CosmasWorkspaceAuth' && method === 'providerRequest'
          && ['capture-notes', 'note-opening'].includes(options?.action)) {
        notes = {}; noteRequests = {}; noteSession = null; noteGeneration++; currentNote = currentNoteRequest = null;
      }
      if (plugin === 'CosmasWorkspaceAuth' && (method === 'openProviderRecording'
          || method === 'providerRecordingCommand' && options?.kind !== 'read'
          || method === 'providerRequest' && options?.action === 'capture-admissions')) {
        invalidateLifecycle(); recording = terminal = null; recordingGeneration++; mutationPending = false;
      }
      throw error;
    }
    if (plugin === 'CosmasWorkspaceAuth') {
      pendingObservedReplies++;
      void Promise.resolve(result).then(() => { pendingObservedReplies--; }, () => { pendingObservedReplies--; });
    }
    if (plugin === 'CosmasWorkspaceAuth' && method === 'providerRequest' && ['capture-notes', 'note-opening'].includes(options?.action)
        && currentScopeMatches
        && typeof projectNoteObservation === 'function') {
      // Even an unreadable latest request retires prior note evidence. The real
      // native bridge, not our parser, decides whether that request had effects.
      notes = {}; noteRequests = {}; noteSession = null; currentNote = currentNoteRequest = null;
      const armed = ++noteGeneration;
      let request;
      try { if (typeof options.body !== 'string' || options.body.length > 270336) return result;
        const body = JSON.parse(options.body);
        request = { action: body.action, expected_session_id: body.expected_session_id, workspace_id: body.workspace_id,
          binding_ref: body.binding_ref, request_nonce: body.request_nonce,
          ...(options.action === 'note-opening' ? { transportAction: 'note_opening' } : {}) };
        const action = options.action === 'note-opening' ? 'read' : request.action;
        if (noteSession !== request.expected_session_id) { notes = {}; noteRequests = {}; }
        noteSession = request.expected_session_id;
        delete notes[action]; noteRequests[action] = options.requestId; } catch { return result; }
      const requestId = options.requestId, revision = options.revision;
      const action = request.transportAction === 'note_opening' ? 'read' : request.action;
      currentNote = null; currentNoteRequest = requestId;
      void Promise.resolve(result).then(response => {
        try {
          if (armed !== noteGeneration || !currentScopeMatches || noteRequests[action] !== requestId
              || response?.status !== 200 || response.requestId !== requestId
              || response.revision !== revision || typeof response.body !== 'string' || response.body.length > 4194304) return;
          const note = projectNoteObservation(request, JSON.parse(response.body), binding);
          if (note) { notes[note.action] = note; if (currentNoteRequest === requestId) currentNote = note; }
        } catch { /* Never alter the original note request. */ }
      }).catch(() => undefined);
      return result;
    }
    if (plugin === "CosmasWorkspaceAuth" && ["openProviderRecording", "providerRecordingCommand"].includes(method)) {
      if (method === 'providerRecordingCommand' && options?.kind === 'close') {
        const selected = recordingOwner, priorClosed = closedLifecycle;
        invalidateLifecycle(true);
        const sequence = captureMutationSequence;
        recording = terminal = null; recordingGeneration++; mutationPending = true;
        void Promise.resolve(result).then(reply => {
          if (sequence !== captureMutationSequence) return;
          mutationPending = false;
          if (!selected || options.recorderId !== selected.recorderId || options.revision !== selected.authRevision
              || !uuid(options.requestId) || reply?.requestId !== options.requestId || reply.ok !== true
              || reply.recording !== null || Object.keys(reply).sort().join() !== 'ok,recording,requestId') return;
          // A repeated idempotent close confirms the same absorbing lifecycle;
          // it must not turn its original physical-close timestamp into "now".
          const sameClosed = priorClosed && ['sessionId', 'recorderId', 'authRevision'].every(key => priorClosed[key] === selected[key]);
          closedLifecycle = Object.freeze(sameClosed ? { ...priorClosed, captureMutationSequence: sequence }
            : { source: 'normal-native-recorder-close-response', ...binding,
            sessionId: selected.sessionId, recorderId: selected.recorderId, authRevision: selected.authRevision,
            recordingSource: 'normal-native-recording-response', nativeRevisionBeforeClose: selected.nativeRevision,
            closeRequestId: options.requestId, closeMethod: 'close', phase: 'closed', captureMutationSequence: sequence,
            observedAtMonotonicMs: performance.now(), browserTimeOriginMs: performance.timeOrigin });
        }, () => { if (sequence === captureMutationSequence) mutationPending = false; });
        return result;
      }
      if (method === 'openProviderRecording' || options?.kind !== 'read') invalidateLifecycle(method !== 'openProviderRecording');
      const armed = generation, admitted = receipt;
      if (!admitted || options?.revision !== admitted.revision || !uuid(options?.requestId)
        || (method === "openProviderRecording" ? options.sessionId !== admitted.sessionId
          || options.workspaceId !== binding.workspaceId || options.bindingRef !== mountRef
          : options.recorderId !== recorderId)) {
        recording = terminal = null;
        return result;
      }
      // A pending mutation must not leave a previous Recording receipt visible.
      const mutation = method === "openProviderRecording" || options.kind !== "read";
      if (mutation) { recording = terminal = null; recordingGeneration += 1; mutationPending = true; }
      const commandGeneration = recordingGeneration;
      void Promise.resolve(result).then(reply => {
        try {
          if (armed !== generation || receipt !== admitted || commandGeneration !== recordingGeneration
            || (!mutation && mutationPending)) return;
          if (mutation) mutationPending = false;
          if (reply?.requestId !== options.requestId || reply.ok !== true
              || Object.keys(reply).sort().join() !== 'ok,recording,requestId') { recording = terminal = null; return; }
          const state = reply.recording;
          if (state?.sessionId !== admitted.sessionId || !uuid(state?.recorderId)
            || (method === "providerRecordingCommand" && state.recorderId !== options.recorderId)) {
            recording = terminal = null;
            return;
          }
          if (state.version !== 1
            || !Number.isSafeInteger(state.revision) || state.revision < 1
            || state.revision < nativeRevision
            || !["unopened", "opening", "ready", "starting", "recording", "pausing", "paused", "stopPending",
              "sealing", "sealed", "failed", "closed"].includes(state.phase)
            || typeof state.busy !== "boolean" || !["built_in", "bluetooth", "external"].includes(state.input)
            || !Number.isSafeInteger(state.recordedChunks) || state.recordedChunks < 0 || state.recordedChunks > 2048
            || !Number.isSafeInteger(state.recordedPlaintextBytes) || state.recordedPlaintextBytes < 0
            || state.recordedPlaintextBytes > 402653184) { recording = null; return; }
          const frames = state.capturedAudioFrames;
          if (frames !== undefined && (!Number.isSafeInteger(frames) || frames < 0 || frames > 327680000)) { recording = null; return; }
          recorderId = state.recorderId; nativeRevision = state.revision;
          recordingOwner = { sessionId: admitted.sessionId, recorderId, nativeRevision, authRevision: admitted.revision };
          recording = Object.freeze({ source: "normal-native-recording-response", runId: binding.runId,
            workspaceId: binding.workspaceId, appointmentRef: binding.appointmentRef,
            sessionId: admitted.sessionId, recorderId: state.recorderId, nativeRevision: state.revision,
            phase: state.phase, busy: state.busy, recordedChunks: state.recordedChunks,
            recordedPlaintextBytes: state.recordedPlaintextBytes, input: state.input,
            ...(frames === undefined ? {} : { capturedAudioFrames: frames }),
            signal: signalProjection(state.signal),
            observedAtMonotonicMs: performance.now(), browserTimeOriginMs: performance.timeOrigin });
          // Historical physical-stop evidence remains readable while the model
          // is running. It is never used as a fresh Recording observation.
          if (state.phase === "sealed" && !state.busy) terminal ??= recording;
        } catch { /* Never change native recording behavior. */ }
      }).catch(() => {
        if (armed === generation && commandGeneration === recordingGeneration) {
          recording = null; if (mutation) mutationPending = false;
        }
      });
      return result;
    }
    if (plugin !== "CosmasWorkspaceAuth" || method !== "providerRequest" || options?.action !== "capture-admissions") return result;
    // A parser failure cannot prove that the real bridge did not admit another
    // session. Retire prior custody evidence on every attempted admission.
    generation += 1; recordingGeneration += 1; mutationPending = false;
    invalidateLifecycle();
    receipt = null; recording = terminal = null; recorderId = null; mountRef = null; nativeRevision = 0;
    const sentAt = performance.now();
    let request;
    try {
      if (typeof options.body !== "string" || options.body.length > 8192) return result;
      request = JSON.parse(options.body);
      if (!uuid(options.requestId) || !uuid(options.revision) || !uuid(request.request_nonce)
        || typeof request.binding_ref !== "string" || !request.binding_ref || request.binding_ref.length > 2048
        || request.workspace_id !== binding.workspaceId) return result;
    } catch { return result; }
    const armed = generation;
    void Promise.resolve(result).then(response => {
      try {
        if (armed !== generation || response?.status !== 200 || response.requestId !== options.requestId
          || response.revision !== options.revision || typeof response.body !== "string" || response.body.length > 8192) return;
        const body = JSON.parse(response.body);
        if (body.status !== "admitted" || body.appointment_ref !== binding.appointmentRef
          || body.workspace_id !== binding.workspaceId || body.request_nonce !== request.request_nonce
          || body.binding_ref !== request.binding_ref
          || !uuid(body.consent_record_id) || !uuid(body.session_id) || !ref(body.operation_ref, "scribe_admission")) return;
        recording = null; recorderId = null; nativeRevision = 0; mountRef = request.binding_ref;
        receipt = Object.freeze({ source: "normal-native-admission-response", runId: binding.runId,
          appointmentRef: body.appointment_ref, workspaceId: body.workspace_id,
          requestId: options.requestId, revision: options.revision, requestNonce: request.request_nonce,
          consentRecordId: body.consent_record_id, sessionId: body.session_id, operationRef: body.operation_ref,
          sentAtMonotonicMs: sentAt, observedAtMonotonicMs: performance.now(),
          browserTimeOriginMs: performance.timeOrigin });
      } catch { /* Observation can never affect the product request. */ }
    }).catch(() => undefined);
    return result;
  }
  cap.nativePromise = wrapped;
  window.__scribeLabAdmissionObserver = Object.freeze({
    describe() { return { ...binding, observerSHA256, pendingObservedReplies }; },
    clear({ reason = 'auth' } = {}) { generation += 1; recordingGeneration += 1; mutationPending = false;
      currentScopeMatches = false;
      if (reason !== 'navigation') invalidateLifecycle();
      notes = {}; noteRequests = {}; noteSession = null; noteGeneration++; currentNote = currentNoteRequest = null;
      receipt = null; recording = terminal = null; recorderId = null; mountRef = null; nativeRevision = 0; },
    rebindCurrent(scope) {
      currentScopeMatches = ['runId', 'workspaceId', 'appointmentRef'].every(key => scope?.[key] === binding[key]);
      if (!currentScopeMatches || recordingOwner && scope.revision !== recordingOwner.authRevision) invalidateLifecycle();
      return currentScopeMatches;
    },
    readClosed() { return closedLifecycle ? { ...closedLifecycle, currentCaptureMutationSequence: captureMutationSequence,
      inspectedAtMonotonicMs: performance.now(), pendingObservedReplies } : null; },
    read() {
      if (!receipt || performance.now() - receipt.observedAtMonotonicMs > 120000) return null;
      return { ...receipt };
    },
    readRecording() {
      if (!recording || performance.now() - recording.observedAtMonotonicMs > 15000) return null;
      return copyRecording(recording);
    },
    readTerminal() { return copyRecording(terminal); },
    readNote(action) { return notes[action] ? { ...notes[action] } : null; },
    readCurrentNote() { return currentNote ? { ...currentNote } : null; },
    uninstall() {
      if (cap.nativePromise !== wrapped || pendingObservedReplies !== 0) return { ownedResourcesSettled: false, observerRemoved: false };
      generation += 1; receipt = null; recording = terminal = null; recorderId = null; mountRef = null; nativeRevision = 0;
      invalidateLifecycle(); currentScopeMatches = false;
      notes = {}; noteRequests = {}; noteSession = null; noteGeneration++; currentNote = currentNoteRequest = null;
      recordingGeneration += 1; mutationPending = false;
      if (cap.nativePromise === wrapped) cap.nativePromise = original;
      delete window.__scribeLabAdmissionObserver;
      return { ownedResourcesSettled: true, observerRemoved: true };
    },
  });
  return { installed: true, runId: binding.runId };
}
