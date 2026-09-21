import { defineConfig } from "vite";

// Separate local packaging entry; the published synthetic preview keeps its startup.
export default defineConfig({
  build: {
    outDir: "dist/provider", sourcemap: false, target: "es2022",
    lib: { entry: "src/provider-entry.ts", formats: ["es"], fileName: "provider-capture",
      cssFileName: "provider-capture" },
  },
});
