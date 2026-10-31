import { expect, it, vi } from "vitest";
import { createEncounterSetup, existingPatientSetup, parseProviderAccount, type CreationRecords, type EncounterDraft } from "./encounter-setup";
import { encounterSetupMarkup } from "./encounter-setup-view";

const patientRef = "patient_00000000000000000000000001", appointmentRef = "appointment_00000000000000000000000002";
const recoveryScope = "10000000-0000-4000-8000-000000000001";
const workspaceId = "10000000-0000-4000-8000-000000000002";
const email = "provider@synthetic.invalid";

it("Production display is explicit and legacy default still accepts only Staging", () => {
  expect(parseProviderAccount({ email, environment: "Staging" })).toEqual({ email, environment: "Staging" });
  expect(() => parseProviderAccount({ email, environment: "Production" })).toThrow();
  expect(parseProviderAccount({ email, environment: "Production" }, "Production").environment).toBe("Production");
});

it("existing-patient picker escapes names and offers no walk-in mutation", () => {
  const state = { account: email, patients: [{ patientRef, name: "Synthetic <img>", dateOfBirth: null }], moreResults: false, pending: null };
  const selected = encounterSetupMarkup(state, "Synthetic", true);
  expect(selected).toContain('data-workspace-action="select-patient"');
  expect(selected).toContain("Synthetic &lt;img&gt;");
  expect(selected).not.toContain("<img>"); expect(selected).not.toContain("data-walk-in");
  expect(encounterSetupMarkup(state, "Synthetic")).toBe(encounterSetupMarkup(state, "Synthetic", false));
});

it("existing-only setup reads the roster, preserves an uncertain creation key and withholds unsupported features", async () => {
  let saved: { key: string; revision: string; data: string } | null = null;
  const records: CreationRecords = {
    get: vi.fn(async () => { if (!saved) throw Object.assign(new Error("Synthetic absent record"), { code: "SECURE_QUEUE_NOT_FOUND" }); return saved; }),
    create: vi.fn(async ({ key, data }) => saved = { key, data, revision: "1" }),
    compareAndSwap: vi.fn(async ({ key, data, expectedRevision }) => {
      if (saved?.revision !== expectedRevision) throw Error("Synthetic conflict");
      return saved = { key, data, revision: String(Number(expectedRevision) + 1) };
    }),
  };
  let uncertain = true;
  const request = vi.fn(async (body: Record<string, unknown>) => {
    const base = { version: "1", action: body.action, request_nonce: body.request_nonce,
      recoveryScope, account: { email } };
    if (body.action === "patients") return { ...base, patients: [{ patient_ref: patientRef, name: "Synthetic", date_of_birth: null }], more_results: false };
    if (uncertain) { uncertain = false; throw Error("Synthetic lost response"); }
    return { ...base, creation_key: body.creation_key, encounter: { workspace_id: workspaceId, appointment_ref: appointmentRef,
      patient_ref: patientRef, patient_name: "Synthetic", title: "Visit", appointment_at: "2026-10-31T00:00:00Z" } };
  });
  const owner = createEncounterSetup({ current: () => {}, records: async () => ({ records, close: async () => {} }),
    created: () => {}, request, existingPatientOnly: () => true });
  owner.initializeCatalog({ recoveryScope, account: { email } }, new AbortController().signal);
  const setup = existingPatientSetup(owner), signal = new AbortController().signal;
  const state = await setup.state(signal);
  expect(state.patients[0]?.patientRef).toBe(patientRef);
  expect(setup.existingPatientOnly).toBe(true); expect(setup.matchPatient).toBeUndefined();
  expect(Object.hasOwn(setup, "addDateOfBirth")).toBe(false); expect(setup.savePrivateNote).toBeUndefined();
  const draft: EncounterDraft = { creationKey: "10000000-0000-4000-8000-000000000003", patient: { kind: "existing", patientRef }, appointmentAt: "2026-10-31T00:00:00Z", title: "Visit" };
  await expect(setup.submit({ ...draft, patient: { kind: "new", name: "Synthetic", dateOfBirth: null } }, signal)).rejects.toThrow();
  expect(saved).toBeNull();
  await expect(setup.submit(draft, signal)).rejects.toThrow();
  expect(saved).not.toBeNull();
  await setup.submit(null, signal);
  const submissions = request.mock.calls.filter(([body]) => body.action === "create");
  expect(submissions).toHaveLength(2);
  expect(submissions.map(([body]) => body.creation_key)).toEqual([draft.creationKey, draft.creationKey]);
  expect(submissions.map(([body]) => body.patient)).toEqual([{ kind: "existing", patient_ref: patientRef }, { kind: "existing", patient_ref: patientRef }]);
});
