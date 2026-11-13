import { describe, expect, it } from "vitest";
import {
  shouldRetryStoreLaunch,
  STORE_LAUNCH_FAILURE,
  STORE_LAUNCH_FAILURE_FINAL,
  STORE_LAUNCH_RETRY_LIMIT,
} from "./store-launch-recovery.js";

describe("store launch recovery copy", () => {
  it("keeps neutral Store launch failure copy without network claims", () => {
    expect(STORE_LAUNCH_FAILURE.message).toBe("Scribe could not open");
    expect(STORE_LAUNCH_FAILURE.detail).toBe(
      "Scribe could not start. Quit and reopen Scribe. If this continues, reinstall from the App Store or contact support.",
    );
    expect(STORE_LAUNCH_FAILURE.detail.toLowerCase()).not.toContain("connection");
    expect(STORE_LAUNCH_FAILURE.buttons).toEqual(["Try again", "Quit"]);
    expect(STORE_LAUNCH_FAILURE_FINAL.buttons).toEqual(["Quit"]);
    expect(STORE_LAUNCH_RETRY_LIMIT).toBe(2);
    expect(shouldRetryStoreLaunch(0)).toBe(true);
    expect(shouldRetryStoreLaunch(1)).toBe(false);
    expect(shouldRetryStoreLaunch(-1)).toBe(false);
  });
});
