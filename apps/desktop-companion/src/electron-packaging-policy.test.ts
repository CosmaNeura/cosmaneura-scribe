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
      toolchain: Record<string, unknown>;
      diagnostics: Record<string, boolean>;
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
    expect(policy.toolchain).toEqual({
      assembler: "@electron/packager",
      assemblerVersion: "20.3.0",
      assemblerIntegritySha512:
        "sha512-3MvgJgy6YJ5ti0oGGBKrWKdYwpTaoRrhranMDgHSQ6i5t56yZV9IRDyoXTuqBp97LiKqnZeAMe2wTcF/9+fP5g==",
      assemblerSigningEnabled: false,
      externalSigningRequired: true,
      recallOsxSignForkAllowed: false,
    });
    expect(Object.values(policy.diagnostics)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(policy.targets["darwin-arm64"]).toMatchObject({
      signatureRequired: true,
      notarizationRequired: true,
      stapleRequired: true,
      hardenedRuntimeRequired: true,
      secureTimestampRequired: true,
      debugEntitlementDenied: true,
      expectedTeamIdentifier: "UNCONFIGURED",
    });
    expect(policy.targets["win32-x64"]).toMatchObject({
      signatureRequired: true,
      timestampRequired: true,
      expectedPublisherSubject: "UNCONFIGURED",
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

  it("ships a fail-closed verifier for both signed artifact sets", async () => {
    const source = await readFile(
      new URL("../scripts/verify-signed-desktop-artifacts.mjs", import.meta.url),
      "utf8",
    );
    const windowsPublisher = await readFile(
      new URL("../scripts/verify-windows-publisher.ps1", import.meta.url),
      "utf8",
    );
    expect(source).toContain('runVerified("codesign"');
    expect(source).toContain('runVerified("spctl"');
    expect(source).toContain('runVerified("xcrun", ["stapler", "validate"');
    expect(source).toContain('runVerified("SignTool.exe"');
    expect(source).toContain('"/tw"');
    expect(source).toContain("getCurrentFuseWire");
    expect(source).toContain('join(resourcesPath, "app.asar")');
    expect(source).toContain('requireAbsent(join(resourcesPath, "app"))');
    expect(source).toContain("packagingEnabled !== true");
    expect(source).toContain("recallOsxSignForkAllowed !== false");
    expect(source).not.toContain("process.env");
    expect(windowsPublisher).toContain("Get-AuthenticodeSignature -LiteralPath");
    expect(windowsPublisher).toContain("TimeStamperCertificate");
    expect(windowsPublisher).toContain("-cne $ExpectedPublisherSubject");
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
