import { readFile } from "node:fs/promises";

const appRoot = new URL("../", import.meta.url);
const policy = JSON.parse(
  await readFile(new URL("release/package-policy.json", appRoot), "utf8"),
);
const appPackage = JSON.parse(
  await readFile(new URL("package.json", appRoot), "utf8"),
);
const vendorPackage = JSON.parse(
  await readFile(new URL("vendor-runtime/package.json", appRoot), "utf8"),
);
const vendorLock = JSON.parse(
  await readFile(new URL("vendor-runtime/package-lock.json", appRoot), "utf8"),
);
const provenance = JSON.parse(
  await readFile(
    new URL("vendor/recall-desktop-sdk.provenance.json", appRoot),
    "utf8",
  ),
);
const releaseSource = await readFile(new URL("src/config.ts", appRoot), "utf8");
const handoffSource = await readFile(
  new URL("src/browser-handoff.ts", appRoot),
  "utf8",
);
const assemblySource = await readFile(
  new URL("scripts/assemble-electron-package.mjs", appRoot),
  "utf8",
);

assertExactKeys(policy, [
  "schemaVersion",
  "application",
  "release",
  "toolchain",
  "electronArchives",
  "runtimeTrees",
  "archive",
  "diagnostics",
  "fuses",
  "targets",
]);
assertExactKeys(policy.application, [
  "bundleIdentifier",
  "productName",
  "main",
  "protocol",
]);
assertExactKeys(policy.release, [
  "packagingEnabled",
  "captureEnabled",
  "clinicalReleaseApproved",
  "unsignedDistributionAllowed",
]);
assertExactKeys(policy.toolchain, [
  "assembler",
  "assemblerVersion",
  "assemblerIntegritySha512",
  "assemblerSigningEnabled",
  "assemblerFrameworkResignAllowed",
  "externalSigningRequired",
  "recallOsxSignForkAllowed",
]);
assertExactKeys(policy.electronArchives, ["version", "releaseTag", "targets"]);
assertExactKeys(policy.electronArchives.targets, [
  "darwin-arm64",
  "win32-x64",
]);
for (const target of Object.values(policy.electronArchives.targets)) {
  assertExactKeys(target, ["filename", "sha256"]);
}
assertExactKeys(policy.runtimeTrees, ["common", "targets"]);
assertExactKeys(policy.runtimeTrees.common, [
  "node_modules/@isaacs/fs-minipass",
  "node_modules/chownr",
  "node_modules/minipass",
  "node_modules/minizlib",
  "node_modules/tar",
  "node_modules/uuid",
  "node_modules/yallist",
]);
assertExactKeys(policy.runtimeTrees.targets, ["darwin-arm64", "win32-x64"]);
for (const target of Object.values(policy.runtimeTrees.targets)) {
  assertExactKeys(target, ["node_modules/@recallai/desktop-sdk"]);
}
assertExactKeys(policy.archive, [
  "asarRequired",
  "embeddedIntegrityRequired",
  "smartUnpackAllowed",
  "unpackedRuntimePath",
]);
assertExactKeys(policy.diagnostics, [
  "analyticsEnabled",
  "chromiumLoggingEnabled",
  "electronCrashReporterStarted",
  "localElectronCrashDumpsAllowed",
  "nodeDiagnosticReportsEnabled",
  "remoteDebuggingEnabled",
  "supportBundlesEnabled",
]);
assertExactKeys(policy.fuses, [
  "runAsNode",
  "cookieEncryption",
  "nodeOptionsEnvironmentVariable",
  "nodeCliInspectArguments",
  "embeddedAsarIntegrityValidation",
  "onlyLoadAppFromAsar",
  "browserProcessSpecificV8Snapshot",
  "fileProtocolExtraPrivileges",
]);
assertExactKeys(policy.targets, ["darwin-arm64", "win32-x64"]);
assertExactKeys(policy.targets["darwin-arm64"], [
  "signatureRequired",
  "notarizationRequired",
  "stapleRequired",
  "hardenedRuntimeRequired",
  "secureTimestampRequired",
  "debugEntitlementDenied",
  "expectedTeamIdentifier",
  "credentialSource",
]);
assertExactKeys(policy.targets["win32-x64"], [
  "signatureRequired",
  "timestampRequired",
  "expectedPublisherSubject",
  "credentialSource",
]);

assert(policy.schemaVersion === 1);
assert(policy.application.bundleIdentifier === "com.cosmaneura.desktop-companion");
assert(policy.application.productName === appPackage.productName);
assert(policy.application.main === appPackage.main);
assert(policy.application.protocol === "cosmaneura-capture");
assert(handoffSource.includes('DESKTOP_CUSTOM_SCHEME = "cosmaneura-capture"'));

assert(policy.release.packagingEnabled === true);
assert(policy.release.captureEnabled === false);
assert(policy.release.clinicalReleaseApproved === false);
assert(policy.release.unsignedDistributionAllowed === false);
for (const value of Object.values(policy.diagnostics)) {
  assert(value === false);
}
assert(releaseSource.includes("captureEnabled: false"));
assert(releaseSource.includes("clinicalReleaseApproved: false"));
assert(releaseSource.includes("packagingEnabled: false"));
assert(provenance.clinicalReleaseApproved === false);

assert(policy.toolchain.assembler === "@electron/packager");
assert(policy.toolchain.assemblerVersion === "20.3.0");
assert(
  policy.toolchain.assemblerIntegritySha512 ===
    "sha512-3MvgJgy6YJ5ti0oGGBKrWKdYwpTaoRrhranMDgHSQ6i5t56yZV9IRDyoXTuqBp97LiKqnZeAMe2wTcF/9+fP5g==",
);
assert(policy.toolchain.assemblerSigningEnabled === false);
assert(policy.toolchain.assemblerFrameworkResignAllowed === false);
assert(policy.toolchain.externalSigningRequired === true);
assert(policy.toolchain.recallOsxSignForkAllowed === false);
assert(vendorPackage.devDependencies["@electron/packager"] === "20.3.0");
const lockPackages = vendorLock.packages;
const packagerLock = lockPackages["node_modules/@electron/packager"];
assert(packagerLock.version === policy.toolchain.assemblerVersion);
assert(packagerLock.integrity === policy.toolchain.assemblerIntegritySha512);
const installScripts = Object.entries(lockPackages)
  .filter(([, value]) => value.hasInstallScript === true)
  .map(([name]) => name);
assert(
  installScripts.length === 1 &&
    installScripts[0] === "node_modules/@recallai/desktop-sdk",
);
for (const [name, value] of Object.entries(lockPackages)) {
  if (name === "") {
    continue;
  }
  assert(
    typeof value.integrity === "string" &&
      value.integrity.startsWith("sha512-"),
  );
  assert(
    typeof value.resolved === "string" &&
      value.resolved.startsWith("https://registry.npmjs.org/"),
  );
}

assert(policy.electronArchives.version === "43.4.1");
assert(policy.electronArchives.releaseTag === "v43.4.1");
assert(
  policy.electronArchives.targets["darwin-arm64"].filename ===
    "electron-v43.4.1-darwin-arm64.zip",
);
assert(
  policy.electronArchives.targets["darwin-arm64"].sha256 ===
    "fe3cac8cbfd9ba1739fac6c69166cf30848741f93cbe251d800ae6ef7cebb64b",
);
assert(
  policy.electronArchives.targets["win32-x64"].filename ===
    "electron-v43.4.1-win32-x64.zip",
);
assert(
  policy.electronArchives.targets["win32-x64"].sha256 ===
    "c2ef9a5f65472c34d14bd3e67b7d14e66b0c01f124aba45263d6a4232160e13a",
);
assert(provenance.electron.version === policy.electronArchives.version);
assert(
  JSON.stringify(policy.runtimeTrees.common) ===
    JSON.stringify({
      "node_modules/@isaacs/fs-minipass":
        "b104ba398bbf9484ce9315a97f8f92950103b38bba81f798114c8d03c5180891",
      "node_modules/chownr":
        "2879f1ec936ea9d238391e7448029980d2215b4c23e2584891394f71ded4de21",
      "node_modules/minipass":
        "ee029226e749284887a6a6d133ff1f01ac1d1cebd5eb800672910b870f57a085",
      "node_modules/minizlib":
        "ea58205b22c7d8ab12d0cbb06bac53d677238da62de243e09ada24a43cee2afd",
      "node_modules/tar":
        "d2ab2f4e418883c60a1d746fe41bda030f7845e78d1584227d06bd83614ef2d9",
      "node_modules/uuid":
        "bb998af9499180ee2131a0c4082b7c2f01e769b678fa75432144a0135141a7aa",
      "node_modules/yallist":
        "e51fead38427770025810db2bec4d0e92f0b3e9e634948ce4dce3e2715873aa3",
    }),
);
assert(
  policy.runtimeTrees.targets["darwin-arm64"][
    "node_modules/@recallai/desktop-sdk"
  ] === "70d2d63210f4e9b36ecdda7b441caf3707dc2f7f1653567ddf95bbc63001ce4c",
);
assert(
  policy.runtimeTrees.targets["win32-x64"][
    "node_modules/@recallai/desktop-sdk"
  ] === "UNCONFIGURED",
);
assert(policy.archive.asarRequired === true);
assert(policy.archive.embeddedIntegrityRequired === true);
assert(policy.archive.smartUnpackAllowed === false);
assert(
  policy.archive.unpackedRuntimePath ===
    "vendor-runtime/node_modules/@recallai/desktop-sdk",
);
assert(assemblySource.includes("asarIntegrityDigest: false"));
assert(assemblySource.includes("electronZipDir: dirname(electronZip)"));
assert(assemblySource.includes("ignore: () => false"));
assert(!assemblySource.includes("osxSign:"));
assert(!assemblySource.includes("osxNotarize:"));
assert(!assemblySource.includes("windowsSign:"));
assert(!assemblySource.includes("download:"));
assert(policy.fuses.runAsNode === false);
assert(policy.fuses.cookieEncryption === true);
assert(policy.fuses.nodeOptionsEnvironmentVariable === false);
assert(policy.fuses.nodeCliInspectArguments === false);
assert(policy.fuses.embeddedAsarIntegrityValidation === true);
assert(policy.fuses.onlyLoadAppFromAsar === true);
assert(policy.fuses.browserProcessSpecificV8Snapshot === true);
assert(policy.fuses.fileProtocolExtraPrivileges === false);

assert(vendorPackage.devDependencies.electron === "43.4.1");
assert(vendorPackage.devDependencies["@electron/fuses"] === "1.8.0");
assert(policy.targets["darwin-arm64"].signatureRequired === true);
assert(policy.targets["darwin-arm64"].notarizationRequired === true);
assert(policy.targets["darwin-arm64"].stapleRequired === true);
assert(policy.targets["darwin-arm64"].hardenedRuntimeRequired === true);
assert(policy.targets["darwin-arm64"].secureTimestampRequired === true);
assert(policy.targets["darwin-arm64"].debugEntitlementDenied === true);
assert(policy.targets["darwin-arm64"].expectedTeamIdentifier === "UNCONFIGURED");
assert(policy.targets["win32-x64"].signatureRequired === true);
assert(policy.targets["win32-x64"].timestampRequired === true);
assert(policy.targets["win32-x64"].expectedPublisherSubject === "UNCONFIGURED");

process.stdout.write("Desktop package policy verified.\n");

function assert(condition) {
  if (!condition) {
    throw new Error("Desktop package policy verification failed");
  }
}

function assertExactKeys(value, expected) {
  assert(typeof value === "object" && value !== null && !Array.isArray(value));
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  assert(
    actual.length === sortedExpected.length &&
      actual.every((key, index) => key === sortedExpected[index]),
  );
}
