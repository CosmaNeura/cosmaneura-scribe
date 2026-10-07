import { describe, expect, it } from "vitest";
import { encounterDetail, encounterTimestamp, orderedNoteFields } from "./workspace-display";

describe("encounter date display", () => {
  it("distinguishes repeated local times across daylight saving time", () => {
    expect(encounterDetail("Visit · 2026-11-01T05:30:00Z", "en-US", "America/New_York"))
      .toBe("Visit · Nov 1, 2026, 1:30 AM EDT");
    expect(encounterDetail("Visit · 2026-11-01T06:30:00Z", "en-US", "America/New_York"))
      .toBe("Visit · Nov 1, 2026, 1:30 AM EST");
  });
  it("honors an explicit source offset and preserves other display text", () => {
    expect(encounterDetail("Visit · 2026-09-30T10:26:45.493000+00:00", "en-US", "America/New_York"))
      .toBe("Visit · Sep 30, 2026, 6:26 AM EDT");
    for (const value of ["Visit", "Visit · 2026-09-30", "Visit · 2026-99-30T10:26:45Z", "2026-09-30T10:26:45Z · Other detail"])
      expect(encounterDetail(value)).toBe(value);
  });
});

it("sorts only explicit encounter dates and puts clinical sections ahead of chart metadata", () => {
  expect(encounterTimestamp("Visit · 2026-10-07T19:00:00Z")).toBe(Date.parse("2026-10-07T19:00:00Z"));
  expect(encounterTimestamp("Visit 2026-10-07")).toBeNull();
  const keys = ["Patient name", "Date of birth", "Plan", "Objective", "Subjective", "Assessment", "Other section"];
  const result = orderedNoteFields(keys);
  expect(result.clinical).toEqual(["Subjective", "Objective", "Assessment", "Plan", "Other section"]);
  expect(result.details).toEqual(["Patient name", "Date of birth"]);
  expect(keys[0]).toBe("Patient name"); // Template identity/order remains unchanged.
});
