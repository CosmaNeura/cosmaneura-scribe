import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  generateDesktopSbom,
  parseArguments,
} from "../scripts/generate-desktop-sbom.mjs";

describe("Electron release SBOM", () => {
  it("deterministically inventories pinned runtime archives, packages, and build tooling", async () => {
    const first = await generateDesktopSbom("darwin-arm64");
    const second = await generateDesktopSbom("darwin-arm64");
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
    });
    expect(first.metadata.component.properties).toEqual(
      expect.arrayContaining([
        { name: "cosmaneura:capture-enabled", value: "false" },
        { name: "cosmaneura:clinical-release-approved", value: "false" },
        {
          name: "cosmaneura:unsigned-distribution-allowed",
          value: "false",
        },
      ]),
    );
    expect(first.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "desktop-sdk",
          version: "2.0.28",
          scope: "required",
        }),
        expect.objectContaining({
          name: "electron-v43.4.1-darwin-arm64.zip",
          version: "43.4.1",
          scope: "required",
        }),
        expect.objectContaining({
          name: "packager",
          version: "20.3.0",
          scope: "excluded",
        }),
      ]),
    );
    expect(JSON.stringify(first)).not.toMatch(
      /accessToken|uploadToken|launch_ticket|patient|transcript/iu,
    );
  });

  it("refuses incomplete targets and non-absolute output paths", async () => {
    await expect(generateDesktopSbom("win32-x64")).rejects.toThrow(
      "SBOM target runtime is not configured",
    );
    expect(() =>
      parseArguments([
        "--target",
        "darwin-arm64",
        "--out",
        "desktop.cdx.json",
      ]),
    ).toThrow("SBOM arguments are invalid");
  });

  it("keeps generation local, create-only, and independent of ambient secrets", async () => {
    const source = await readFile(
      new URL("../scripts/generate-desktop-sbom.mjs", import.meta.url),
      "utf8",
    );
    const packageMetadata = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(source).toContain('flag: "wx"');
    expect(source).toContain("clinicalReleaseApproved !== false");
    expect(source).toContain("unsignedDistributionAllowed !== false");
    expect(source).not.toContain("process.env");
    expect(packageMetadata.scripts["release:sbom"]).toBe(
      "node scripts/generate-desktop-sbom.mjs",
    );
  });
});
