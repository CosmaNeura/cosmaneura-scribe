// Actual shared workspace and durable encounter owner with synthetic local ports.
// No account, network, audio, or installed app is used.
/* global document, window */
const platform = new URL(window.location.href).searchParams.get("platform");
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
const encounter = { appointmentRef: scope.appointmentRef, title: "Synthetic walk-in", detail: "Visit · 2026-09-30T12:00:00Z" };
const plugin = await encryptedFixturePlugin(scope.workspaceId);
const forbidden = () => { throw new Error("Outside the synthetic DOB fixture"); };
const fixture = window.dobLab = { creates: [], starts: 0, admissions: 0 };
const setup = createEncounterSetup({
  current: signal => { if (abort.signal.aborted || signal?.aborted) throw new Error("closed"); },
  records: async () => ({ records: plugin, close: async () => {} }), created: () => {},
  request: async body => {
    const base = { action: body.action, account, recoveryScope: scope.workspaceId };
    if (body.action === "patients") return { ...base, patients: [], more_results: false };
    fixture.creates.push(body);
    return { ...base, creation_key: body.creation_key, encounter: { workspace_id: scope.workspaceId,
      appointment_ref: scope.appointmentRef, patient_name: body.patient.name,
      title: "Visit", appointment_at: "2026-09-30T12:00:00Z" } };
  },
});
let saved = { revision: null, progress: null };
let snapshot = { sessionId, state: "ready", statusCode: "capture_ready", recordedChunks: 0, queuedChunks: 0,
  elapsedSeconds: 0, remainingBudgetSeconds: 10_800, remainingAuthoritySeconds: 900,
  transcriptionStatus: null, transcript: null,
  ...(platform === "desktop" ? { desktop: { phase: "ready", coverage: "not_started", trimmedStartMs: 0, trimmedEndMs: null } } : {}) };
const listeners = new Set();
mountProviderWorkspace(document.querySelector("#provider"), {
  signal: abort.signal, account, encounterSetup: setup,
  listEncounters: async () => [], createEncounter: forbidden,
  openEncounter: async () => ({ encounter, scope, signal: abort.signal, openInCore: forbidden,
    journal: { load: async () => saved, save: async (_prior, progress) => (saved = { revision: String(Number(saved.revision ?? 0) + 1), progress }) },
    reviewJournal: () => ({ load: async () => null, save: forbidden, clear: forbidden }),
    request: async (path, body) => {
      const base = { ...body, contract_version: "1", checked_at: new Date().toISOString() };
      if (path.endsWith("capture-admissions")) {
        fixture.admissions++;
        if (!body.attestation.all_parties_consented) throw new Error("Consent required");
        return Response.json({ ...base, operation_ref: "scribe_admission_01j00000000000000000000000",
          appointment_ref: scope.appointmentRef, consent_record_id: sessionId, session_id: sessionId });
      }
      return Response.json({ ...base, operation: body.operation.kind, receipt: body.operation.kind === "provider_encounter"
        ? { schema_version: "1.0", status: "not_prepared", review: null }
        : { schema_version: "1.0", session_id: sessionId, status: "created", source: null, working: null, review_queue: null } });
    },
    recorder: async () => ({ sourceKind: "microphone", ...(platform === "desktop" ? { captureMode: "desktop_meeting" } : {}),
      controller: { get snapshot() { return snapshot; },
        subscribe(listener) { listeners.add(listener); listener(snapshot); return () => listeners.delete(listener); },
        async startRecording() {
          fixture.starts++;
          snapshot = { ...snapshot, state: "recording", statusCode: "capture_recording",
            ...(snapshot.desktop ? { desktop: { ...snapshot.desktop, phase: "recording", coverage: "aligned" } } : {}) };
          for (const listener of listeners) listener(snapshot);
        }, stopRecording: forbidden, refreshTranscriptionStatus: forbidden,
      }, deactivate: async () => {}, resumePendingWork: forbidden, releaseUploadedCapture: forbidden,
    }),
  }),
});
