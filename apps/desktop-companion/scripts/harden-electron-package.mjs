import { access, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

const appRoot = new URL("../", import.meta.url);
const policy = JSON.parse(
  await readFile(new URL("release/package-policy.json", appRoot), "utf8"),
);

if (
  policy.release.packagingEnabled !== true ||
  policy.toolchain.assemblerSigningEnabled !== false ||
  policy.toolchain.externalSigningRequired !== true ||
  policy.toolchain.recallOsxSignForkAllowed !== false
) {
  throw new Error("Desktop release packaging is not approved");
}
if (process.argv.length !== 4 || process.argv[2] !== "--executable") {
  throw new Error("Expected one absolute packaged Electron executable path");
}
const requestedPath = process.argv[3];
if (typeof requestedPath !== "string" || !isAbsolute(requestedPath)) {
  throw new Error("Expected one absolute packaged Electron executable path");
}
await access(requestedPath);
const executablePath = await realpath(requestedPath);
if (!(await stat(executablePath)).isFile()) {
  throw new Error("Packaged Electron executable is not a file");
}

const vendorRequire = createRequire(
  new URL("vendor-runtime/package.json", appRoot),
);
const { flipFuses, getCurrentFuseWire, FuseV1Options, FuseVersion } =
  vendorRequire("@electron/fuses");
const fuseConfig = {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: true,
  strictlyRequireAllFuses: true,
  [FuseV1Options.RunAsNode]: policy.fuses.runAsNode,
  [FuseV1Options.EnableCookieEncryption]: policy.fuses.cookieEncryption,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]:
    policy.fuses.nodeOptionsEnvironmentVariable,
  [FuseV1Options.EnableNodeCliInspectArguments]:
    policy.fuses.nodeCliInspectArguments,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:
    policy.fuses.embeddedAsarIntegrityValidation,
  [FuseV1Options.OnlyLoadAppFromAsar]: policy.fuses.onlyLoadAppFromAsar,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]:
    policy.fuses.browserProcessSpecificV8Snapshot,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]:
    policy.fuses.fileProtocolExtraPrivileges,
};

await flipFuses(executablePath, fuseConfig);
const applied = await getCurrentFuseWire(executablePath);
for (const [key, expected] of Object.entries(fuseConfig)) {
  const expectedState = expected === true ? 49 : 48;
  if (/^\d+$/u.test(key) && applied[key] !== expectedState) {
    throw new Error("Packaged Electron fuse verification failed");
  }
}
process.stdout.write("Packaged Electron fuses verified; sign the artifact next.\n");
