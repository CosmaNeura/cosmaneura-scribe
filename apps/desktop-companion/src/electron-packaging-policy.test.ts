import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Electron package release policy", () => {
  it("requires signed distribution and keeps package and clinical gates off", async () => {
    const policy = JSON.parse(
      await readFile(
        new URL("../release/package-policy.json", import.meta.url),
        "utf8",
      ),
    ) as {
      release: Record<string, boolean>;
      application: { protocol: string };
      targets: Record<string, Record<string, unknown>>;
      fuses: Record<string, boolean>;
    };
    expect(policy.release).toEqual({
      packagingEnabled: false,
      captureEnabled: false,
      clinicalReleaseApproved: false,
      unsignedDistributionAllowed: false,
    });
    expect(policy.application.protocol).toBe("cosmaneura-capture");
    expect(policy.targets["darwin-arm64"]).toMatchObject({
      signatureRequired: true,
      notarizationRequired: true,
      stapleRequired: true,
    });
    expect(policy.targets["win32-x64"]).toMatchObject({
      signatureRequired: true,
      timestampRequired: true,
    });
    expect(policy.fuses).toEqual({
      runAsNode: false,
      cookieEncryption: true,
      nodeOptionsEnvironmentVariable: false,
      nodeCliInspectArguments: false,
      embeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      browserProcessSpecificV8Snapshot: true,
      fileProtocolExtraPrivileges: false,
    });
  });

  it("keeps fuse mutation fail-closed until packaging is approved", async () => {
    const source = await readFile(
      new URL("../scripts/harden-electron-package.mjs", import.meta.url),
      "utf8",
    );
    expect(source).toContain("strictlyRequireAllFuses: true");
    expect(source).toContain("packagingEnabled !== true");
    expect(source).toContain("getCurrentFuseWire");
    expect(source).not.toContain("process.env");
  });
});
