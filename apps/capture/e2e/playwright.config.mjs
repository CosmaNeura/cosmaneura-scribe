import { defineConfig, devices } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { materializeSyntheticAudioFixture } from "./support/synthetic-audio.mjs";

const e2eDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(e2eDirectory, "../../..");
const syntheticAudioPath = materializeSyntheticAudioFixture();
const sessionId = "11111111-1111-4111-8111-111111111111";

export default defineConfig({
  testDir: "./specs",
  testMatch: "**/*.pw.mjs",
  outputDir: "./test-results",
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
      command: "npm run mock:bff",
      cwd: repositoryRoot,
      url: `http://127.0.0.1:4174/api/capture/sessions/${sessionId}/capture-capabilities`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npm run dev",
      cwd: repositoryRoot,
      env: {
        ...process.env,
        VITE_CAPTURE_E2E_MICROPHONE_ENABLED: "true",
      },
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
