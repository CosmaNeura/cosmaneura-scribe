import { describe, expect, it } from "vitest";
import { standaloneProviderProfile } from "./standalone-provider-profile.js";

const staging = { schema: 1, enabled: true, coreOrigin: "https://staging-app.cosmaneura.com",
  uploadOrigins: ["https://syntheticfixture.blob.core.windows.net"], auth: {}, audio: {}, presentation: {} };
const production = { ...staging, schema: 2, profile: "core-production-organization-v1", coreOrigin: "https://app.cosmaneura.com",
  workspaceId: "10000000-0000-4000-8000-000000000001", deploymentReceiptSha256: "1".repeat(64) };
describe("sealed standalone environment profile", () => {
  it("preserves the schema-1 staging origin and encrypted namespace", () => {
    expect(standaloneProviderProfile(staging)).toMatchObject({ coreOrigin: staging.coreOrigin,
      workspaceId: "56f527ab-0caf-459b-bda9-cf7f0ca2f709" });
  });
  it("uses the supplied production workspace and Core only for schema 2", () => {
    expect(standaloneProviderProfile(production)).toMatchObject({ coreOrigin: production.coreOrigin, workspaceId: production.workspaceId });
  });
  it("rejects missing bindings and mixed staging/production packages", () => {
    for (const value of [{ ...staging, coreOrigin: production.coreOrigin }, { ...production, coreOrigin: staging.coreOrigin },
      { ...production, workspaceId: "56f527ab-0caf-459b-bda9-cf7f0ca2f709" }, { ...production, workspaceId: undefined },
      { ...production, deploymentReceiptSha256: undefined }, { ...production, uploadOrigins: [] },
      { ...production, extra: true }]) expect(() => standaloneProviderProfile(value)).toThrow();
  });
});
