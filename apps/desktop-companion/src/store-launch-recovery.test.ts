import { describe, expect, it } from "vitest";
import { shouldRetryStoreLaunch, STORE_LAUNCH_FAILURE } from "./store-launch-recovery.js";

describe("store launch recovery", () => {
  it("keeps fixed recoverable copy and only retries the primary button", () => {
    expect(STORE_LAUNCH_FAILURE.message).toBe("Scribe could not open");
    expect(STORE_LAUNCH_FAILURE.detail).toContain("Check your connection");
    expect(STORE_LAUNCH_FAILURE.buttons).toEqual(["Try again", "Quit"]);
    expect(shouldRetryStoreLaunch(0)).toBe(true);
    expect(shouldRetryStoreLaunch(1)).toBe(false);
    expect(shouldRetryStoreLaunch(-1)).toBe(false);
  });
});
