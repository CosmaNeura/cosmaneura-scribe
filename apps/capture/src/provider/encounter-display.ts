import { record, reference } from "./core-client";
import type { ProviderEncounter } from "./workspace-contracts";
import { parsePatientIdentity } from "./visit-features";

/** Only display evidence returned by the authorized host, never inferred state. */
export function parseEncounterDisplay(value: unknown): ProviderEncounter {
  if (!record(value) || !reference(value.appointmentRef, "appointment")
    || typeof value.title !== "string" || value.title.length > 300
    || typeof value.detail !== "string" || value.detail.length > 1000
    || value.patientRef !== undefined && !reference(value.patientRef, "patient")
    || value.patientName !== undefined && (typeof value.patientName !== "string"
      || !value.patientName.trim() || value.patientName.length > 200 || value.patientName.includes("\0"))
    || value.dateOfBirth !== undefined && value.dateOfBirth !== null
      && (typeof value.dateOfBirth !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value.dateOfBirth))
    || value.status !== undefined && (typeof value.status !== "string" || !["draft_ready", "processing", "paused", "ready", "recording_saved"].includes(value.status))) {
    throw new Error("provider_encounter_display_unavailable");
  }
  const rawIdentity = value.identity;
  const identity = record(rawIdentity) && Object.hasOwn(rawIdentity, "canonicalPatientRef") ? parsePatientIdentity({ state: rawIdentity.state, version: rawIdentity.version, canonical_patient_ref: rawIdentity.canonicalPatientRef, name: rawIdentity.name, date_of_birth: rawIdentity.dateOfBirth }) : rawIdentity === undefined ? undefined : parsePatientIdentity(rawIdentity);
  return Object.freeze({ appointmentRef: value.appointmentRef, title: value.title, detail: value.detail,
    ...(identity ? { identity } : {}),
    ...(value.patientRef !== undefined ? { patientRef: value.patientRef } : {}),
    ...(value.patientName !== undefined ? { patientName: value.patientName } : {}),
    ...(value.dateOfBirth !== undefined ? { dateOfBirth: value.dateOfBirth } : {}),
    ...(value.status !== undefined ? { status: value.status as ProviderEncounter["status"] } : {}),
  }) as ProviderEncounter;
}
