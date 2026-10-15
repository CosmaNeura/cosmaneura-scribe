import { describe, expect, it } from "vitest";
import { adjacentVisitDay, visitDay, visitIsOnDay, visitRow } from "./visit-list-view";

describe("day-centered patient list", () => {
  it("keeps local dates across month boundaries and daylight saving", () => {
    const date = new Date(2026, 9, 31, 23, 30);
    expect(visitDay(adjacentVisitDay(date, 1))).toBe("2026-11-01");
    expect(visitDay(adjacentVisitDay(date, -1))).toBe("2026-10-30");
    expect(visitDay(date)).toBe("2026-10-31");
  });
  it("uses the authorized visit timestamp and keeps undated older-host visits reachable", () => {
    const today = new Date(2026, 9, 15, 12);
    const encounter = { appointmentRef: "appointment_1", title: "Synthetic patient", detail: `Visit · ${today.toISOString()}` };
    expect(visitIsOnDay(encounter, today, today)).toBe(true);
    expect(visitIsOnDay(encounter, adjacentVisitDay(today, -1), today)).toBe(false);
    expect(visitIsOnDay({ ...encounter, detail: "Visit" }, today, today)).toBe(true);
  });
  it("has a single action per patient and escapes authorized display strings", () => {
    const encounter = { appointmentRef: "appointment_1", title: '<script>"patient"</script>', detail: "Visit" };
    const ready = visitRow(encounter, "draft_ready");
    expect(ready.match(/<button/g)).toHaveLength(1);
    expect(ready).toContain('data-workspace-action="open-draft"');
    expect(ready).toContain("&lt;script&gt;");
    expect(visitRow(encounter, "processing")).not.toContain("<button");
    expect(visitRow(encounter, "paused")).toContain("Resume");
  });
  it("displays the explicitly matched chart name without changing capture patient identity", () => {
    const encounter = { appointmentRef: "appointment_1", patientRef: "patient_original", patientName: "Entered name", title: "Entered name", detail: "Visit",
      identity: { state: "matched" as const, version: 1, canonicalPatientRef: "patient_chart", name: "Confirmed chart name", dateOfBirth: null } };
    expect(visitRow(encounter)).toContain("Confirmed chart name"); expect(encounter.patientRef).toBe("patient_original");
  });
});
