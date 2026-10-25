// Actual shared workspace and durable encounter owner with synthetic local ports.
// No account, network, audio, or installed app is used.
/* global document, window */
const platform = new URL(window.location.href).searchParams.get("platform");
const layout = new URL(window.location.href).searchParams.has("layout");
if (platform === "ios") {
  window.CapacitorCustomPlatform = { name: "ios" };
  window.Capacitor = {
    PluginHeaders: [{ name: "IOSPCM", methods: ["selectMicrophoneInput", "getCaptureSignal"].map(name => ({ name, rtype: "promise" })) }],
    async nativePromise(plugin, method, options) {
      if (plugin !== "IOSPCM") throw new Error("Unexpected native fixture call");
      if (method === "getCaptureSignal") return null;
      if (method !== "selectMicrophoneInput") throw new Error("Unexpected native fixture method");
      return { version: 1, input: options.input };
    },
  };
}
const { mountProviderWorkspace } = await import("../../src/provider-entry.ts");
const { createEncounterSetup } = await import("../../src/provider/encounter-setup.ts");
const { encryptedFixturePlugin } = await import("./encrypted-plugin.mjs");
const abort = new AbortController(), scope = {
  workspaceId: "20000000-0000-4000-8000-000000000002",
  appointmentRef: "appointment_01j00000000000000000000000",
  bindingRef: "scribe_capture_binding_01j00000000000000000000000",
};
const sessionId = "10000000-0000-4000-8000-000000000001";
const account = { email: "provider@synthetic.invalid", environment: "Staging" };
const encounter = { appointmentRef: scope.appointmentRef, title: "Synthetic walk-in", detail: `Visit · ${new Date().toISOString()}`,
  patientRef: "patient_01j00000000000000000000000", dateOfBirth: null };
if (layout) {
  encounter.detail = `Visit · ${new Date().toISOString()}`;
  if (new URL(window.location.href).searchParams.has("known-dob")) encounter.dateOfBirth = "1980-01-02";
  // Reserve the actual desktop header's space while keeping this fixture's
  // workspace ports synthetic; no account application is mounted.
  await import("../../src/provider/application.css");
  document.body.classList.add("provider-application");
  document.body.style.margin = "0";
  document.querySelector("#provider").insertAdjacentHTML("beforebegin", '<header class="provider-session-header"><div class="provider-brand"><span class="provider-brand-icon" aria-hidden="true"></span><strong>Scribe</strong></div><button class="scribe-desktop-close" disabled>Close Scribe</button></header>');
}
const plugin = await encryptedFixturePlugin(scope.workspaceId);
const forbidden = () => { throw new Error("Outside the synthetic DOB fixture"); };
const fixture = window.dobLab = { creates: [], starts: 0, admissions: 0, admissionRequests: [], dobUpdates: [], openedRefs: [], closes: 0 };
let admissionCommitted = false;
const listGate = new Promise(resolve => { fixture.releaseList = resolve; });
const gatedAdmission = new URL(window.location.href).searchParams.has("gate-admission");
const admissionGate = new Promise(resolve => { fixture.releaseAdmission = resolve; });
const journalGate = new Promise(resolve => { fixture.releaseJournal = resolve; });
const recorderGate = new Promise(resolve => { fixture.releaseRecorder = resolve; });
fixture.recorderCalls = 0;
const recents = new URL(window.location.href).searchParams.has("recents");
fixture.catalog = recents ? [encounter] : [];
fixture.listCalls = 0;
fixture.reviewStatus = "created";
const setup = createEncounterSetup({
  current: signal => { if (abort.signal.aborted || signal?.aborted) throw new Error("closed"); },
  records: async () => ({ records: plugin, close: async () => {} }), created: () => {},
  request: async body => {
    const base = { action: body.action, account, recoveryScope: scope.workspaceId };
    if (body.action === "patients") return { ...base, patients: new URL(window.location.href).searchParams.has("existing") ? [
      { patient_ref: encounter.patientRef, name: "Synthetic walk-in", date_of_birth: "1980-01-02" },
      { patient_ref: "patient_01j00000000000000000000001", name: "Synthetic walk-in", date_of_birth: "1985-03-04" },
    ] : [], more_results: false };
    fixture.creates.push(body);
    encounter.patientRef = body.patient.kind === "existing" ? body.patient.patient_ref : encounter.patientRef;
    return { ...base, creation_key: body.creation_key, encounter: { workspace_id: scope.workspaceId,
      appointment_ref: scope.appointmentRef, patient_ref: encounter.patientRef,
      patient_name: body.patient.kind === "new" ? body.patient.name : "Synthetic walk-in",
      title: "Visit", appointment_at: new Date().toISOString() } };
  },
});
let saved = { revision: null, progress: null };
const microphoneId = "60000000-0000-4000-8000-000000000006";
const inputDevices = [{ id: microphoneId, label: "MacBook Pro Microphone", kind: "built_in", current: true },
  { id: "70000000-0000-4000-8000-000000000007", label: "Synthetic USB Microphone", kind: "external", current: false }];
let snapshot = { sessionId, state: "ready", statusCode: "capture_ready", recordedChunks: 0, queuedChunks: 0,
  elapsedSeconds: 0, remainingBudgetSeconds: 10_800, remainingAuthoritySeconds: 900,
  transcriptionStatus: null, transcript: null,
  ...(layout ? { inputDevices, selectedInputId: microphoneId } : {}),
  ...(platform === "ios" && recents ? { native: { phase: "ready", busy: false } } : {}),
  ...(platform === "desktop" ? { desktop: { phase: "ready", audioMode: "microphone", coverage: "not_started", trimmedStartMs: 0, trimmedEndMs: null } } : {}) };
const listeners = new Set();
const meetingId = "30000000-0000-4000-8000-000000000003";
let preflight = { status: "ready", inputDevices: layout ? inputDevices : [], selectedInputId: layout ? microphoneId : null, microphone: null,
  desktopAudio: "microphone", meetingWindows: { state: "ready", selectedId: new URL(window.location.href).searchParams.has("unselected-call") ? null : meetingId,
    windows: [{ id: meetingId, title: "Zoom — Synthetic visit" }] } };
const preflightListeners = new Set();
const publishPreflight = () => { for (const listener of preflightListeners) listener(preflight); };
fixture.emit = update => { snapshot = { ...snapshot, ...update }; for (const listener of listeners) listener(snapshot); };
fixture.signOut = () => abort.abort();
fixture.ready = () => fixture.emit({ state: "ready", statusCode: "capture_ready",
  desktop: { ...snapshot.desktop, phase: "ready" } });
mountProviderWorkspace(document.querySelector("#provider"), {
  ...(layout ? {
    consentPreparation: { enabled: true, owner: "John Clemente", cohort: "internal", expires: "2026-11-01" },
    audioPreflight: async () => ({
      getSnapshot: () => preflight,
      subscribe: listener => { preflightListeners.add(listener); listener(preflight); return () => preflightListeners.delete(listener); },
      selectMicrophone: async selectedInputId => {
        if (!inputDevices.some(input => input.id === selectedInputId)) forbidden();
        preflight = { ...preflight, selectedInputId, inputDevices: inputDevices.map(input => ({ ...input, current: input.id === selectedInputId })) };
        publishPreflight();
      },
      selectDesktopAudio: async desktopAudio => { preflight = { ...preflight, desktopAudio }; publishPreflight(); },
      selectMeetingWindow: async selectedId => { preflight = { ...preflight, meetingWindows: { ...preflight.meetingWindows, selectedId } }; publishPreflight(); },
      refreshMeetingWindows: async () => {},
      close: async () => {},
    }),
  } : {}),
  signal: abort.signal, account, encounterSetup: { ...setup,
    async addDateOfBirth(selected, date, key, signal) {
      if (signal.aborted || selected.appointmentRef !== encounter.appointmentRef || selected.patientRef !== encounter.patientRef) throw new Error("DOB scope denied");
      fixture.dobUpdates.push({ date, key, appointmentRef: selected.appointmentRef });
      if (new URL(window.location.href).searchParams.has("lose-dob") && fixture.dobUpdates.length === 1) throw new Error("Synthetic lost response");
      return { ...encounter, dateOfBirth: date };
    },
  },
  listEncounters: async () => {
    fixture.listCalls++;
    if (layout && new URL(window.location.href).searchParams.has("wait-list")) await listGate;
    return fixture.catalog;
  }, createEncounter: forbidden,
  openEncounter: async ref => {
    fixture.openedRefs.push(ref);
    if (layout && fixture.failOpen) throw new Error("Synthetic private connection detail");
    return ({ encounter, scope, signal: abort.signal, openInCore: forbidden,
    journal: { load: async () => saved, save: async (_prior, progress) => {
      if (new URL(window.location.href).searchParams.has("gate-journal") && saved.progress === null) await journalGate;
      if (new URL(window.location.href).searchParams.has("fail-journal")) throw new Error("Synthetic journal failure");
      return (saved = { revision: String(Number(saved.revision ?? 0) + 1), progress });
    } },
    reviewJournal: () => ({ load: async () => null, save: forbidden, clear: forbidden }),
    request: async (path, body, key) => {
      const base = { ...body, contract_version: "1", checked_at: new Date().toISOString() };
      if (path.endsWith("capture-admissions")) {
        fixture.admissionRequests.push({ key, attestation: body.attestation });
        if (body.attestation === null && !admissionCommitted) return Response.json({ detail: "provider_consent_required" }, { status: 409 });
        if (body.attestation !== null) {
          if (!body.attestation.all_parties_consented) throw new Error("Consent required");
          fixture.admissions++;
        }
        if (gatedAdmission) await admissionGate;
        admissionCommitted = true;
        return Response.json({ ...base, operation_ref: "scribe_admission_01j00000000000000000000000",
          appointment_ref: scope.appointmentRef, consent_record_id: sessionId, session_id: sessionId });
      }
      return Response.json({ ...base, operation: body.operation.kind, receipt: body.operation.kind === "provider_encounter"
        ? { schema_version: "1.0", status: "not_prepared", review: null }
        : { schema_version: "1.0", session_id: sessionId, status: fixture.reviewStatus, source: null, working: null, review_queue: null } });
    },
    recorder: async () => {
      fixture.recorderCalls++;
      if (new URL(window.location.href).searchParams.has("gate-recorder")) await recorderGate;
      if (new URL(window.location.href).searchParams.has("gate-ready")) fixture.emit({ state: "preparing",
        statusCode: "capture_preparing", desktop: { ...snapshot.desktop, phase: "preparing" } });
      return ({ sourceKind: "microphone", ...(platform === "desktop" ? { captureMode: "desktop_meeting" } : {}),
      ...(platform === "ios" && recents ? { captureMode: "native_microphone" } : {}),
      controller: { get snapshot() { return snapshot; },
        subscribe(listener) { listeners.add(listener); listener(snapshot); return () => listeners.delete(listener); },
        ...(layout ? {
          async selectAudioInput(selectedInputId) {
            if (!inputDevices.some(input => input.id === selectedInputId)) forbidden();
            fixture.emit({ selectedInputId, inputDevices: inputDevices.map(input => ({ ...input, current: input.id === selectedInputId })) });
          },
          async pauseRecording() {
            fixture.emit({ state: "paused", statusCode: "capture_paused", desktop: { ...snapshot.desktop, phase: "interrupted", coverage: "complete" } });
          },
          async resumeRecording() {
            fixture.emit({ state: "recording", statusCode: "capture_recording", desktop: { ...snapshot.desktop, phase: "recording", coverage: "aligned" } });
          },
        } : {}),
        ...(platform === "desktop" ? {
          async selectDesktopAudio(audioMode) {
            fixture.emit({ desktop: { ...snapshot.desktop, audioMode,
              ...(audioMode === "meeting" ? { meetingWindows: { state: "ready", selectedId: null,
                windows: [{ id: "30000000-0000-4000-8000-000000000003", title: "Synthetic meeting" }] } } : {}) } });
          },
          async selectMeetingWindow(id) { fixture.emit({ desktop: { ...snapshot.desktop,
            meetingWindows: { ...snapshot.desktop.meetingWindows, selectedId: id } } }); },
        } : {}),
        async startRecording() {
          fixture.starts++;
          if (new URL(window.location.href).searchParams.has("fail-start") && fixture.starts === 1) throw new Error("Synthetic Start failure");
          snapshot = { ...snapshot, state: "recording", statusCode: "capture_recording",
            ...(layout ? { elapsedSeconds: 1, recordedChunks: 1 } : {}),
            ...(snapshot.native ? { native: { phase: "recording", busy: false } } : {}),
            ...(snapshot.desktop ? { desktop: { ...snapshot.desktop, phase: "recording", coverage: "aligned",
              ...(layout ? { inputSignal: { microphone: { level: 0.125, ageMs: 0 }, meetingAudio: { level: 0.25, ageMs: 0 } } } : {}) } } : {}) };
          for (const listener of listeners) listener(snapshot);
        }, stopRecording: forbidden, refreshTranscriptionStatus: forbidden,
      }, deactivate: async () => { fixture.closes++; }, resumePendingWork: forbidden, releaseUploadedCapture: forbidden,
      });
    },
  }); },
});
