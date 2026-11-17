// Actual workspace, transcript panel and encrypted encounter creation with
// synthetic local ports only. Recording and all external requests are refused.
/* global document, window */
const { mountProviderWorkspace } = await import("../../src/provider-entry.ts");
const { createEncounterSetup } = await import("../../src/provider/encounter-setup.ts");
const { parseCreatorReview } = await import("../../../review-ui/src/creator-review-api.ts");
const { encryptedFixturePlugin } = await import("./encrypted-plugin.mjs");
const abort = new AbortController();
const workspaceId = "20000000-0000-4000-8000-000000000002";
const sessionId = "10000000-0000-4000-8000-000000000001";
const suffix = "01j00000000000000000000000";
const oldRef = "appointment_" + suffix, newRef = oldRef.slice(0, -1) + "1";
const patientRef = "patient_" + suffix;
const account = { email: "provider@synthetic.invalid", environment: "Staging" };
const oldEncounter = { appointmentRef: oldRef, title: "Synthetic patient", detail: "Synthetic earlier visit",
  patientRef, status: "processing" };
const newEncounter = { ...oldEncounter, appointmentRef: newRef, detail: "Synthetic separate visit", status: "ready" };
const pendingView = parseCreatorReview({ schema_version: "1.0", session_id: sessionId,
  status: "processing", source: null, working: null, review_queue: null }, sessionId);
const saved = { revision: "1", progress: { admission: null, sessionId, uploaded: true, pendingSave: null } };
const lab = window.actionableVisitsLab = { creates: [], openedRefs: [], oldJournalWrites: 0,
  newJournalWrites: 0, recorderCalls: 0, externalRequests: 0, oldRef, newRef, patientRef };
const forbidden = () => { throw new Error("Outside the synthetic actionable visits fixture"); };
const plugin = await encryptedFixturePlugin(workspaceId);
const setup = createEncounterSetup({
  current: signal => { if (abort.signal.aborted || signal?.aborted) forbidden(); },
  records: async () => ({ records: plugin, close: async () => {} }), created: () => {},
  request: async body => {
    const base = { action: body.action, account, recoveryScope: workspaceId };
    if (body.action === "patients") return { ...base,
      patients: [{ patient_ref: patientRef, name: "Synthetic patient", date_of_birth: null }], more_results: false };
    if (body.action !== "create") forbidden();
    lab.creates.push(body);
    return { ...base, creation_key: body.creation_key, encounter: { workspace_id: workspaceId,
      appointment_ref: newRef, patient_ref: patientRef, patient_name: "Synthetic patient",
      title: "Visit", appointment_at: body.appointment_at } };
  },
});
mountProviderWorkspace(document.querySelector("#provider"), {
  signal: abort.signal, account, encounterSetup: setup,
  listEncounters: async () => [oldEncounter], createEncounter: forbidden,
  openEncounter: async ref => {
    if (ref !== oldRef && ref !== newRef) forbidden();
    lab.openedRefs.push(ref);
    const fresh = ref === newRef;
    const scope = { workspaceId, appointmentRef: ref, bindingRef: "scribe_capture_binding_" + suffix };
    return { encounter: fresh ? newEncounter : oldEncounter, scope, signal: abort.signal,
      openingReview: { scope, receivedAt: Date.now(), view: fresh ? null : pendingView },
      openInCore: forbidden,
      journal: { load: async () => fresh ? { revision: null, progress: null } : saved,
        save: async () => { if (fresh) lab.newJournalWrites++; else lab.oldJournalWrites++; forbidden(); } },
      reviewJournal: () => ({ load: async () => null, save: forbidden, clear: forbidden }),
      request: async (_path, body) => {
        if (body.operation?.kind !== "creator_review") { lab.externalRequests++; forbidden(); }
        return Response.json({ ...body, contract_version: "1", checked_at: new Date().toISOString(),
          operation: "creator_review", receipt: fresh ? null : pendingView });
      },
      recorder: async () => { lab.recorderCalls++; forbidden(); },
    };
  },
});
