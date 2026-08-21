import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertRecallClinicalReleaseApproved,
  assertRecallNativeRuntimeEvidence,
  classifyRecallWrapperHashes,
  loadVerifiedRecallSdk,
  type RecallNativeRuntimeEvidenceComparison,
} from "./recall-sdk-loader.js";
import { normalizeRecallNativeArchiveEntry } from "../archive-safety.mjs";

const expected = Object.freeze({
  upstreamIndexHash:
    "a39e7aa9b81c3458bd82a552fad256fa7f2cb6468e4b9f6ad3f73ad836c9199d",
  upstreamSetupHash:
    "f8ccce0f54529d436a8a629111755345da0c3f8ca5573b086785325d99b2d680",
  patchedIndexHash:
    "b6aad972672ed3b743251f3aecd95977fe80e4992c705f0b16114c8089147928",
  patchedSetupHash:
    "1e88e4dc834549484044a301979e18dcbc677af5f0c577e4d60c87b4d7d7db2e",
});

const nativeEvidence: RecallNativeRuntimeEvidenceComparison = Object.freeze({
  packageTarballSha256: "package-hash",
  expectedPackageTarballSha256: "package-hash",
  nativeArchiveSha256: "archive-hash",
  expectedNativeArchiveSha256: "archive-hash",
  archiveTreeSha256: "tree-hash",
  receiptArchiveTreeSha256: "tree-hash",
  receiptNativeTreeSha256: "tree-hash",
  extractedNativeTreeSha256: "tree-hash",
});

describe("Recall runtime provenance", () => {
  it("rejects the genuine but unpatched vendor wrapper for runtime loading", () => {
    expect(() =>
      classifyRecallWrapperHashes(
        {
          indexHash: expected.upstreamIndexHash,
          setupHash: expected.upstreamSetupHash,
        },
        expected,
      ),
    ).toThrow("not the exact reviewed patched source");
  });

  it("rejects any unreviewed source and accepts only both patched hashes", () => {
    expect(() =>
      classifyRecallWrapperHashes(
        {
          indexHash: expected.patchedIndexHash,
          setupHash: "unreviewed",
        },
        expected,
      ),
    ).toThrow();
    expect(
      classifyRecallWrapperHashes(
        {
          indexHash: expected.patchedIndexHash,
          setupHash: expected.patchedSetupHash,
        },
        expected,
      ),
    ).toBe("patched");
  });

  it("pins the independent package/native hashes and keeps clinical release false", async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL("../vendor/recall-desktop-sdk.provenance.json", import.meta.url),
        "utf8",
      ),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      clinicalReleaseApproved: false,
      package: {
        version: "2.0.28",
        registryTarballSha256:
          "3c427d51dae415941ec6469cc44e244d2c1d23e9a2a0cad92d6cccb04055d0de",
      },
      electron: { version: "43.4.1" },
      nativeArtifacts: {
        "darwin-arm64": {
          sha256:
            "1636d46c83eb2394d6ad643aaaa59731f3f0ad39b9532d8ebeea4b3805fd44de",
        },
        "win32-x64": {
          sha256:
            "dfffb3c7bc36bf6329cd1eb89185880fed0a633927b90f47d86d654170be0467",
        },
      },
    });
  });

  it("rejects clinical loading until the reviewed manifest explicitly approves it", () => {
    expect(() => assertRecallClinicalReleaseApproved(false)).toThrow(
      "not approved for clinical use",
    );
    expect(() => assertRecallClinicalReleaseApproved(undefined)).toThrow();
    expect(() => assertRecallClinicalReleaseApproved(true)).not.toThrow();
  });

  it("rejects the checked-in clinical-false manifest before touching a native runtime", async () => {
    const manifestPath = new URL(
      "../vendor/recall-desktop-sdk.provenance.json",
      import.meta.url,
    );
    await expect(
      loadVerifiedRecallSdk({
        manifestPath: fileURLToPath(manifestPath),
        runtimeRoot: "/does-not-exist/runtime",
        sdkRoot: "/does-not-exist/sdk",
      }),
    ).rejects.toThrow("not approved for clinical use");
  });

  it("rejects archive path and symlink traversal, including Windows separators", () => {
    const roots = ["Frameworks", "desktop_sdk_macos_exe"] as const;
    expect(
      normalizeRecallNativeArchiveEntry(
        "Frameworks/lib/example.dylib",
        undefined,
        roots,
      ),
    ).toBe("Frameworks/lib/example.dylib");
    expect(
      normalizeRecallNativeArchiveEntry(
        "Frameworks/link",
        "lib/example.dylib",
        roots,
      ),
    ).toBe("Frameworks/link");
    expect(() =>
      normalizeRecallNativeArchiveEntry("../outside", undefined, roots),
    ).toThrow("unsafe path");
    expect(() =>
      normalizeRecallNativeArchiveEntry("/absolute", undefined, roots),
    ).toThrow("unsafe path");
    expect(() =>
      normalizeRecallNativeArchiveEntry(
        "Frameworks/link",
        "../../outside",
        roots,
      ),
    ).toThrow("unsafe link");
    expect(() =>
      normalizeRecallNativeArchiveEntry(
        "Frameworks/link",
        "..\\..\\outside",
        roots,
      ),
    ).toThrow("unsafe link");
    for (const target of [
      "C:\\outside",
      "C:/outside",
      "C:outside",
      "\\\\server\\share\\outside",
    ]) {
      expect(() =>
        normalizeRecallNativeArchiveEntry("Frameworks/link", target, roots),
      ).toThrow("unsafe link");
    }
  });

  it("rejects tampered package/native archives and every mutable tree receipt", () => {
    expect(() => assertRecallNativeRuntimeEvidence(nativeEvidence)).not.toThrow();
    for (const altered of [
      { packageTarballSha256: "tampered" },
      { nativeArchiveSha256: "tampered" },
      { archiveTreeSha256: "tampered" },
      { receiptArchiveTreeSha256: "tampered" },
      { receiptNativeTreeSha256: "tampered" },
      { extractedNativeTreeSha256: "tampered" },
    ]) {
      expect(() =>
        assertRecallNativeRuntimeEvidence({ ...nativeEvidence, ...altered }),
      ).toThrow("artifact verification failed");
    }
  });
});
