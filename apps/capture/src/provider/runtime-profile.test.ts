import { describe, expect, it } from "vitest";
import { providerRuntimeProfile, type ProviderRuntimeProfile } from "./runtime-profile";
import { providerVisitCapabilities } from "./encounter-setup";

const profiles = [
  ["core-staging-personal-v1", "Staging", "https://staging-app.cosmaneura.com"],
  ["core-production-personal-v1", "Production", "https://app.cosmaneura.com"],
  ["core-production-organization-v1", "Production", "https://app.cosmaneura.com"],
] as const;

describe("sealed native environment compatibility", () => {
  it.each(profiles)("binds %s to its exact environment and Core origin", (profile, environment, coreOrigin) => {
    expect(providerRuntimeProfile(profile)).toEqual({ profile, environment, coreOrigin });
    for (const full of [false, true]) {
      const capabilities = providerVisitCapabilities({ encounter_creation_v1: true,
        existing_patient_visits_v1: true, native_visit_actions_v2: full, environment }, profile);
      expect(capabilities).toEqual({ supportsCreation: true, existingPatientOnly: !full,
        fullNativeVisits: full, environment });
      expect(() => providerVisitCapabilities({ encounter_creation_v1: true, existing_patient_visits_v1: true,
        native_visit_actions_v2: full, environment: environment === "Staging" ? "Production" : "Staging" }, profile)).toThrow();
    }
  });
  it.each([undefined, null, "Staging", "Production", "unknown-profile", 7])("rejects unknown profile %s", profile => {
    expect(() => providerRuntimeProfile(profile)).toThrow();
    if (profile !== undefined) expect(() => providerVisitCapabilities({ encounter_creation_v1: true,
      existing_patient_visits_v1: true, native_visit_actions_v2: true, environment: "Staging" }, profile as ProviderRuntimeProfile)).toThrow();
  });
  it("never enables full visits without all confirmed capabilities", () => {
    for (const missing of ["encounter_creation_v1", "existing_patient_visits_v1"]) {
      const value: Record<string, unknown> = { encounter_creation_v1: true, existing_patient_visits_v1: true,
        native_visit_actions_v2: true, environment: "Staging" };
      delete value[missing];
      expect(() => providerVisitCapabilities(value, "core-staging-personal-v1")).toThrow();
    }
  });
});
