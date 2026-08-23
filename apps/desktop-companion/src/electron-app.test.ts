import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { resolvePackagedRendererAsset } from "./electron-app.js";

describe("packaged Electron application protocol", () => {
  it("keeps the runnable bootstrap pinned to the disabled mock adapter", async () => {
    const source = await readFile(
      new URL("./main-entry.ts", import.meta.url),
      "utf8",
    );
    const config = await readFile(new URL("./config.ts", import.meta.url), "utf8");
    expect(source).toContain("DEFAULT_COMPANION_FEATURE_CONFIG");
    expect(source).toContain("DESKTOP_RELEASE_MANIFEST");
    expect(source).toContain("isDesktopCaptureReleaseEnabled");
    expect(source).toContain("createTrustedDesktopRuntime");
    expect(source).toContain("ElectronTrayRecordingIndicator");
    expect(source).toContain("DesktopDeepLinkRouter");
    expect(source).toContain("new MockDesktopCaptureAdapter()");
    expect(source).toContain("enabled: captureEnabled");
    expect(config).toContain("captureEnabled: false");
    expect(config).toContain("clinicalReleaseApproved: false");
    expect(config).toContain("https://desktop-disabled.invalid");
    expect(source).not.toContain("loadVerifiedRecallSdk");
    expect(source).not.toContain("RecallDesktopCaptureAdapter");
    expect(source).not.toContain("process.env");
  });

  it("maps only fixed app://cosmas assets beneath an absolute root", () => {
    expect(
      resolvePackagedRendererAsset(
        "app://cosmas/index.html",
        "/synthetic/renderer",
      ),
    ).toEqual({
      path: "/synthetic/renderer/index.html",
      contentType: "text/html; charset=utf-8",
    });
    expect(
      resolvePackagedRendererAsset(
        "app://cosmas/renderer.js",
        "/synthetic/renderer",
      ),
    ).toMatchObject({ path: "/synthetic/renderer/renderer.js" });
  });

  it("rejects traversal, credentials, query strings, fragments, and other origins", () => {
    for (const url of [
      "app://cosmas/%2e%2e/main-entry.js",
      "app://user@cosmas/index.html",
      "app://cosmas/index.html?debug=true",
      "app://cosmas/index.html#fragment",
      "app://other/index.html",
      "file:///synthetic/renderer/index.html",
      "https://cosmas/index.html",
    ]) {
      expect(resolvePackagedRendererAsset(url, "/synthetic/renderer")).toBeNull();
    }
    expect(() =>
      resolvePackagedRendererAsset("app://cosmas/", "relative/renderer"),
    ).toThrow();
  });
});
