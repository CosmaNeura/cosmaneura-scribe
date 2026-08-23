import { describe, expect, it } from "vitest";

import {
  DESKTOP_RELEASE_MANIFEST,
  isDesktopCaptureReleaseEnabled,
  type DesktopReleaseManifest,
} from "./config.js";

function manifest(
  captureEnabled: boolean,
  clinicalReleaseApproved: boolean,
): DesktopReleaseManifest {
  return {
    schemaVersion: 1,
    captureEnabled,
    clinicalReleaseApproved,
    platformAppOrigin: "https://app.example.invalid",
    platformApiOrigin: "https://api.example.invalid",
  };
}

describe("Electron release manifest", () => {
  it("keeps the checked-in source build hard-disabled and non-routable", () => {
    expect(DESKTOP_RELEASE_MANIFEST).toEqual({
      schemaVersion: 1,
      captureEnabled: false,
      clinicalReleaseApproved: false,
      platformAppOrigin: "https://desktop-disabled.invalid",
      platformApiOrigin: "https://desktop-disabled.invalid",
    });
    expect(isDesktopCaptureReleaseEnabled(DESKTOP_RELEASE_MANIFEST)).toBe(false);
  });

  it("requires both the product and clinical release approvals", () => {
    expect(isDesktopCaptureReleaseEnabled(manifest(false, false))).toBe(false);
    expect(isDesktopCaptureReleaseEnabled(manifest(true, false))).toBe(false);
    expect(isDesktopCaptureReleaseEnabled(manifest(false, true))).toBe(false);
    expect(isDesktopCaptureReleaseEnabled(manifest(true, true))).toBe(true);
  });
});
