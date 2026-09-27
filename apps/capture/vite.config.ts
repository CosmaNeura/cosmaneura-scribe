import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

import {
  enforceStaticPrecache,
  NAVIGATION_FALLBACK_DENYLIST,
} from "./src/pwa/service-worker-policy.ts";

const MOCK_BFF_TARGET = "http://127.0.0.1:4174";
const SYNTHETIC_E2E_TENANT = "11111111-1111-4111-8111-111111111112";
const DEPLOYMENT_ATTESTATION_PATH = "capture-preview-deployment.json";
const DEPLOYMENT_ATTESTATION_NAVIGATION = /^\/capture-preview-deployment\.json$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;

export default defineConfig(({ command }) => {
  const bffTarget = process.env.VITE_CAPTURE_BFF_TARGET ?? MOCK_BFF_TARGET;
  const useRealApi = process.env.VITE_CAPTURE_REAL_API === "true";
  const captureProxy = useRealApi
    ? {
        target: bffTarget,
        headers: { "X-Tenant-ID": SYNTHETIC_E2E_TENANT },
        rewrite: (path: string) => path.replace(/^\/api\/capture/u, "/v1"),
      }
    : bffTarget;
  const deploymentPlugin = command === "build"
    ? [deploymentAttestation(process.env.DEPLOY_SHA)]
    : [];

  return {
    plugins: [
      ...deploymentPlugin,
      VitePWA({
        injectRegister: "script-defer",
        manifest: false,
        registerType: "prompt",
        strategies: "generateSW",
        workbox: {
          cleanupOutdatedCaches: true,
          clientsClaim: false,
          globIgnores: ["**/*.map", DEPLOYMENT_ATTESTATION_PATH],
          globPatterns: ["**/*.{css,html,js,png,svg,webmanifest,webp,woff,woff2}"],
          manifestTransforms: [enforceStaticPrecache],
          navigateFallback: "/index.html",
          navigateFallbackDenylist: [
            ...NAVIGATION_FALLBACK_DENYLIST,
            DEPLOYMENT_ATTESTATION_NAVIGATION,
          ],
          runtimeCaching: [],
          skipWaiting: false,
        },
      }),
    ],
    build: {
      sourcemap: false,
      target: "es2022",
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        "/api/capture": captureProxy,
        "/mock-upload": bffTarget,
      },
      strictPort: true,
    },
  };
});

function deploymentAttestation(value: string | undefined): Plugin {
  if (value === undefined || !SOURCE_SHA.test(value)) {
    throw new Error("DEPLOY_SHA must be an exact lowercase 40-character Git commit SHA");
  }
  const document = {
    schema_version: 1,
    source_sha: value,
    mode: "synthetic",
    microphone_enabled: false,
  } as const;
  return {
    name: "capture-preview-deployment-attestation",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: DEPLOYMENT_ATTESTATION_PATH,
        source: `${JSON.stringify(document)}\n`,
      });
    },
  };
}
