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
  function wrapped(plugin, method, options, ...rest) {
    // The app receives the exact original promise and result.
    const result = original.call(this, plugin, method, options, ...rest);
    if (plugin === 'CosmasWorkspaceAuth') {
      pendingObservedReplies++;
      void Promise.resolve(result).then(() => { pendingObservedReplies--; }, () => { pendingObservedReplies--; });
    }
    if (plugin === 'CosmasWorkspaceAuth' && method === 'providerRequest' && options?.action === 'capture-notes'
        && typeof projectNoteObservation === 'function') {
      const armed = noteGeneration;
      let request;
      try { if (typeof options.body !== 'string' || options.body.length > 270336) return result;
        const body = JSON.parse(options.body);
        request = { action: body.action, expected_session_id: body.expected_session_id, workspace_id: body.workspace_id,
          binding_ref: body.binding_ref, request_nonce: body.request_nonce };
        if (noteSession !== request.expected_session_id) { notes = {}; noteRequests = {}; }
        noteSession = request.expected_session_id;
        delete notes[request.action]; noteRequests[request.action] = options.requestId; } catch { return result; }
      const requestId = options.requestId, revision = options.revision;
      currentNote = null; currentNoteRequest = requestId;
      void Promise.resolve(result).then(response => {
        try {
          if (armed !== noteGeneration || noteRequests[request.action] !== requestId
              || response?.status !== 200 || response.requestId !== requestId
              || response.revision !== revision || typeof response.body !== 'string' || response.body.length > 4194304) return;
          const note = projectNoteObservation(request, JSON.parse(response.body), binding);
          if (note) { notes[note.action] = note; if (currentNoteRequest === requestId) currentNote = note; }
        } catch { /* Never alter the original note request. */ }
      }).catch(() => undefined);
      return result;
    }
    if (plugin === "CosmasWorkspaceAuth" && ["openProviderRecording", "providerRecordingCommand"].includes(method)) {
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
      void Promise.resolve(result).then(state => {
        try {
          if (armed !== generation || receipt !== admitted || commandGeneration !== recordingGeneration
            || (!mutation && mutationPending)) return;
          if (mutation) mutationPending = false;
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
          recording = Object.freeze({ source: "normal-native-recording-response", runId: binding.runId,
            workspaceId: binding.workspaceId, appointmentRef: binding.appointmentRef,
            sessionId: admitted.sessionId, recorderId: state.recorderId, nativeRevision: state.revision,
            phase: state.phase, busy: state.busy, recordedChunks: state.recordedChunks,
            recordedPlaintextBytes: state.recordedPlaintextBytes, input: state.input,
            ...(frames === undefined ? {} : { capturedAudioFrames: frames }),
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
    const sentAt = performance.now();
    let request;
    try {
      if (typeof options.body !== "string" || options.body.length > 8192) return result;
      request = JSON.parse(options.body);
      if (!uuid(options.requestId) || !uuid(options.revision) || !uuid(request.request_nonce)
        || typeof request.binding_ref !== "string" || !request.binding_ref || request.binding_ref.length > 2048
        || request.workspace_id !== binding.workspaceId) return result;
    } catch { return result; }
    generation += 1; recordingGeneration += 1; mutationPending = false;
    receipt = null; recording = terminal = null; recorderId = null; mountRef = null; nativeRevision = 0;
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
    clear() { generation += 1; recordingGeneration += 1; mutationPending = false;
      notes = {}; noteRequests = {}; noteSession = null; noteGeneration++; currentNote = currentNoteRequest = null;
      receipt = null; recording = terminal = null; recorderId = null; mountRef = null; nativeRevision = 0; },
    read() {
      if (!receipt || performance.now() - receipt.observedAtMonotonicMs > 120000) return null;
      return { ...receipt };
    },
    readRecording() {
      if (!recording || performance.now() - recording.observedAtMonotonicMs > 15000) return null;
      return { ...recording };
    },
    readTerminal() { return terminal ? { ...terminal } : null; },
    readNote(action) { return notes[action] ? { ...notes[action] } : null; },
    readCurrentNote() { return currentNote ? { ...currentNote } : null; },
    uninstall() {
      if (cap.nativePromise !== wrapped || pendingObservedReplies !== 0) return { ownedResourcesSettled: false, observerRemoved: false };
      generation += 1; receipt = null; recording = terminal = null; recorderId = null; mountRef = null; nativeRevision = 0;
      notes = {}; noteRequests = {}; noteSession = null; noteGeneration++; currentNote = currentNoteRequest = null;
      recordingGeneration += 1; mutationPending = false;
      if (cap.nativePromise === wrapped) cap.nativePromise = original;
      delete window.__scribeLabAdmissionObserver;
      return { ownedResourcesSettled: true, observerRemoved: true };
    },
  });
  return { installed: true, runId: binding.runId };
}
