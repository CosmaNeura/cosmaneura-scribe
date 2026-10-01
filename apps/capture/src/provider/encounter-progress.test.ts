import { describe, expect, it } from "vitest";
import { pendingEncounterUpdates } from "./encounter-progress";

describe("authorized pending encounter observation", () => {
  it("updates only originally displayed pending visits and drops revoked visits", () => {
    const fresh = [
      { appointmentRef: "pending", title: "Synthetic A", detail: "", status: "draft_ready" as const },
      { appointmentRef: "another", title: "Synthetic B", detail: "", status: "processing" as const },
      { appointmentRef: "complete", title: "Synthetic C", detail: "", status: "draft_ready" as const },
    ];
    const result = pendingEncounterUpdates(new Set(["pending", "revoked"]), fresh);
    expect(result.updates).toEqual([fresh[0]]); expect(result.removed).toEqual(["revoked"]);
    expect(pendingEncounterUpdates(new Set(), fresh)).toEqual({ updates: [], removed: [] });
    expect(pendingEncounterUpdates(new Set(["pending"]), [{ appointmentRef: "pending", title: "Synthetic A", detail: "" }])).toEqual({ updates: [], removed: [] });
  });
});
