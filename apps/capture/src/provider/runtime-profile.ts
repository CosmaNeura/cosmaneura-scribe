export type ProviderRuntimeProfile = "core-staging-personal-v1"
  | "core-production-organization-v1" | "core-production-personal-v1";

/** Public configuration from the sealed native bridge, never a receiver label. */
export function providerRuntimeProfile(value: unknown): {
  profile: ProviderRuntimeProfile; environment: "Staging" | "Production"; coreOrigin: string;
} {
  if (value === "core-staging-personal-v1") {
    return { profile: value, environment: "Staging", coreOrigin: "https://staging-app.cosmaneura.com" };
  }
  if (value === "core-production-organization-v1" || value === "core-production-personal-v1") {
    return { profile: value, environment: "Production", coreOrigin: "https://app.cosmaneura.com" };
  }
  throw new Error("provider_configuration_unavailable");
}
