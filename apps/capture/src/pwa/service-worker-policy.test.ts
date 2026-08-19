import { describe, expect, it } from "vitest";

import {
  enforceStaticPrecache,
  NAVIGATION_FALLBACK_DENYLIST,
} from "./service-worker-policy";

describe("capture PWA service-worker policy", () => {
  it("accepts only static exact-origin asset entries", async () => {
    const entries = [
      { url: "index.html", revision: "one", size: 100 },
      { url: "assets/index-abc123.js", revision: null, size: 200 },
      { url: "icon.svg", revision: "two", size: 300 },
    ];

    await expect(enforceStaticPrecache(entries)).resolves.toEqual({
      manifest: entries,
      warnings: [],
    });
  });

  it.each([
    "https://cdn.example.invalid/app.js",
    "//cdn.example.invalid/app.js",
    "/api/capture/sessions/synthetic",
    "/mock-upload/synthetic?credential=forbidden",
    "assets/index.js?credential=forbidden",
    "assets/index.js#fragment",
  ])("rejects non-static precache URL %s", async (url) => {
    await expect(enforceStaticPrecache([{ url, revision: "one", size: 100 }])).rejects.toThrow(
      /precache/u,
    );
  });

  it.each(["/api", "/api/capture/sessions/synthetic", "/mock-upload/synthetic"])(
    "denies navigation fallback for %s",
    (path) => {
      expect(NAVIGATION_FALLBACK_DENYLIST.some((pattern) => pattern.test(path))).toBe(true);
    },
  );
});
