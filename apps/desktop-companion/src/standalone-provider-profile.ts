import { exact } from "../../capture/src/provider/desktop-host-protocol";

const STAGING_WORKSPACE = "56f527ab-0caf-459b-bda9-cf7f0ca2f709";

/** Owned package inputs only. No environment, argv or renderer profile choice. */
export function standaloneProviderProfile(value: unknown): Record<string, unknown> & {
  enabled: boolean; coreOrigin: string; workspaceId: string; uploadOrigins: string[];
} {
  const production = typeof value === "object" && value !== null && "schema" in value && value.schema === 2;
  const profile = exact(value, production
    ? ["schema", "profile", "enabled", "coreOrigin", "workspaceId", "deploymentReceiptSha256", "uploadOrigins", "auth", "audio", "presentation"]
    : ["schema", "enabled", "coreOrigin", "uploadOrigins", "auth", "audio", "presentation"]);
  if (production) {
    if (profile.profile !== "core-production-organization-v1"
      || profile.coreOrigin !== "https://app.cosmaneura.com"
      || typeof profile.workspaceId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(profile.workspaceId)
      || profile.workspaceId === "00000000-0000-0000-0000-000000000000" || profile.workspaceId === STAGING_WORKSPACE
      || typeof profile.deploymentReceiptSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(profile.deploymentReceiptSha256)) throw unavailable();
  } else if (profile.schema !== 1 || profile.coreOrigin !== "https://staging-app.cosmaneura.com") throw unavailable();
  if (typeof profile.enabled !== "boolean" || !Array.isArray(profile.uploadOrigins)
    || (profile.enabled ? profile.uploadOrigins.length !== 1 : profile.uploadOrigins.length > 1)
    || profile.uploadOrigins.some(value => typeof value !== "string" || !/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net$/u.test(value))) throw unavailable();
  return { ...profile, enabled: profile.enabled, coreOrigin: profile.coreOrigin,
    uploadOrigins: profile.uploadOrigins as string[], workspaceId: production ? profile.workspaceId as string : STAGING_WORKSPACE };
}
function unavailable(): Error { return new Error("The standalone provider is unavailable."); }
