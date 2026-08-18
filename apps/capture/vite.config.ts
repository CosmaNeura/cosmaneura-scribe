import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

import {
  enforceStaticPrecache,
  NAVIGATION_FALLBACK_DENYLIST,
} from "./src/pwa/service-worker-policy.ts";

const MOCK_BFF_TARGET = "http://127.0.0.1:4174";

export default defineConfig({
  plugins: [
    VitePWA({
      injectRegister: "script-defer",
      manifest: false,
      registerType: "prompt",
      strategies: "generateSW",
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        globIgnores: ["**/*.map"],
        globPatterns: ["**/*.{css,html,js,png,svg,webmanifest,webp,woff,woff2}"],
        manifestTransforms: [enforceStaticPrecache],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: NAVIGATION_FALLBACK_DENYLIST,
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
      "/api/capture": MOCK_BFF_TARGET,
      "/mock-upload": MOCK_BFF_TARGET,
    },
    strictPort: true,
  },
});
