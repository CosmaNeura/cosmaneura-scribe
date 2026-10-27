import type { SecureQueuePlugin } from "@cosmaneura-scribe/capacitor-secure-queue";
import { isUuid } from "../../../review-ui/src/contracts";
import { record, reference, requireValue } from "./core-client";
import type { PendingPatientMatch } from "./patient-match-view";
import { validPatientDateOfBirth } from "./visit-features";

export interface PatientMatchJournal {
  local(): PendingPatientMatch | null;
  retain(value: PendingPatientMatch | null): Promise<void>;
}

export function assertPendingPatientMatch(value: unknown): asserts value is PendingPatientMatch | null {
  if (value === null) return;
  requireValue(record(value) && Object.keys(value).sort().join(",") === "expectedVersion,key,selection"
    && isUuid(value.key) && Number.isSafeInteger(value.expectedVersion) && Number(value.expectedVersion) >= 0
    && record(value.selection));
  const selection = value.selection;
  requireValue(selection.kind === "existing"
    ? Object.keys(selection).sort().join(",") === "kind,patientRef" && reference(selection.patientRef, "patient")
    : selection.kind === "confirm_new" && Object.keys(selection).sort().join(",") === "dateOfBirth,kind"
      && (selection.dateOfBirth === null || typeof selection.dateOfBirth === "string")
      && validPatientDateOfBirth(selection.dateOfBirth));
}

/** Separate encrypted intent; confirming identity never invents capture progress. */
export async function openPatientMatchJournal(records: Pick<SecureQueuePlugin, "get" | "create" | "compareAndSwap">,
  scope: { recoveryScope: string; appointmentRef: string; patientRef: string }, current: () => void): Promise<PatientMatchJournal> {
  requireValue(isUuid(scope.recoveryScope) && reference(scope.appointmentRef, "appointment") && reference(scope.patientRef, "patient"));
  current();
  const key = `provider-patient-match-v1:${scope.recoveryScope}:${scope.appointmentRef}`;
  let revision: string | null = null, saved: PendingPatientMatch | null = null;
  try {
    const stored = await records.get({ key }); current();
    requireValue(stored.key === key && /^[1-9][0-9]*$/u.test(stored.revision) && stored.data.length <= 8192);
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(stored.data), c => c.charCodeAt(0))));
    requireValue(record(value) && Object.keys(value).sort().join(",") === "appointmentRef,patientRef,pending,recoveryScope,version"
      && value.version === 1 && value.recoveryScope === scope.recoveryScope && value.appointmentRef === scope.appointmentRef && value.patientRef === scope.patientRef);
    assertPendingPatientMatch(value.pending); saved = value.pending; revision = stored.revision;
  } catch (error) {
    // Native storage errors may contain protected details; expose only this boundary.
    // eslint-disable-next-line preserve-caught-error
    if (!record(error) || error.code !== "SECURE_QUEUE_NOT_FOUND") throw new Error("Patient confirmation recovery is unavailable.");
  }
  current();
  return {
    local: () => { current(); return saved === null ? null : structuredClone(saved); },
    retain: async value => {
      current(); assertPendingPatientMatch(value);
      requireValue(saved === null || value === null || JSON.stringify(saved) === JSON.stringify(value));
      const next = value === null ? null : structuredClone(value);
      const raw = new TextEncoder().encode(JSON.stringify({ version: 1, ...scope, pending: next }));
      const data = btoa(Array.from(raw, byte => String.fromCharCode(byte)).join(""));
      const result = revision === null ? await records.create({ key, data })
        : await records.compareAndSwap({ key, data, expectedRevision: revision });
      current(); requireValue(/^[1-9][0-9]*$/u.test(result.revision));
      revision = result.revision; saved = next;
    },
  };
}
