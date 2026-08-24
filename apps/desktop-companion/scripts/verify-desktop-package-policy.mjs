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

assertExactKeys(policy, [
  "schemaVersion",
  "application",
  "release",
  "toolchain",
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
  "externalSigningRequired",
  "recallOsxSignForkAllowed",
]);
assertExactKeys(policy.archive, ["asarRequired", "embeddedIntegrityRequired"]);
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

for (const value of Object.values(policy.release)) {
  assert(value === false);
}
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

assert(policy.archive.asarRequired === true);
assert(policy.archive.embeddedIntegrityRequired === true);
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
