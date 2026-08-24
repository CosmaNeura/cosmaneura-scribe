import { describe, expect, it } from "vitest";

import {
  DESKTOP_RELEASE_MANIFEST,
  hasRoutableDesktopPlatformOrigins,
  isDesktopCaptureReleaseEnabled,
  type DesktopReleaseManifest,
} from "./config.js";

function manifest(
  packagingEnabled: boolean,
  captureEnabled: boolean,
  clinicalReleaseApproved: boolean,
): DesktopReleaseManifest {
  return {
    schemaVersion: 1,
    packagingEnabled,
    captureEnabled,
    clinicalReleaseApproved,
    platformAppOrigin: "https://app.cosmaneura.com",
    platformApiOrigin: "https://api.cosmaneura.com",
  };
}

describe("Electron release manifest", () => {
  it("keeps the checked-in source build hard-disabled and non-routable", () => {
    expect(DESKTOP_RELEASE_MANIFEST).toEqual({
      schemaVersion: 1,
      packagingEnabled: false,
      captureEnabled: false,
      clinicalReleaseApproved: false,
      platformAppOrigin: "https://desktop-disabled.invalid",
      platformApiOrigin: "https://desktop-disabled.invalid",
    });
    expect(isDesktopCaptureReleaseEnabled(DESKTOP_RELEASE_MANIFEST)).toBe(false);
    expect(hasRoutableDesktopPlatformOrigins(DESKTOP_RELEASE_MANIFEST)).toBe(false);
  });

  it("requires packaging, capture, and clinical release approvals", () => {
    expect(isDesktopCaptureReleaseEnabled(manifest(false, false, false))).toBe(false);
    expect(isDesktopCaptureReleaseEnabled(manifest(true, false, false))).toBe(false);
    expect(isDesktopCaptureReleaseEnabled(manifest(true, true, false))).toBe(false);
    expect(isDesktopCaptureReleaseEnabled(manifest(true, false, true))).toBe(false);
    expect(isDesktopCaptureReleaseEnabled(manifest(false, true, true))).toBe(false);
    expect(isDesktopCaptureReleaseEnabled(manifest(true, true, true))).toBe(true);
  });

  it("accepts only exact routable HTTPS origins", () => {
    expect(hasRoutableDesktopPlatformOrigins(manifest(true, true, true))).toBe(true);
    for (const platformApiOrigin of [
      "http://api.cosmaneura.com",
      "https://api.cosmaneura.com/path",
      "https://api.cosmaneura.com:8443",
      "https://desktop-disabled.invalid",
      "https://localhost",
      "not-a-url",
    ]) {
      expect(
        hasRoutableDesktopPlatformOrigins({
          ...manifest(true, true, true),
          platformApiOrigin,
        }),
      ).toBe(false);
    }
  });
});
