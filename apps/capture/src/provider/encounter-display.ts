import { record, reference } from "./core-client";
import type { ProviderEncounter } from "./workspace-contracts";

/** Only display evidence returned by the authorized host, never inferred state. */
export function parseEncounterDisplay(value: unknown): ProviderEncounter {
  if (!record(value) || !reference(value.appointmentRef, "appointment")
    || typeof value.title !== "string" || value.title.length > 300
    || typeof value.detail !== "string" || value.detail.length > 1000
    || value.patientRef !== undefined && !reference(value.patientRef, "patient")
    || value.dateOfBirth !== undefined && value.dateOfBirth !== null
      && (typeof value.dateOfBirth !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value.dateOfBirth))
    || value.status !== undefined && (typeof value.status !== "string" || !["draft_ready", "processing", "paused", "ready", "recording_saved"].includes(value.status))) {
    throw new Error("provider_encounter_display_unavailable");
  }
  return Object.freeze({ appointmentRef: value.appointmentRef, title: value.title, detail: value.detail,
    ...(value.patientRef !== undefined ? { patientRef: value.patientRef } : {}),
    ...(value.dateOfBirth !== undefined ? { dateOfBirth: value.dateOfBirth } : {}),
    ...(value.status !== undefined ? { status: value.status as ProviderEncounter["status"] } : {}),
  }) as ProviderEncounter;
}
