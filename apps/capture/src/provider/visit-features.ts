import { isUuid } from "../../../review-ui/src/contracts";
import { record, reference, requireValue } from "./core-client";
import { parseCreatedEncounter, type ProviderPatient } from "./encounter-setup";
import type { ProviderEncounter } from "./workspace-contracts";

export interface PrivateNote { readonly text: string; readonly version: number; readonly updatedAt: string | null }
export interface PatientIdentity { readonly state: "provisional" | "matched" | "confirmed"; readonly version: number; readonly canonicalPatientRef: string; readonly name: string; readonly dateOfBirth: string | null }
export type PatientSelection = { kind: "existing"; patientRef: string } | { kind: "confirm_new"; dateOfBirth: string | null };
export function validPatientDateOfBirth(value: string | null, today = new Date()): boolean {
  if (value === null) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || value < "1900-01-01" || value > today.toISOString().slice(0, 10)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export interface VisitFeatures {
  readPrivateNote(encounter: ProviderEncounter, signal: AbortSignal): Promise<PrivateNote>;
  savePrivateNote(encounter: ProviderEncounter, text: string, expectedVersion: number, key: string, signal: AbortSignal): Promise<PrivateNote>;
  patientCandidates(encounter: ProviderEncounter, query: string, dateOfBirth: string | null, signal: AbortSignal): Promise<{ patients: ProviderPatient[]; moreResults: boolean; identity: PatientIdentity }>;
  matchPatient(encounter: ProviderEncounter, selection: PatientSelection, expectedVersion: number, key: string, signal: AbortSignal): Promise<{ encounter: ProviderEncounter; identity: PatientIdentity }>;
}
export function parsePrivateNote(value: unknown): PrivateNote {
  requireValue(record(value) && Object.keys(value).sort().join(",") === "text,updated_at,version" && privateText(value.text)
    && Number.isSafeInteger(value.version) && Number(value.version) >= 0
    && (value.updated_at === null || typeof value.updated_at === "string" && Number.isFinite(Date.parse(value.updated_at))));
  return { text: value.text, version: value.version as number, updatedAt: value.updated_at };
}
export function parsePatientIdentity(value: unknown): PatientIdentity {
  requireValue(record(value) && ["provisional", "matched", "confirmed"].includes(String(value.state))
    && Number.isSafeInteger(value.version) && Number(value.version) >= 0 && reference(value.canonical_patient_ref, "patient")
    && typeof value.name === "string" && value.name.length > 0 && value.name.length <= 200 && !value.name.includes("\0")
    && (value.date_of_birth === null || typeof value.date_of_birth === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value.date_of_birth)));
  return { state: value.state as PatientIdentity["state"], version: value.version as number,
    canonicalPatientRef: value.canonical_patient_ref, name: value.name, dateOfBirth: value.date_of_birth };
}
export function privateText(value: unknown): value is string { return typeof value === "string" && [...value].length <= 2000 && !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value); }

export function createVisitFeatures(request: (body: Record<string, unknown>, key: string, signal: AbortSignal) => Promise<Record<string, unknown>>): VisitFeatures {
  const read = async (encounter: ProviderEncounter, body: Record<string, unknown>, key: string, signal: AbortSignal): Promise<Record<string, unknown>> => {
    requireValue(reference(encounter.appointmentRef, "appointment") && isUuid(key));
    return request({ ...body, appointment_ref: encounter.appointmentRef, request_nonce: crypto.randomUUID() }, key, signal);
  };
  return {
    readPrivateNote: async (encounter, signal) => parsePrivateNote((await read(encounter, { action: "private_note_read" }, crypto.randomUUID(), signal)).private_note),
    savePrivateNote: async (encounter, text, expectedVersion, key, signal) => {
      requireValue(privateText(text) && Number.isSafeInteger(expectedVersion) && expectedVersion >= 0);
      const value = await read(encounter, { action: "private_note_save", text, expected_version: expectedVersion, change_key: key }, key, signal);
      const note = parsePrivateNote(value.private_note); requireValue(value.change_key === key && note.text === text && note.version >= expectedVersion + 1); return note;
    },
    patientCandidates: async (encounter, query, dateOfBirth, signal) => {
      requireValue(query.length <= 200 && !query.includes("\0") && validPatientDateOfBirth(dateOfBirth));
      const value = await read(encounter, { action: "patient_match_candidates", query, date_of_birth: dateOfBirth }, crypto.randomUUID(), signal);
      requireValue(Array.isArray(value.patients) && value.patients.length <= 100 && typeof value.more_results === "boolean");
      const patients = value.patients.map(row => { requireValue(record(row)); const identity = parsePatientIdentity({ state: "matched", version: 0, canonical_patient_ref: row.patient_ref, name: row.name, date_of_birth: row.date_of_birth }); return { patientRef: identity.canonicalPatientRef, name: identity.name, dateOfBirth: identity.dateOfBirth }; });
      requireValue(new Set(patients.map(patient => patient.patientRef)).size === patients.length);
      return { patients, moreResults: value.more_results, identity: parsePatientIdentity(value.identity) };
    },
    matchPatient: async (encounter, selection, expectedVersion, key, signal) => {
      requireValue(Number.isSafeInteger(expectedVersion) && expectedVersion >= 0
        && (selection.kind === "existing" ? reference(selection.patientRef, "patient") : validPatientDateOfBirth(selection.dateOfBirth)));
      const chosen = selection.kind === "existing" ? { kind: "existing", patient_ref: selection.patientRef } : { kind: "confirm_new", date_of_birth: selection.dateOfBirth };
      const value = await read(encounter, { action: "patient_match_save", selection: chosen, expected_version: expectedVersion, change_key: key }, key, signal);
      const updated = parseCreatedEncounter(value.encounter), identity = parsePatientIdentity(value.identity);
      const sameOutcome = selection.kind === "existing" ? identity.state === "matched" && identity.canonicalPatientRef === selection.patientRef
        : identity.state === "confirmed" && identity.canonicalPatientRef === encounter.patientRef && (selection.dateOfBirth === null || identity.dateOfBirth === selection.dateOfBirth);
      requireValue(value.change_key === key && updated.appointmentRef === encounter.appointmentRef && updated.patientRef === encounter.patientRef
        && identity.version >= expectedVersion + 1 && sameOutcome);
      return { encounter: updated, identity };
    },
  };
}
