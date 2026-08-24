import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPackagerOptions,
  hashTree,
  isSafeLockPath,
  parseArguments,
  restoreApprovedRuntimeSymlinks,
  selectPackagerExport,
  verifyAsarIntegrityHeader,
} from "../scripts/assemble-electron-package.mjs";
import { parseArguments as parseHardeningArguments } from "../scripts/harden-electron-package.mjs";
import {
  isIgnoredProvenanceArchive,
  isRecallRuntimeCode,
  parseArguments as parseSigningArguments,
  verifySigningInventory,
} from "../scripts/sign-notarize-macos-package.mjs";

describe("Electron package release policy", () => {
  it("permits development assembly while keeping capture, clinical, and distribution gates off", async () => {
    const policy = JSON.parse(
      await readFile(
        new URL("../release/package-policy.json", import.meta.url),
        "utf8",
      ),
    ) as {
      release: Record<string, boolean>;
      application: { protocol: string };
      toolchain: Record<string, unknown>;
      electronArchives: Record<string, unknown>;
      runtimeTrees: Record<string, unknown>;
      archive: Record<string, unknown>;
      diagnostics: Record<string, boolean>;
      targets: Record<string, Record<string, unknown>>;
      fuses: Record<string, boolean>;
    };
    expect(policy.release).toEqual({
      packagingEnabled: true,
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
      assemblerFrameworkResignAllowed: false,
      externalSigningRequired: true,
      recallOsxSignForkAllowed: false,
      fuseHardeningLaneApproved: true,
      fuseTool: "@electron/fuses",
      fuseToolVersion: "2.1.3",
      fuseToolIntegritySha512:
        "sha512-LoKJUXNiJ4JM8IIrUltSHI+8pkogaGj5wmJx81jE/Wk3g2w1/kfMbTEKNoY5kitGE8hiC12h32R/1SlywFtxXg==",
      macosSigningLaneApproved: true,
      macosNotarizationLaneApproved: true,
      macosSigner: "@electron/osx-sign",
      macosSignerVersion: "2.7.0",
      macosSignerIntegritySha512:
        "sha512-9DGhNqKMl6ibkhUoXbN7OHX2gZznfY10L3ZwG0u6r667Kfb6kec4JEfFTXftoqzmOfZ+OzwDbr4p/nKBMHnz0g==",
      macosNotarizer: "@electron/notarize",
      macosNotarizerVersion: "3.1.1",
      macosNotarizerIntegritySha512:
        "sha512-uQQSlOiJnqRkTL1wlEBAxe90nVN/Fc/hEmk0bqpKk8nKjV1if/tXLHKUPePtv9Xsx90PtZU8aidx5lAiOpjkQQ==",
    });
    expect(policy.electronArchives).toEqual({
      version: "43.4.1",
      releaseTag: "v43.4.1",
      targets: {
        "darwin-arm64": {
          filename: "electron-v43.4.1-darwin-arm64.zip",
          sha256:
            "fe3cac8cbfd9ba1739fac6c69166cf30848741f93cbe251d800ae6ef7cebb64b",
        },
        "win32-x64": {
          filename: "electron-v43.4.1-win32-x64.zip",
          sha256:
            "c2ef9a5f65472c34d14bd3e67b7d14e66b0c01f124aba45263d6a4232160e13a",
        },
      },
    });
    expect(policy.archive).toEqual({
      asarRequired: true,
      embeddedIntegrityRequired: true,
      smartUnpackAllowed: false,
      unpackedRuntimePath:
        "vendor-runtime/node_modules/@recallai/desktop-sdk",
    });
    expect(policy.runtimeTrees).toMatchObject({
      targets: {
        "darwin-arm64": {
          "node_modules/@recallai/desktop-sdk":
            "70d2d63210f4e9b36ecdda7b441caf3707dc2f7f1653567ddf95bbc63001ce4c",
        },
        "win32-x64": {
          "node_modules/@recallai/desktop-sdk": "UNCONFIGURED",
        },
      },
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
      wasmTrapHandlers: true,
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
    expect(source).toContain("FuseV1Options.WasmTrapHandlers");
    expect(source).toContain('join(resourcesPath, "app.asar")');
    expect(source).toContain('requireAbsent(join(resourcesPath, "app"))');
    expect(source).toContain("packagingEnabled !== true");
    expect(source).toContain("recallOsxSignForkAllowed !== false");
    expect(source).toContain("assemblerFrameworkResignAllowed !== false");
    expect(source).toContain("verifyUnpackedRuntimeBoundary(resourcesPath)");
    expect(source).toContain("verifyEmbeddedAsarIntegrity(info, applicationPath)");
    expect(source).toContain("ElectronAsarIntegrity");
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
    expect(source).toContain("fuseHardeningLaneApproved !== true");
    expect(source).toContain("getCurrentFuseWire");
    expect(source).toContain("HARDENING-INCOMPLETE");
    expect(source).toContain("assembly-receipt-darwin-arm64.json");
    expect(source).toContain("preHardenedPackageTreeSha256");
    expect(source).toContain("ElectronAsarIntegrity");
    expect(source).not.toContain("process.env");
  });

  it("ships a copy-on-write nested-code signing and notarization lane", async () => {
    const source = await readFile(
      new URL(
        "../scripts/sign-notarize-macos-package.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    const packageMetadata = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(source).toContain("macosSigningLaneApproved !== true");
    expect(source).toContain("macosNotarizationLaneApproved !== true");
    expect(source).toContain("temporary-ci-keychain");
    expect(source).toContain("Developer ID Application:");
    expect(source).toContain("preAutoEntitlements: false");
    expect(source).toContain("preEmbedProvisioningProfile: false");
    expect(source).toContain("native-darwin-arm64.tar");
    expect(source).toContain("registry-package.tgz");
    expect(source).toContain("entitlements: []");
    expect(source).toContain("verifyNestedSignatures(inventory.codePaths)");
    expect(source).toContain("keychainProfile: request.notaryProfile");
    expect(source).toContain("SIGNING-NOTARIZATION-INCOMPLETE");
    expect(source).toContain("distributionAllowed: false");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("appleIdPassword");
    expect(source).not.toContain("appleApiKey");
    expect(packageMetadata.scripts["release:sign-notarize:macos"]).toBe(
      "node scripts/sign-notarize-macos-package.mjs",
    );
  });

  it("accepts only explicit absolute hardening and signing inputs", () => {
    expect(
      parseHardeningArguments([
        "--application",
        "/private/tmp/Cosmas Desktop Companion.app",
        "--assembly-receipt",
        "/private/tmp/assembly-receipt-darwin-arm64.json",
        "--out",
        "/private/tmp/cosmas-hardened",
        "--source-sha",
        "a".repeat(40),
      ]),
    ).toMatchObject({
      application: "/private/tmp/Cosmas Desktop Companion.app",
      out: "/private/tmp/cosmas-hardened",
      sourceSha: "a".repeat(40),
    });
    expect(() =>
      parseHardeningArguments([
        "--application",
        "relative.app",
        "--assembly-receipt",
        "/private/tmp/receipt.json",
        "--out",
        "/private/tmp/output",
        "--source-sha",
        "a".repeat(40),
      ]),
    ).toThrow();

    expect(
      parseSigningArguments([
        "--application",
        "/private/tmp/Cosmas Desktop Companion.app",
        "--hardening-receipt",
        "/private/tmp/hardening-receipt-darwin-arm64.json",
        "--identity-sha1",
        "A".repeat(40),
        "--keychain",
        "/private/tmp/cosmas-signing.keychain-db",
        "--notary-profile",
        "cosmas-notary",
        "--out",
        "/private/tmp/cosmas-signed",
        "--source-sha",
        "b".repeat(40),
      ]),
    ).toMatchObject({
      identitySha1: "A".repeat(40),
      notaryProfile: "cosmas-notary",
      sourceSha: "b".repeat(40),
    });
    expect(() =>
      parseSigningArguments([
        "--application",
        "/private/tmp/Cosmas Desktop Companion.app",
        "--hardening-receipt",
        "/private/tmp/receipt.json",
        "--identity-sha1",
        "A".repeat(40),
        "--keychain",
        "/private/tmp/keychain",
        "--notary-profile",
        "profile with spaces",
        "--out",
        "/private/tmp/output",
        "--source-sha",
        "b".repeat(40),
      ]),
    ).toThrow();
  });

  it("ignores only the two receipt-bound Recall provenance archives", async () => {
    const application = "/private/tmp/Cosmas Desktop Companion.app";
    const recallRoot = join(
      application,
      "Contents/Resources/app.asar.unpacked/vendor-runtime/node_modules/@recallai/desktop-sdk",
    );
    const nativeArchive = join(
      recallRoot,
      ".cosmas-provenance/native-darwin-arm64.tar",
    );
    const registryArchive = join(
      recallRoot,
      ".cosmas-provenance/registry-package.tgz",
    );
    const archives = [nativeArchive, registryArchive];
    const binary = join(recallRoot, "native/darwin-arm64/recallai-desktop-sdk");
    expect(archives.every((path) => isIgnoredProvenanceArchive(application, path))).toBe(
      true,
    );
    expect(isIgnoredProvenanceArchive(application, binary)).toBe(false);
    expect(isRecallRuntimeCode(application, binary)).toBe(true);
    await expect(
      verifySigningInventory(application, async () => [...archives, binary]),
    ).resolves.toMatchObject({
      discoveredCodeObjects: 2,
      ignoredProvenanceArchives: [
        "Resources/app.asar.unpacked/vendor-runtime/node_modules/@recallai/desktop-sdk/.cosmas-provenance/native-darwin-arm64.tar",
        "Resources/app.asar.unpacked/vendor-runtime/node_modules/@recallai/desktop-sdk/.cosmas-provenance/registry-package.tgz",
      ],
    });
    await expect(
      verifySigningInventory(application, async () => [nativeArchive, binary]),
    ).rejects.toThrow();
  });

  it("ships a fixed-input unsigned assembler behind the packaging gate", async () => {
    const source = await readFile(
      new URL("../scripts/assemble-electron-package.mjs", import.meta.url),
      "utf8",
    );
    const packageMetadata = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(source).toContain("policy.release.packagingEnabled !== true");
    expect(source).toContain('electronZipDir: dirname(electronZip)');
    expect(source).toContain("verifyRecallSdkRuntime");
    expect(source).toContain("smartUnpack: false");
    expect(source).toContain("asarIntegrityDigest: false");
    expect(source).toContain("overwrite: false");
    expect(source).toContain("await realpath(tmpdir())");
    expect(source).toContain("ASSEMBLY-INCOMPLETE");
    expect(source).toContain("getRawHeader");
    expect(source).not.toContain("download:");
    expect(source).not.toContain("osxSign:");
    expect(source).not.toContain("osxNotarize:");
    expect(source).not.toContain("windowsSign:");
    expect(source).not.toContain("process.env");
    expect(packageMetadata.scripts["release:assemble"]).toBe(
      "node scripts/assemble-electron-package.mjs",
    );
    expect(packageMetadata.scripts.build).toContain(
      "node scripts/clean-dist.mjs && tsc",
    );
  });

  it("constructs assembly options with no network, overwrite, or signing path", () => {
    const options = createPackagerOptions({
      electronZip: "/private/tmp/electron-v43.4.1-darwin-arm64.zip",
      outputRoot: "/private/tmp/cosmas-output",
      packagerTemporaryRoot: "/private/tmp/cosmas-packager",
      stagingRoot: "/private/tmp/cosmas-stage",
      target: { arch: "arm64", platform: "darwin" },
    });
    expect(options).toMatchObject({
      arch: "arm64",
      asar: {
        smartUnpack: false,
        unpackDir: "vendor-runtime/node_modules/@recallai/desktop-sdk",
      },
      asarIntegrityDigest: false,
      electronVersion: "43.4.1",
      electronZipDir: "/private/tmp",
      overwrite: false,
      platform: "darwin",
      prune: false,
      quiet: true,
    });
    expect(options).not.toHaveProperty("download");
    expect(options).not.toHaveProperty("osxSign");
    expect(options).not.toHaveProperty("osxNotarize");
    expect(options).not.toHaveProperty("windowsSign");
    const ignore = options.ignore as (path: string) => boolean;
    expect(ignore("vendor-runtime/package-lock.json")).toBe(false);
    const afterCopy = options.afterCopy as readonly unknown[];
    expect(afterCopy).toHaveLength(1);
    expect(afterCopy[0]).toBeTypeOf("function");
    const exactPackagerExport = () => undefined;
    expect(selectPackagerExport({ packager: exactPackagerExport })).toBe(
      exactPackagerExport,
    );
  });

  it("restores only approved internal runtime symlinks after Packager copies", async () => {
    const temporaryRoot = await mkdtemp(
      join(await realpath(tmpdir()), "cosmas-symlink-copy-test-"),
    );
    try {
      const stagingRoot = join(temporaryRoot, "stage");
      const buildPath = join(temporaryRoot, "build");
      const runtimePath = join(
        "vendor-runtime",
        "node_modules",
        "@recallai",
        "desktop-sdk",
      );
      const sourceRoot = join(stagingRoot, runtimePath);
      const destinationRoot = join(buildPath, runtimePath);
      await mkdir(join(sourceRoot, "Versions", "1.0"), { recursive: true });
      await writeFile(join(sourceRoot, "Versions", "1.0", "runtime"), "fixed\n");
      await symlink("1.0", join(sourceRoot, "Versions", "Current"));
      await symlink(
        "Versions/Current/runtime",
        join(sourceRoot, "runtime"),
      );
      await mkdir(join(buildPath, "vendor-runtime", "node_modules", "@recallai"), {
        recursive: true,
      });
      await cp(sourceRoot, destinationRoot, {
        dereference: false,
        recursive: true,
      });

      expect(await readlink(join(destinationRoot, "runtime"))).not.toBe(
        "Versions/Current/runtime",
      );
      await restoreApprovedRuntimeSymlinks(stagingRoot, buildPath);
      expect(await readlink(join(destinationRoot, "runtime"))).toBe(
        "Versions/Current/runtime",
      );
      expect(await readlink(join(destinationRoot, "Versions", "Current"))).toBe(
        "1.0",
      );
      expect(await hashTree(destinationRoot)).toBe(await hashTree(sourceRoot));
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("validates exact CLI shape, lock paths, and ASAR integrity records", () => {
    const sha = "a".repeat(40);
    expect(
      parseArguments([
        "--target",
        "darwin-arm64",
        "--electron-zip",
        "/private/tmp/electron-v43.4.1-darwin-arm64.zip",
        "--out",
        "/private/tmp/cosmas-output",
        "--source-sha",
        sha,
      ]),
    ).toEqual({
      target: "darwin-arm64",
      electronZip:
        "/private/tmp/electron-v43.4.1-darwin-arm64.zip",
      out: "/private/tmp/cosmas-output",
      sourceSha: sha,
    });
    expect(() =>
      parseArguments([
        "--target",
        "darwin-arm64",
        "--electron-zip",
        "relative.zip",
        "--out",
        "/private/tmp/cosmas-output",
        "--source-sha",
        sha,
      ]),
    ).toThrow();
    expect(isSafeLockPath("node_modules/@recallai/desktop-sdk")).toBe(true);
    expect(isSafeLockPath("node_modules/../outside")).toBe(false);
    const validHeader = {
      files: {
        "main.js": {
          integrity: {
            algorithm: "SHA256",
            hash: "b".repeat(64),
            blockSize: 1024,
            blocks: ["c".repeat(64)],
          },
        },
      },
    };
    expect(() => verifyAsarIntegrityHeader(validHeader)).not.toThrow();
    expect(() =>
      verifyAsarIntegrityHeader({
        files: { "main.js": { integrity: { algorithm: "SHA256" } } },
      }),
    ).toThrow();
  });
});
