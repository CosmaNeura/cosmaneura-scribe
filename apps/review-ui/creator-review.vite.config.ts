import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/creator-review",
    sourcemap: false,
    target: "es2022",
    lib: {
      entry: "src/creator-review-entry.ts",
      formats: ["es"],
      fileName: "creator-review",
      cssFileName: "creator-review",
    },
  },
});
