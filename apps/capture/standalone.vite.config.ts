import { defineConfig } from "vite";
export default defineConfig({ root: "standalone", base: "./", build: {
  outDir: "../dist/standalone", target: "es2022", sourcemap: false,
} });
