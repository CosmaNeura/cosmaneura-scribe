import {
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const appRoot = new URL("../", import.meta.url);
const policy = JSON.parse(
  await readFile(new URL("release/package-policy.json", appRoot), "utf8"),
);
const FAILURE_MESSAGE = "Signed desktop artifact verification failed";
const UNCONFIGURED = "UNCONFIGURED";

try {
  await main();
  process.stdout.write("Signed desktop artifacts verified.\n");
} catch {
  process.stderr.write(`${FAILURE_MESSAGE}.\n`);
  process.exitCode = 1;
}

async function main() {
  if (
    policy.release.packagingEnabled !== true ||
    policy.toolchain.assemblerSigningEnabled !== false ||
    policy.toolchain.assemblerFrameworkResignAllowed !== false ||
    policy.toolchain.externalSigningRequired !== true ||
    policy.toolchain.recallOsxSignForkAllowed !== false ||
    policy.archive.smartUnpackAllowed !== false ||
    policy.archive.unpackedRuntimePath !==
      "vendor-runtime/node_modules/@recallai/desktop-sdk"
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  const request = parseArguments(process.argv.slice(2));
  if (request.target === "darwin-arm64") {
    await verifyMacApplication(request.application);
    return;
  }
  await verifyWindowsArtifacts(request.application, request.installer);
}

function parseArguments(args) {
  if (
    args.length === 4 &&
    args[0] === "--target" &&
    args[1] === "darwin-arm64" &&
    args[2] === "--application"
  ) {
    return {
      target: "darwin-arm64",
      application: requireAbsolutePath(args[3]),
    };
  }
  if (
    args.length === 6 &&
    args[0] === "--target" &&
    args[1] === "win32-x64" &&
    args[2] === "--application" &&
    args[4] === "--installer"
  ) {
    return {
      target: "win32-x64",
      application: requireAbsolutePath(args[3]),
      installer: requireAbsolutePath(args[5]),
    };
  }
  throw new Error(FAILURE_MESSAGE);
}

function requireAbsolutePath(value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(FAILURE_MESSAGE);
  }
  return value;
}

async function verifyMacApplication(requestedApplicationPath) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(FAILURE_MESSAGE);
  }
  const target = policy.targets["darwin-arm64"];
  if (
    target.signatureRequired !== true ||
    target.notarizationRequired !== true ||
    target.stapleRequired !== true ||
    target.hardenedRuntimeRequired !== true ||
    target.secureTimestampRequired !== true ||
    target.debugEntitlementDenied !== true ||
    !isConfiguredIdentity(target.expectedTeamIdentifier)
  ) {
    throw new Error(FAILURE_MESSAGE);
  }

  const applicationPath = await requirePathType(requestedApplicationPath, "directory");
  if (extname(applicationPath) !== ".app") {
    throw new Error(FAILURE_MESSAGE);
  }
  const infoPath = join(applicationPath, "Contents", "Info.plist");
  await requirePathType(infoPath, "file");
  const info = parseJson(
    runVerified("plutil", ["-convert", "json", "-o", "-", infoPath]).stdout,
  );
  if (
    info.CFBundleIdentifier !== policy.application.bundleIdentifier ||
    !hasCustomProtocol(info, policy.application.protocol)
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  const executableName = info.CFBundleExecutable;
  if (
    typeof executableName !== "string" ||
    executableName.length === 0 ||
    basename(executableName) !== executableName
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  const executablePath = await requirePathType(
    join(applicationPath, "Contents", "MacOS", executableName),
    "file",
  );
  await verifyEmbeddedAsarIntegrity(info, applicationPath);
  await verifyPackagedApplication(applicationPath, executablePath, "mac");

  runVerified("codesign", ["-vvv", "--deep", "--strict", applicationPath]);
  const signatureDetails = runVerified("codesign", [
    "-d",
    "--verbose=4",
    applicationPath,
  ]).combined;
  const teamIdentifier = /^TeamIdentifier=(.+)$/mu.exec(signatureDetails)?.[1]?.trim();
  if (
    teamIdentifier !== target.expectedTeamIdentifier ||
    !/flags=0x[0-9a-f]+\(runtime\)/iu.test(signatureDetails) ||
    !/^Timestamp=.+$/mu.test(signatureDetails)
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  const entitlements = runVerified("codesign", [
    "-d",
    "--entitlements",
    ":-",
    executablePath,
  ]).combined;
  if (
    /<key>com\.apple\.security\.get-task-allow<\/key>\s*<true\s*\/>/iu.test(
      entitlements,
    )
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  runVerified("spctl", ["--assess", "--type", "execute", "--verbose=4", applicationPath]);
  runVerified("xcrun", ["stapler", "validate", applicationPath]);
}

async function verifyEmbeddedAsarIntegrity(info, applicationPath) {
  const archivePath = await requirePathType(
    join(applicationPath, "Contents", "Resources", "app.asar"),
    "file",
  );
  const vendorRequire = createRequire(new URL("vendor-runtime/package.json", appRoot));
  const { getRawHeader } = vendorRequire("@electron/asar");
  const rawHeader = getRawHeader(archivePath);
  if (typeof rawHeader?.headerString !== "string") {
    throw new Error(FAILURE_MESSAGE);
  }
  const expected = createHash("sha256")
    .update(rawHeader.headerString, "utf8")
    .digest("hex");
  const embedded = info.ElectronAsarIntegrity?.["Resources/app.asar"];
  if (embedded?.algorithm !== "SHA256" || embedded?.hash !== expected) {
    throw new Error(FAILURE_MESSAGE);
  }
}

async function verifyWindowsArtifacts(requestedApplicationPath, requestedInstallerPath) {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error(FAILURE_MESSAGE);
  }
  const target = policy.targets["win32-x64"];
  if (
    target.signatureRequired !== true ||
    target.timestampRequired !== true ||
    !isConfiguredIdentity(target.expectedPublisherSubject)
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  const applicationPath = await requireWindowsExecutable(requestedApplicationPath);
  const installerPath = await requireWindowsExecutable(requestedInstallerPath);
  if (applicationPath === installerPath) {
    throw new Error(FAILURE_MESSAGE);
  }
  await verifyPackagedApplication(dirname(applicationPath), applicationPath, "windows");

  for (const artifactPath of [applicationPath, installerPath]) {
    runVerified("SignTool.exe", ["verify", "/q", "/pa", "/all", "/tw", artifactPath]);
    runVerified("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("verify-windows-publisher.ps1", import.meta.url)),
      "-ArtifactPath",
      artifactPath,
      "-ExpectedPublisherSubject",
      target.expectedPublisherSubject,
    ]);
  }
}

async function requireWindowsExecutable(requestedPath) {
  const executablePath = await requirePathType(requestedPath, "file");
  if (extname(executablePath).toLowerCase() !== ".exe") {
    throw new Error(FAILURE_MESSAGE);
  }
  return executablePath;
}

async function verifyPackagedApplication(applicationRoot, executablePath, platform) {
  const resourcesPath =
    platform === "mac"
      ? join(applicationRoot, "Contents", "Resources")
      : join(applicationRoot, "resources");
  const archivePath = join(resourcesPath, "app.asar");
  const archive = await lstat(archivePath);
  if (!archive.isFile() || archive.isSymbolicLink()) {
    throw new Error(FAILURE_MESSAGE);
  }
  await requireAbsent(join(resourcesPath, "app"));
  await verifyUnpackedRuntimeBoundary(resourcesPath);
  await verifyFusePolicy(executablePath);
}

async function verifyUnpackedRuntimeBoundary(resourcesPath) {
  const unpackedRoot = await requirePathType(
    join(resourcesPath, "app.asar.unpacked"),
    "directory",
  );
  const allowed = policy.archive.unpackedRuntimePath;
  const allowedRoot = await requirePathType(join(unpackedRoot, allowed), "directory");
  let containedEntryCount = 0;

  const visit = async (path) => {
    const names = (await readdir(path)).sort();
    for (const name of names) {
      const child = join(path, name);
      const pathFromRoot = relative(unpackedRoot, child).split(sep).join("/");
      if (
        pathFromRoot !== allowed &&
        !pathFromRoot.startsWith(`${allowed}/`) &&
        !allowed.startsWith(`${pathFromRoot}/`)
      ) {
        throw new Error(FAILURE_MESSAGE);
      }
      const details = await lstat(child);
      if (details.isSymbolicLink()) {
        const target = await readlink(child);
        if (
          isAbsolute(target) ||
          !isWithin(allowedRoot, resolve(dirname(child), target)) ||
          !isWithin(allowedRoot, await realpath(child))
        ) {
          throw new Error(FAILURE_MESSAGE);
        }
        containedEntryCount += 1;
      } else if (details.isDirectory()) {
        await visit(child);
      } else if (details.isFile()) {
        containedEntryCount += 1;
      } else {
        throw new Error(FAILURE_MESSAGE);
      }
    }
  };

  await visit(unpackedRoot);
  if (containedEntryCount === 0) {
    throw new Error(FAILURE_MESSAGE);
  }
}

async function verifyFusePolicy(executablePath) {
  const vendorRequire = createRequire(new URL("vendor-runtime/package.json", appRoot));
  const { getCurrentFuseWire, FuseV1Options } = vendorRequire("@electron/fuses");
  const fuseWire = await getCurrentFuseWire(executablePath);
  const expected = new Map([
    [FuseV1Options.RunAsNode, policy.fuses.runAsNode],
    [FuseV1Options.EnableCookieEncryption, policy.fuses.cookieEncryption],
    [
      FuseV1Options.EnableNodeOptionsEnvironmentVariable,
      policy.fuses.nodeOptionsEnvironmentVariable,
    ],
    [FuseV1Options.EnableNodeCliInspectArguments, policy.fuses.nodeCliInspectArguments],
    [
      FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
      policy.fuses.embeddedAsarIntegrityValidation,
    ],
    [FuseV1Options.OnlyLoadAppFromAsar, policy.fuses.onlyLoadAppFromAsar],
    [
      FuseV1Options.LoadBrowserProcessSpecificV8Snapshot,
      policy.fuses.browserProcessSpecificV8Snapshot,
    ],
    [
      FuseV1Options.GrantFileProtocolExtraPrivileges,
      policy.fuses.fileProtocolExtraPrivileges,
    ],
    [FuseV1Options.WasmTrapHandlers, policy.fuses.wasmTrapHandlers],
  ]);
  for (const [fuse, enabled] of expected) {
    if (fuseWire[fuse] !== (enabled ? 49 : 48)) {
      throw new Error(FAILURE_MESSAGE);
    }
  }
}

async function requirePathType(requestedPath, expectedType) {
  const resolvedPath = await realpath(requestedPath);
  const details = await lstat(resolvedPath);
  const valid = expectedType === "file" ? details.isFile() : details.isDirectory();
  if (!valid || details.isSymbolicLink()) {
    throw new Error(FAILURE_MESSAGE);
  }
  return resolvedPath;
}

async function requireAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw new Error(FAILURE_MESSAGE, { cause: error });
  }
  throw new Error(FAILURE_MESSAGE);
}

function hasCustomProtocol(info, expectedProtocol) {
  return (
    Array.isArray(info.CFBundleURLTypes) &&
    info.CFBundleURLTypes.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        Array.isArray(entry.CFBundleURLSchemes) &&
        entry.CFBundleURLSchemes.includes(expectedProtocol),
    )
  );
}

function isConfiguredIdentity(value) {
  return typeof value === "string" && value.length > 0 && value !== UNCONFIGURED;
}

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function parseJson(value) {
  const parsed = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(FAILURE_MESSAGE);
  }
  return parsed;
}

function runVerified(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(FAILURE_MESSAGE);
  }
  return {
    stdout: result.stdout,
    combined: `${result.stdout}\n${result.stderr}`,
  };
}
