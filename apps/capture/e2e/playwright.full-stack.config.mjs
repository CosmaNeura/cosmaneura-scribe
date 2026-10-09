import { defineConfig, devices } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { materializeSyntheticAudioFixture } from "./support/synthetic-audio.mjs";
import { SYNTHETIC_TENANT_ID } from "./support/synthetic-tenant.mjs";

const e2eDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(e2eDirectory, "../../..");
const syntheticAudioPath = materializeSyntheticAudioFixture();
const databaseUrl = process.env.COSMANEURA_SCRIBE_E2E_DATABASE_URL;
const apiTarget = "http://127.0.0.1:4175";
const syntheticEnvironment = {
  COSMANEURA_SCRIBE_E2E_DATABASE_URL: databaseUrl,
  COSMANEURA_SCRIBE_E2E_TENANT_ID: SYNTHETIC_TENANT_ID,
};

if (!databaseUrl?.endsWith("_test")) {
  throw new Error("COSMANEURA_SCRIBE_E2E_DATABASE_URL must name a disposable _test database");
}

export default defineConfig({
  testDir: "./specs",
  testMatch: "**/full-stack-capture.pw.mjs",
  outputDir: "./test-results-full-stack",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["line"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:5173",
    permissions: ["microphone"],
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    screenshot: "off",
    trace: "off",
    video: "off",
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-audio-capture=${syntheticAudioPath}`,
      ],
    },
  },
  webServer: [
    {
      command: "uv run python apps/capture/e2e/support/real_api_host.py",
      cwd: repositoryRoot,
      env: { ...process.env, ...syntheticEnvironment },
      url: `${apiTarget}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npm run dev -- --config e2e/vite.full-stack.config.mjs",
      cwd: resolve(repositoryRoot, "apps/capture"),
      env: {
        ...process.env,
        VITE_CAPTURE_E2E_MICROPHONE_ENABLED: "true",
        CAPTURE_E2E_API_TARGET: apiTarget,
      },
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
