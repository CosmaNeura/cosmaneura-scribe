import captureConfig from "../vite.config.ts";
import { SYNTHETIC_TENANT_ID } from "./support/synthetic-tenant.mjs";

const apiTarget = process.env.CAPTURE_E2E_API_TARGET;

if (!apiTarget) {
  throw new Error("CAPTURE_E2E_API_TARGET is required");
}

// Stands in for the BFF: the browser keeps calling /api/capture while the real
// API serves /v1 and trusts the tenant header its authenticated caller supplies.
export default async environment => {
  const config = await captureConfig(environment);
  return {
    ...config,
    server: {
      ...config.server,
      proxy: {
        "/api/capture": {
          target: apiTarget,
          headers: { "X-Tenant-ID": SYNTHETIC_TENANT_ID },
          rewrite: path => path.replace(/^\/api\/capture/u, "/v1"),
        },
      },
    },
  };
};
