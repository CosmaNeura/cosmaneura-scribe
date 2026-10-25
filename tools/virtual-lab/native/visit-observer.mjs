/** Passive, owned iOS lab scope observation. No requests, patient text or authority retained. */
export function installVisitScopeObserver({ runId }) {
  const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
  const appointment = value => typeof value === "string" && /^appointment_[0-7][0-9a-hjkmnp-tv-z]{25}$/u.test(value);
  const cap = window.Capacitor;
  if (!uuid(runId) || typeof cap?.nativePromise !== "function" || typeof cap?.fromNative !== "function"
    || window.__scribeLabVisitObserver) throw new Error("owned native scope observer unavailable");
  const original = cap.nativePromise, originalFromNative = cap.fromNative;
  let current = null, created = null, revision = null, generation = 0, alive = true, authCheckedAt = 0;
  const invalidate = (auth = false) => {
    generation += 1; current = null;
    if (auth) { created = null; revision = null; authCheckedAt = 0; }
    window.__scribeLabAdmissionObserver?.clear();
  };
  const auth = state => {
    if (!alive) return;
    if (!uuid(state?.revision) || state.phase !== "ready") { invalidate(true); return; }
    if (revision !== null && revision !== state.revision) invalidate(true);
    revision = state.revision; authCheckedAt = performance.now();
  };
  function fromNative(result, ...rest) {
    try {
      // Native envelopes identify the plugin/method even for already-registered listeners.
      if (result?.pluginId === "CosmasWorkspaceAuth"
        && ["addListener", "getState", "getProviderState", "signIn", "signOut"].includes(result.methodName)
        && (result.data?.phase !== undefined || result.methodName !== "addListener")) {
        if (result.success === true) auth(result.data); else invalidate(true);
      }
    } catch { /* The original native delivery is always preserved. */ }
    return originalFromNative.call(this, result, ...rest);
  }
  function wrapped(plugin, method, options, ...rest) {
    if (alive && plugin === "CosmasWorkspaceAuth" && ["signIn", "signOut"].includes(method)) invalidate(true);
    const result = original.call(this, plugin, method, options, ...rest);
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
        if (creating) created = scope; else current = scope;
      } catch { /* Never change the product response. */ }
    }).catch(() => undefined);
    return result;
  }
  cap.nativePromise = wrapped; cap.fromNative = fromNative;
  window.__scribeLabVisitObserver = Object.freeze({
    describe() { return { runId }; },
    readCreated() { return created && { ...created }; },
    readCurrent() { return current && performance.now() - authCheckedAt <= 15000 ? { ...current } : null; },
    clear() { invalidate(true); },
    uninstall() {
      if (cap.nativePromise !== wrapped || cap.fromNative !== fromNative)
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
