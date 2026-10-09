import type { ProviderEncounter } from "./workspace-contracts";

export const encounterStatusCopy = (status: NonNullable<ProviderEncounter["status"]>): string => ({
  draft_ready: "Draft ready", processing: "Processing", paused: "Paused", ready: "Ready to record", recording_saved: "Recording saved",
})[status];

/** Only already-displayed pending visits may be updated by background observation. */
export function pendingEncounterUpdates(pending: ReadonlySet<string>, fresh: readonly ProviderEncounter[]): {
  readonly updates: ProviderEncounter[]; readonly removed: string[];
} {
  const byRef = new Map(fresh.map(encounter => [encounter.appointmentRef, encounter]));
  return {
    // Missing catalog status is not evidence that processing has ended.
    updates: [...pending].flatMap(ref => byRef.get(ref)?.status !== undefined ? [byRef.get(ref)!] : []),
    removed: [...pending].filter(ref => !byRef.has(ref)),
  };
}
