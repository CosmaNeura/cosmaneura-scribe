import { describe, expect, it } from "vitest";
import { encounterSetupMarkup } from "./encounter-setup-view";
import type { EncounterSetupState } from "./encounter-setup";
const state: EncounterSetupState = { account: "synthetic@example.invalid", patients: [], pending: null, moreResults: false };
describe("one-name patient selection", () => {
  it("does not offer an empty new chart or require DOB", () => {
    const markup = encounterSetupMarkup(state);
    expect(markup).toContain('name="walk-in-name"');
    expect(markup).not.toContain('data-workspace-action="new-patient"');
    expect(markup).not.toContain("data-new-patient");
  });
  it("accepts an escaped name directly and defers patient matching", () => {
    const query = 'Synthetic <img src=x onerror="x">';
    const choices = encounterSetupMarkup(state, query);
    expect(choices).toContain('value="Synthetic &lt;img');
    expect(choices).toContain("Continue to recording setup");
    expect(choices).not.toContain("<img");
    expect(choices).not.toContain("data-new-patient");
    const confirmation = encounterSetupMarkup(state, query);
    expect(confirmation).toContain('name="walk-in-name"');
    expect(confirmation).not.toContain('type="date"');
    expect(confirmation).not.toMatch(/name="new-patient-dob"[^>]*required/u);
    expect(confirmation).not.toContain("<img");
  });
  it("a retained creation request prevents fresh search or creation", () => {
    const pending = { creationKey: "10000000-0000-4000-8000-000000000001", patient: { kind: "new" as const, name: "Synthetic", dateOfBirth: null }, appointmentAt: "2026-09-30T12:00:00Z", title: "Visit" };
    const markup = encounterSetupMarkup({ ...state, pending }, "Unrelated name");
    expect(markup).toContain('data-workspace-action="retry-creation"');
    expect(markup).not.toContain("data-new-patient");
    expect(markup).not.toContain("patient-query");
  });
});
