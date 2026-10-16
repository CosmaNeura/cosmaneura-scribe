import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Separate local packaging entry; the published synthetic preview keeps its startup.
export default defineConfig({
  resolve: { alias: {
    // Provider candidates bind the reviewed source, never a cached plugin dist.
    "@cosmaneura-scribe/capacitor-secure-queue": fileURLToPath(new URL("./native-plugins/secure-queue/src/index.ts", import.meta.url)),
  } },
  build: {
    outDir: "dist/provider", sourcemap: false, target: "es2022",
    lib: { entry: "src/provider-entry.ts", formats: ["es"], fileName: "provider-capture",
      cssFileName: "provider-capture" },
  },
});
