import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  createRecallNonCaptureAcceptancePort,
  RECALL_NON_CAPTURE_ACCEPTANCE_EVENTS,
  RECALL_NON_CAPTURE_ACCEPTANCE_INIT,
  RECALL_NON_CAPTURE_ACCEPTANCE_PERMISSIONS,
} from "./recall-native-acceptance.js";

describe("Recall non-capturing native acceptance surface", () => {
  it("exposes only initialize, permissions, fixed events, and shutdown", async () => {
    const candidate = {
      init: vi.fn((options: unknown) => {
        void options;
        return Promise.resolve();
      }),
      shutdown: vi.fn(() => Promise.resolve()),
      requestPermission: vi.fn(() => Promise.resolve()),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      forbiddenCaptureMethod: vi.fn(),
    };
    const port = createRecallNonCaptureAcceptancePort(candidate);

    expect(Object.keys(port).sort()).toEqual([
      "addEventListener",
      "init",
      "removeEventListener",
      "requestPermission",
      "shutdown",
    ]);
    expect("forbiddenCaptureMethod" in port).toBe(false);
    await port.init(RECALL_NON_CAPTURE_ACCEPTANCE_INIT);
    for (const permission of RECALL_NON_CAPTURE_ACCEPTANCE_PERMISSIONS) {
      await port.requestPermission(permission);
    }
    expect(candidate.init).toHaveBeenCalledWith({
      apiUrl: "https://us-west-2.recall.ai",
      restartOnError: false,
      acquirePermissionsOnStartup: [],
    });
    const passedOptions = candidate.init.mock.calls[0]?.[0];
    expect(Object.isFrozen(RECALL_NON_CAPTURE_ACCEPTANCE_INIT)).toBe(true);
    expect(Object.isFrozen(passedOptions)).toBe(false);
    expect(candidate.requestPermission.mock.calls).toEqual([
      ["accessibility"],
      ["screen-capture"],
      ["microphone"],
    ]);
    expect(RECALL_NON_CAPTURE_ACCEPTANCE_EVENTS).toEqual([
      "error",
      "meeting-detected",
      "permission-status",
      "permissions-granted",
      "shutdown",
    ]);
  });

  it("keeps the acceptance runner out of the application and unable to name capture APIs", async () => {
    const runner = await readFile(
      new URL("../scripts/run-recall-macos-acceptance.mjs", import.meta.url),
      "utf8",
    );
    const bootstrap = await readFile(new URL("./main-entry.ts", import.meta.url), "utf8");
    expect(runner).toContain("verifyRecallSdkRuntime");
    expect(runner).toContain("clinicalReleaseApproved !== false");
    expect(runner).toContain("--approved-deidentified-noncapture");
    expect(runner).not.toMatch(/startRecording|stopRecording|uploadToken/u);
    expect(runner).not.toContain("process.env");
    expect(bootstrap).not.toContain("run-recall-macos-acceptance");
    expect(bootstrap).not.toContain("recall-native-acceptance");
  });
});
