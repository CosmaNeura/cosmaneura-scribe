import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { hashTree } from "./assemble-electron-package.mjs";
import { verifyFuses } from "./harden-electron-package.mjs";

const FAILURE_MESSAGE = "macOS signing and notarization failed or is not configured";
const UNCONFIGURED = "UNCONFIGURED";
const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = resolve(packageRoot, "vendor-runtime");
const policy = JSON.parse(
  await readFile(resolve(packageRoot, "release", "package-policy.json"), "utf8"),
);
const ignoredRelativePaths = new Set([
  "Resources/app.asar.unpacked/vendor-runtime/node_modules/@recallai/desktop-sdk/.cosmas-provenance/native-darwin-arm64.tar",
  "Resources/app.asar.unpacked/vendor-runtime/node_modules/@recallai/desktop-sdk/.cosmas-provenance/registry-package.tgz",
]);

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch {
    process.stderr.write(`${FAILURE_MESSAGE}.\n`);
    process.exitCode = 1;
  }
}

async function main() {
  assertSigningPolicy();
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(FAILURE_MESSAGE);
  }
  const request = parseArguments(process.argv.slice(2));
  await assertCleanSource(request.sourceSha);
  const keychain = await requireExactFile(request.keychain);
  await verifySigningIdentity(request.identitySha1, keychain);
  const hardened = await verifyHardenedInput(
    request.application,
    request.hardeningReceipt,
  );
  const outputRoot = await requireNewOutputPath(request.out);
  if (
    isWithin(hardened.packageDirectory, outputRoot) ||
    isWithin(outputRoot, hardened.packageDirectory)
  ) {
    throw new Error(FAILURE_MESSAGE);
  }

  await mkdir(outputRoot, { mode: 0o700 });
  const incompleteMarker = resolve(outputRoot, "SIGNING-NOTARIZATION-INCOMPLETE");
  await writeFile(
    incompleteMarker,
    "macOS signing and notarization are incomplete.\n",
    { flag: "wx", mode: 0o600 },
  );
  const outputPackageDirectory = resolve(
    outputRoot,
    basename(hardened.packageDirectory),
  );
  await cp(hardened.packageDirectory, outputPackageDirectory, {
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: false,
    recursive: true,
    verbatimSymlinks: true,
  });
  if ((await hashTree(outputPackageDirectory)) !== hardened.inputTreeSha256) {
    throw new Error(FAILURE_MESSAGE);
  }

  const outputApplication = resolve(
    outputPackageDirectory,
    `${policy.application.productName}.app`,
  );
  const signerModule = await importPinnedModule(
    policy.toolchain.macosSigner,
    "dist/index.js",
  );
  if (
    typeof signerModule.sign !== "function" ||
    typeof signerModule.walk !== "function"
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  const inventory = await verifySigningInventory(outputApplication, signerModule.walk);
  await signerModule.sign({
    app: outputApplication,
    identity: request.identitySha1,
    keychain,
    platform: "darwin",
    version: policy.electronArchives.version,
    strictVerify: true,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    ignore: (path) => isIgnoredProvenanceArchive(outputApplication, path),
    optionsForFile: (path) =>
      isRecallRuntimeCode(outputApplication, path)
        ? { entitlements: [], hardenedRuntime: true }
        : {},
  });
  await verifyDeveloperIdSignature(outputApplication);
  await verifyNestedSignatures(inventory.codePaths);

  const notarizerModule = await importPinnedModule(
    policy.toolchain.macosNotarizer,
    "lib/index.js",
  );
  if (typeof notarizerModule.notarize !== "function") {
    throw new Error(FAILURE_MESSAGE);
  }
  await notarizerModule.notarize({
    appPath: outputApplication,
    keychainProfile: request.notaryProfile,
    keychain,
  });
  await verifyFinalArtifact(outputApplication);
  const signedTreeSha256 = await hashTree(outputPackageDirectory);
  await writeReceipt(outputRoot, request, hardened, {
    discoveredCodeObjects: inventory.discoveredCodeObjects,
    ignoredProvenanceArchives: inventory.ignoredProvenanceArchives,
    signedTreeSha256,
  });
  await unlink(incompleteMarker);
  process.stdout.write(
    "macOS package signed, notarized, stapled, and verified; distribution remains disabled.\n",
  );
}

function assertSigningPolicy() {
  const target = policy.targets["darwin-arm64"];
  if (
    policy.release.packagingEnabled !== true ||
    policy.release.captureEnabled !== false ||
    policy.release.clinicalReleaseApproved !== false ||
    policy.release.unsignedDistributionAllowed !== false ||
    policy.toolchain.assemblerSigningEnabled !== false ||
    policy.toolchain.assemblerFrameworkResignAllowed !== false ||
    policy.toolchain.externalSigningRequired !== true ||
    policy.toolchain.recallOsxSignForkAllowed !== false ||
    policy.toolchain.fuseHardeningLaneApproved !== true ||
    policy.toolchain.fuseTool !== "@electron/fuses" ||
    policy.toolchain.fuseToolVersion !== "2.1.3" ||
    policy.toolchain.macosSigningLaneApproved !== true ||
    policy.toolchain.macosNotarizationLaneApproved !== true ||
    policy.toolchain.macosSigner !== "@electron/osx-sign" ||
    policy.toolchain.macosSignerVersion !== "2.7.0" ||
    policy.toolchain.macosNotarizer !== "@electron/notarize" ||
    policy.toolchain.macosNotarizerVersion !== "3.1.1" ||
    target.signatureRequired !== true ||
    target.notarizationRequired !== true ||
    target.stapleRequired !== true ||
    target.hardenedRuntimeRequired !== true ||
    target.secureTimestampRequired !== true ||
    target.debugEntitlementDenied !== true ||
    !isConfiguredIdentity(target.expectedTeamIdentifier) ||
    target.credentialSource !== "temporary-ci-keychain"
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
}

function parseArguments(values) {
  if (values.length !== 14) {
    throw new Error(FAILURE_MESSAGE);
  }
  const allowed = new Set([
    "--application",
    "--hardening-receipt",
    "--identity-sha1",
    "--keychain",
    "--notary-profile",
    "--out",
    "--source-sha",
  ]);
  const parsed = Object.create(null);
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (
      !allowed.has(name) ||
      typeof value !== "string" ||
      value.length === 0 ||
      parsed[name] !== undefined
    ) {
      throw new Error(FAILURE_MESSAGE);
    }
    parsed[name] = value;
  }
  if (
    !isAbsolute(parsed["--application"]) ||
    !isAbsolute(parsed["--hardening-receipt"]) ||
    !isAbsolute(parsed["--keychain"]) ||
    !isAbsolute(parsed["--out"]) ||
    !/^[0-9A-F]{40}$/u.test(parsed["--identity-sha1"]) ||
    !/^[A-Za-z0-9._-]{1,128}$/u.test(parsed["--notary-profile"]) ||
    !/^[0-9a-f]{40}$/u.test(parsed["--source-sha"])
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  return Object.freeze({
    application: resolve(parsed["--application"]),
    hardeningReceipt: resolve(parsed["--hardening-receipt"]),
    identitySha1: parsed["--identity-sha1"],
    keychain: resolve(parsed["--keychain"]),
    notaryProfile: parsed["--notary-profile"],
    out: resolve(parsed["--out"]),
    sourceSha: parsed["--source-sha"],
  });
}

async function verifyHardenedInput(requestedApplication, requestedReceipt) {
  const applicationPath = await requireExactDirectory(requestedApplication);
  const receiptPath = await requireExactFile(requestedReceipt);
  if (basename(receiptPath) !== "hardening-receipt-darwin-arm64.json") {
    throw new Error(FAILURE_MESSAGE);
  }
  const receipt = parseJson(await readFile(receiptPath, "utf8"));
  if (
    receipt.schemaVersion !== 1 ||
    receipt.target !== "darwin-arm64" ||
    !/^[0-9a-f]{40}$/u.test(receipt.sourceSha) ||
    typeof receipt.packageDirectory !== "string" ||
    basename(receipt.packageDirectory) !== receipt.packageDirectory ||
    JSON.stringify(receipt.fuses) !== JSON.stringify(policy.fuses) ||
    !isSha256(receipt.archive?.appAsarSha256) ||
    !isSha256(receipt.archive?.asarHeaderSha256) ||
    !isSha256(receipt.archive?.unpackedRuntimeTreeSha256) ||
    !isSha256(receipt.hardenedPackageTreeSha256) ||
    receipt.signed !== false ||
    receipt.notarized !== false ||
    receipt.distributionAllowed !== false
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  const packageDirectory = await requireExactDirectory(
    resolve(dirname(receiptPath), receipt.packageDirectory),
  );
  if (
    applicationPath !==
      resolve(packageDirectory, `${policy.application.productName}.app`) ||
    (await hashTree(packageDirectory)) !== receipt.hardenedPackageTreeSha256
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  const executablePath = await mainExecutable(applicationPath);
  const fuseWire = await verifyFuses(executablePath);
  if (JSON.stringify(fuseWire) !== JSON.stringify(receipt.fuseWire)) {
    throw new Error(FAILURE_MESSAGE);
  }
  return Object.freeze({
    hardeningReceipt: basename(receiptPath),
    hardeningSourceSha: receipt.sourceSha,
    inputTreeSha256: receipt.hardenedPackageTreeSha256,
    packageDirectory,
  });
}

async function verifySigningIdentity(identitySha1, keychain) {
  const result = await runVerified("security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
    keychain,
  ]);
  const matches = result.combined
    .split("\n")
    .filter(
      (line) =>
        line.includes(identitySha1) && line.includes('"Developer ID Application:'),
    );
  if (matches.length !== 1) {
    throw new Error(FAILURE_MESSAGE);
  }
}

async function verifySigningInventory(applicationPath, walk) {
  const contentsPath = resolve(applicationPath, "Contents");
  const discovered = await walk(contentsPath);
  if (!Array.isArray(discovered) || discovered.length === 0) {
    throw new Error(FAILURE_MESSAGE);
  }
  const ignored = discovered.filter((path) =>
    isIgnoredProvenanceArchive(applicationPath, path),
  );
  if (
    ignored.length !== ignoredRelativePaths.size ||
    ignored.some(
      (path) => !ignoredRelativePaths.has(relative(contentsPath, path).split(sep).join("/")),
    ) ||
    [...ignoredRelativePaths].some(
      (path) => !ignored.some((ignoredPath) => ignoredPath === resolve(contentsPath, path)),
    ) ||
    discovered.some((path) => !isWithin(contentsPath, path))
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  return Object.freeze({
    codePaths: discovered.filter(
      (path) => !isIgnoredProvenanceArchive(applicationPath, path),
    ),
    discoveredCodeObjects: discovered.length - ignored.length + 1,
    ignoredProvenanceArchives: [...ignoredRelativePaths].sort(),
  });
}

async function verifyNestedSignatures(codePaths) {
  const expectedTeam = policy.targets["darwin-arm64"].expectedTeamIdentifier;
  for (const path of codePaths) {
    await runVerified("codesign", ["--verify", "--strict", "--verbose=2", path]);
    const details = (await runVerified("codesign", ["-d", "--verbose=4", path]))
      .combined;
    if (!details.includes(`TeamIdentifier=${expectedTeam}`)) {
      throw new Error(FAILURE_MESSAGE);
    }
  }
}

function isIgnoredProvenanceArchive(applicationPath, path) {
  const contentsPath = resolve(applicationPath, "Contents");
  const relativePath = relative(contentsPath, resolve(path)).split(sep).join("/");
  return isWithin(contentsPath, resolve(path)) && ignoredRelativePaths.has(relativePath);
}

function isRecallRuntimeCode(applicationPath, path) {
  const recallRoot = resolve(
    applicationPath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    policy.archive.unpackedRuntimePath,
  );
  return isWithin(recallRoot, resolve(path));
}

async function verifyDeveloperIdSignature(applicationPath) {
  await runVerified("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=3",
    applicationPath,
  ]);
  const details = (await runVerified("codesign", [
    "-d",
    "--verbose=4",
    applicationPath,
  ])).combined;
  if (
    !details.includes(`TeamIdentifier=${policy.targets["darwin-arm64"].expectedTeamIdentifier}`) ||
    !/flags=0x[0-9a-f]+\(runtime\)/iu.test(details) ||
    !/^Timestamp=.+$/mu.test(details)
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
}

async function verifyFinalArtifact(applicationPath) {
  await execFileAsync(
    process.execPath,
    [
      resolve(packageRoot, "scripts", "verify-signed-desktop-artifacts.mjs"),
      "--target",
      "darwin-arm64",
      "--application",
      applicationPath,
    ],
    {
      cwd: packageRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    },
  );
}

async function mainExecutable(applicationPath) {
  const infoPath = await requireExactFile(resolve(applicationPath, "Contents", "Info.plist"));
  const info = parseJson(
    (await execFileAsync("plutil", ["-convert", "json", "-o", "-", infoPath], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    })).stdout,
  );
  if (
    info.CFBundleIdentifier !== policy.application.bundleIdentifier ||
    typeof info.CFBundleExecutable !== "string" ||
    basename(info.CFBundleExecutable) !== info.CFBundleExecutable
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  return requireExactFile(
    resolve(applicationPath, "Contents", "MacOS", info.CFBundleExecutable),
  );
}

async function importPinnedModule(packageName, entrypoint) {
  const packagePath = resolve(runtimeRoot, "node_modules", packageName, "package.json");
  const metadata = parseJson(await readFile(packagePath, "utf8"));
  const expectedVersion =
    packageName === policy.toolchain.macosSigner
      ? policy.toolchain.macosSignerVersion
      : policy.toolchain.macosNotarizerVersion;
  if (metadata.name !== packageName || metadata.version !== expectedVersion) {
    throw new Error(FAILURE_MESSAGE);
  }
  return import(pathToFileURL(resolve(dirname(packagePath), entrypoint)).href);
}

async function writeReceipt(outputRoot, request, hardened, signed) {
  const destination = resolve(
    outputRoot,
    "signing-notarization-receipt-darwin-arm64.json",
  );
  const temporary = `${destination}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceSha: request.sourceSha,
        target: "darwin-arm64",
        packageDirectory: basename(hardened.packageDirectory),
        hardening: {
          receipt: hardened.hardeningReceipt,
          sourceSha: hardened.hardeningSourceSha,
          hardenedPackageTreeSha256: hardened.inputTreeSha256,
        },
        signer: {
          name: policy.toolchain.macosSigner,
          version: policy.toolchain.macosSignerVersion,
          integritySha512: policy.toolchain.macosSignerIntegritySha512,
          identitySha1: request.identitySha1,
          teamIdentifier: policy.targets["darwin-arm64"].expectedTeamIdentifier,
          credentialSource: policy.targets["darwin-arm64"].credentialSource,
        },
        notarizer: {
          name: policy.toolchain.macosNotarizer,
          version: policy.toolchain.macosNotarizerVersion,
          integritySha512: policy.toolchain.macosNotarizerIntegritySha512,
          credentialSource: "keychain-profile",
        },
        inventory: {
          discoveredCodeObjects: signed.discoveredCodeObjects,
          ignoredProvenanceArchives: signed.ignoredProvenanceArchives,
        },
        signedPackageTreeSha256: signed.signedTreeSha256,
        signed: true,
        notarized: true,
        stapled: true,
        distributionAllowed: false,
      },
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await rename(temporary, destination);
}

async function assertCleanSource(sourceSha) {
  const head = await runGit(["rev-parse", "HEAD"]);
  const changes = await runGit([
    "status",
    "--porcelain=v1",
    "--untracked-files=no",
  ]);
  if (head.trim() !== sourceSha || changes.trim().length !== 0) {
    throw new Error(FAILURE_MESSAGE);
  }
}

async function runGit(args) {
  const result = await execFileAsync("git", args, {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 10_000,
  });
  if (result.stderr.trim().length !== 0) {
    throw new Error(FAILURE_MESSAGE);
  }
  return result.stdout;
}

function runVerified(command, args) {
  const result = execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
  });
  return result.then(
    ({ stdout, stderr }) => ({ combined: `${stdout}\n${stderr}` }),
    () => {
      throw new Error(FAILURE_MESSAGE);
    },
  );
}

async function requireExactFile(requestedPath) {
  const path = resolve(requestedPath);
  const canonical = await realpath(path);
  const details = await lstat(canonical);
  if (canonical !== path || !details.isFile() || details.isSymbolicLink()) {
    throw new Error(FAILURE_MESSAGE);
  }
  return canonical;
}

async function requireExactDirectory(requestedPath) {
  const path = resolve(requestedPath);
  const canonical = await realpath(path);
  const details = await lstat(canonical);
  if (canonical !== path || !details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(FAILURE_MESSAGE);
  }
  return canonical;
}

async function requireNewOutputPath(requestedPath) {
  const outputPath = resolve(requestedPath);
  const parent = resolve(dirname(outputPath));
  if ((await realpath(parent)) !== parent) {
    throw new Error(FAILURE_MESSAGE);
  }
  await requireAbsent(outputPath);
  return outputPath;
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

function isConfiguredIdentity(value) {
  return typeof value === "string" && value.length > 0 && value !== UNCONFIGURED;
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function parseJson(value) {
  const parsed = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(FAILURE_MESSAGE);
  }
  return parsed;
}

function isWithin(root, candidate) {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot))
  );
}

export {
  isIgnoredProvenanceArchive,
  isRecallRuntimeCode,
  parseArguments,
  verifySigningInventory,
};
