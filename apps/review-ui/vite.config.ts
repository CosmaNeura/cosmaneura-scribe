import { defineConfig } from "vite";

const DEFAULT_LOCAL_BETA_API_ORIGIN = "http://127.0.0.1:8021";

function betaApiOrigin(): string {
  const value = process.env.SCRIBE_BETA_API_ORIGIN ?? DEFAULT_LOCAL_BETA_API_ORIGIN;
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("SCRIBE_BETA_API_ORIGIN must be an exact loopback HTTP origin with a port");
  }
  return parsed.origin;
}

export default defineConfig({
  build: {
    sourcemap: false,
    target: "es2022",
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: {
      "/api/beta": {
        target: betaApiOrigin(),
      },
    },
    strictPort: true,
  },
});
