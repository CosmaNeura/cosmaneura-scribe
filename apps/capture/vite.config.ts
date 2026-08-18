import { defineConfig } from "vite";

const MOCK_BFF_TARGET = "http://127.0.0.1:4174";

export default defineConfig({
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
