import { expect, it, vi } from "vitest";
import { createVisitFeatures, parsePrivateNote, validPatientDateOfBirth } from "./visit-features";

const suffix = "01j" + "0".repeat(23), encounter = { appointmentRef: "appointment_" + suffix, patientRef: "patient_" + suffix, title: "Invented patient", detail: "" };
const key = "00000000-0000-4000-8000-000000000001", signal = new AbortController().signal;
it("accepts optional DOB and real past dates, rejecting invalid calendar dates and future dates", () => {
  const today = new Date("2026-10-15T00:00:00Z");
  for (const dob of [null, "1900-01-01", "2000-02-29", "2026-10-15"]) expect(validPatientDateOfBirth(dob, today)).toBe(true);
  for (const dob of ["1899-12-31", "2001-02-29", "2026-04-31", "2026-10-16", "", "2026-1-01"]) expect(validPatientDateOfBirth(dob, today)).toBe(false);
});
it("rejects invalid matching dates before sending an immutable change request", async () => {
  const request = vi.fn(async () => ({})); const features = createVisitFeatures(request);
  await expect(features.matchPatient(encounter, { kind: "confirm_new", dateOfBirth: "9999-01-01" }, 0, key, signal)).rejects.toThrow();
  await expect(features.patientCandidates(encounter, "Invented patient", "2001-02-29", signal)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});

it("uses a separate scoped reminder operation and keeps the same idempotency key on retries", async () => {
  const request = vi.fn(async (body: Record<string, unknown>, sentKey: string, sentSignal: AbortSignal) => {
    expect(sentKey).toBe(key); expect(sentSignal).toBe(signal);
    return { private_note: { text: body.text, version: 3, updated_at: null }, change_key: body.change_key };
  });
  const features = createVisitFeatures(request);
  await features.savePrivateNote(encounter, "Private fixture", 2, key, signal);
  await features.savePrivateNote(encounter, "Private fixture", 2, key, signal);
  for (const [body, sentKey, sentSignal] of request.mock.calls) {
    expect(body).toMatchObject({ action: "private_note_save", appointment_ref: encounter.appointmentRef, text: "Private fixture", expected_version: 2, change_key: key });
    expect(body).not.toHaveProperty("fields"); expect(body).not.toHaveProperty("patient_ref"); expect(sentKey).toBe(key); expect(sentSignal).toBe(signal);
  }
  expect(request.mock.calls[0]![0].request_nonce).not.toBe(request.mock.calls[1]![0].request_nonce);
});

it("rejects a mismatched reminder confirmation and unexpected private fields", async () => {
  const features = createVisitFeatures(async () => ({ private_note: { text: "Other text", version: 3, updated_at: null }, change_key: key }));
  await expect(features.savePrivateNote(encounter, "Private fixture", 2, key, signal)).rejects.toThrow();
  expect(() => parsePrivateNote({ text: "", version: 0, updated_at: null, clinical_fields: {} })).toThrow();
  expect(() => parsePrivateNote({ text: "😀".repeat(2000), version: 0, updated_at: null })).not.toThrow();
  expect(() => parsePrivateNote({ text: "😀".repeat(2001), version: 0, updated_at: null })).toThrow();
});
