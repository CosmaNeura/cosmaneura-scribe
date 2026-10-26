/** Passive, owned iOS lab scope observation. No requests, patient text or authority retained. */
export function installVisitScopeObserver({ runId, observerSHA256 = null }) {
  const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
  const appointment = value => typeof value === "string" && /^appointment_[0-7][0-9a-hjkmnp-tv-z]{25}$/u.test(value);
  const cap = window.Capacitor;
  if (!uuid(runId) || typeof cap?.nativePromise !== "function" || typeof cap?.fromNative !== "function"
    || window.__scribeLabVisitObserver) throw new Error("owned native scope observer unavailable");
  const original = cap.nativePromise, originalFromNative = cap.fromNative;
  if (observerSHA256 !== null && !/^[a-f0-9]{64}$/.test(observerSHA256)) throw new Error("invalid observer identity");
  let pendingObservedReplies = 0;
  let current = null, created = null, revision = null, generation = 0, alive = true, authCheckedAt = 0;
  let authObservation = null, authSequence = 0, authMutationsPending = 0;
  let noteHandoff = null, handoffGeneration = 0;
  const userId = value => typeof value === "string" && /^user_[A-Za-z0-9_]{1,250}$/u.test(value);
  const invalidate = (auth = false) => {
    generation += 1; current = null; noteHandoff = null; handoffGeneration++;
    if (auth) { authSequence++; created = null; revision = null; authCheckedAt = 0; authObservation = null; }
    window.__scribeLabAdmissionObserver?.clear({ reason: auth ? 'auth' : 'navigation' });
  };
  const auth = state => {
    if (!alive) return;
    if (!uuid(state?.revision) || state.phase !== "ready") { invalidate(true); return; }
    if (revision !== null && revision !== state.revision) invalidate(true);
    if (authObservation && authObservation.userId !== state.identity?.userId) invalidate(true);
    revision = state.revision; authCheckedAt = performance.now();
    authObservation = authMutationsPending === 0 && userId(state.identity?.userId)
      ? Object.freeze({ source: "normal-native-auth-response", runId, phase: "ready", revision,
        userId: state.identity.userId, observedAtMonotonicMs: performance.now(), browserTimeOriginMs: performance.timeOrigin }) : null;
  };
  function fromNative(result, ...rest) {
    try {
      // Native envelopes identify the plugin/method even for already-registered listeners.
      if (result?.pluginId === "CosmasWorkspaceAuth"
        && result.methodName === "addListener" && result.data?.phase !== undefined) {
        // Promise replies are observed below with request ordering. An auth event
        // retires older pending polls before the original listener sees it.
        authSequence++;
        if (result.success === true) auth(result.data); else invalidate(true);
      }
    } catch { /* The original native delivery is always preserved. */ }
    return originalFromNative.call(this, result, ...rest);
  }
  function wrapped(plugin, method, options, ...rest) {
    const sentAt = performance.now();
    const mounting = plugin === 'CosmasWorkspaceAuth' && method === 'providerRequest' && options?.action === 'mount';
    // Retain only the acknowledged note immediately preceding a normal mount.
    // This is not a Save observation: the coordinator must separately prove the
    // actual Save click, field hash and completed product UI transition.
    const priorScope = mounting && current ? { ...current } : null;
    let priorNote = null;
    try { if (mounting) priorNote = window.__scribeLabAdmissionObserver?.readCurrentNote?.(); }
    catch { /* Missing observer metadata must never prevent the product mount. */ }
    if (plugin === 'CosmasWorkspaceAuth' && (method === 'providerRequest'
      || ['openProviderRecording', 'providerRecordingCommand'].includes(method))) { noteHandoff = null; handoffGeneration++; }
    const isAuth = alive && plugin === "CosmasWorkspaceAuth" && ["getState", "getProviderState", "signIn", "signOut"].includes(method);
    const mutation = isAuth && ["signIn", "signOut"].includes(method);
    if (mutation) { invalidate(true); authMutationsPending++; }
    const authRequest = isAuth ? ++authSequence : null;
    let result;
    try { result = original.call(this, plugin, method, options, ...rest); }
    catch (error) {
      if (mutation) authMutationsPending--;
      if (isAuth && authRequest === authSequence) invalidate(true);
      throw error;
    }
    if (isAuth) void Promise.resolve(result).then(state => {
      if (mutation) authMutationsPending--;
      if (alive && authRequest === authSequence) auth(state);
    }, () => {
      if (mutation) authMutationsPending--;
      if (alive && authRequest === authSequence) invalidate(true);
    });
    if (plugin === 'CosmasWorkspaceAuth') {
      pendingObservedReplies++;
      void Promise.resolve(result).then(() => { pendingObservedReplies--; }, () => { pendingObservedReplies--; });
    }
    if (!alive || plugin !== "CosmasWorkspaceAuth" || method !== "providerRequest"
      || !["encounters", "mount"].includes(options?.action)) return result;
    let request;
    try {
      if (typeof options.body !== "string" || options.body.length > 16384
        || !uuid(options.requestId) || !uuid(options.revision)) return result;
      request = JSON.parse(options.body);
      if (options.action === "encounters" && (request.action !== "create" || !uuid(request.creation_key))) return result;
      if (options.action === "mount" && !uuid(request.workspace_id)) return result;
    } catch { return result; }
    invalidate();
    const handoffArmed = handoffGeneration;
    if (options.action === "encounters") created = null;
    const armed = generation;
    void Promise.resolve(result).then(response => {
      try {
        if (!alive || armed !== generation || response?.status !== 200
          || response.requestId !== options.requestId || response.revision !== options.revision
          || typeof response.body !== "string" || response.body.length > 65536) return;
        const body = JSON.parse(response.body);
        if (body.revision !== options.revision) return;
        const creating = options.action === "encounters", item = creating ? body.encounter : body;
        const workspaceId = creating ? item?.workspace_id : item?.workspaceId;
        const appointmentRef = creating ? item?.appointment_ref : item?.appointmentRef;
        if (!uuid(workspaceId) || !appointment(appointmentRef)
          || (creating ? body.creation_key !== request.creation_key : workspaceId !== request.workspace_id)) return;
        if (revision !== null && revision !== response.revision) { invalidate(true); return; }
        revision = response.revision; authCheckedAt = performance.now();
        const scope = Object.freeze({ source: creating ? "normal-native-created-visit-response" : "normal-native-mount-response",
          runId, workspaceId, appointmentRef, revision, requestId: options.requestId,
          observedAtMonotonicMs: performance.now(), browserTimeOriginMs: performance.timeOrigin });
        if (creating) created = scope;
        else {
          current = scope; window.__scribeLabAdmissionObserver?.rebindCurrent(scope);
          if (handoffArmed === handoffGeneration && priorScope?.revision === scope.revision && priorNote?.source === 'normal-core-note-response'
              && ['runId', 'workspaceId', 'appointmentRef'].every(key => priorScope[key] === scope[key] && priorNote[key] === scope[key])) {
            const note = Object.fromEntries(['source', 'runId', 'workspaceId', 'appointmentRef', 'action', 'transportAction',
              'session_id', 'note_ref', 'transcript_ref', 'schema_ref', 'note_sha256', 'source_sha256', 'requestNonce',
              'status', 'observedAtMonotonicMs', 'browserTimeOriginMs'].filter(key => priorNote[key] !== undefined).map(key => [key, priorNote[key]]));
            note.field_order = Array.isArray(priorNote.field_order) ? [...priorNote.field_order] : null;
            noteHandoff = { ...scope, source: 'normal-native-note-mount-handoff',
              requestedAtMonotonicMs: sentAt, note };
          }
        }
      } catch { /* Never change the product response. */ }
    }).catch(() => undefined);
    return result;
  }
  cap.nativePromise = wrapped; cap.fromNative = fromNative;
  window.__scribeLabVisitObserver = Object.freeze({
    describe() { return { runId, observerSHA256, pendingObservedReplies }; },
    readAuth() {
      return authObservation && authMutationsPending === 0 && performance.now() - authObservation.observedAtMonotonicMs >= 0
        && performance.now() - authObservation.observedAtMonotonicMs <= 15000 ? { ...authObservation } : null;
    },
    readCreated() { return created && { ...created }; },
    readCurrent() { return current && performance.now() - authCheckedAt <= 15000 ? { ...current } : null; },
    readNoteHandoff() { return noteHandoff && current?.requestId === noteHandoff.requestId
      && current.revision === revision && performance.now() - authCheckedAt <= 15000
      ? { ...noteHandoff, note: { ...noteHandoff.note, field_order: noteHandoff.note.field_order && [...noteHandoff.note.field_order] },
        pendingObservedReplies } : null; },
    clear() { invalidate(true); },
    uninstall() {
      if (cap.nativePromise !== wrapped || cap.fromNative !== fromNative || pendingObservedReplies !== 0)
        return { ownedResourcesSettled: false, observerRemoved: false };
      invalidate(true); alive = false;
      if (cap.nativePromise === wrapped) cap.nativePromise = original;
      if (cap.fromNative === fromNative) cap.fromNative = originalFromNative;
      delete window.__scribeLabVisitObserver;
      return { ownedResourcesSettled: true, observerRemoved: true };
    },
  });
  return { installed: true, runId };
}
