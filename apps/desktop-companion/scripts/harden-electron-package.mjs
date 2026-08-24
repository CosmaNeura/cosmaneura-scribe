import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
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
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { hashTree } from "./assemble-electron-package.mjs";

const FAILURE_MESSAGE = "Desktop fuse hardening failed or its inputs are invalid";
const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = resolve(packageRoot, "vendor-runtime");
const policy = JSON.parse(
  await readFile(resolve(packageRoot, "release", "package-policy.json"), "utf8"),
);

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
  assertHardeningPolicy();
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(FAILURE_MESSAGE);
  }
  const request = parseArguments(process.argv.slice(2));
  await assertCleanSource(request.sourceSha);
  const applicationPath = await requireExactDirectory(request.application);
  const receiptPath = await requireExactFile(request.assemblyReceipt);
  const evidence = await verifyAssemblyInput(applicationPath, receiptPath);
  const outputRoot = await requireNewOutputPath(request.out);
  if (
    isWithin(evidence.packageDirectory, outputRoot) ||
    isWithin(outputRoot, evidence.packageDirectory)
  ) {
    throw new Error(FAILURE_MESSAGE);
  }

  await mkdir(outputRoot, { mode: 0o700 });
  const incompleteMarker = resolve(outputRoot, "HARDENING-INCOMPLETE");
  await writeFile(incompleteMarker, "Desktop fuse hardening is incomplete.\n", {
    flag: "wx",
    mode: 0o600,
  });
  const outputPackageDirectory = resolve(
    outputRoot,
    basename(evidence.packageDirectory),
  );
  await cp(evidence.packageDirectory, outputPackageDirectory, {
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: false,
    recursive: true,
    verbatimSymlinks: true,
  });
  if ((await hashTree(outputPackageDirectory)) !== evidence.inputTreeSha256) {
    throw new Error(FAILURE_MESSAGE);
  }

  const outputApplication = resolve(
    outputPackageDirectory,
    `${policy.application.productName}.app`,
  );
  const copiedMetadata = await verifyApplicationMetadata(outputApplication);
  if (
    copiedMetadata.appAsarSha256 !== evidence.appAsarSha256 ||
    copiedMetadata.asarHeaderSha256 !== evidence.asarHeaderSha256
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  await applyFuses(copiedMetadata.executablePath);
  const fuseWire = await verifyFuses(copiedMetadata.executablePath);

  const finalMetadata = await verifyApplicationMetadata(outputApplication);
  if (
    finalMetadata.appAsarSha256 !== evidence.appAsarSha256 ||
    finalMetadata.asarHeaderSha256 !== evidence.asarHeaderSha256 ||
    (await hashTree(finalMetadata.unpackedRuntimePath)) !==
      evidence.unpackedRuntimeTreeSha256
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  const hardenedTreeSha256 = await hashTree(outputPackageDirectory);
  await writeReceipt(outputRoot, request, evidence, {
    fuseWire,
    hardenedTreeSha256,
  });
  await unlink(incompleteMarker);
  process.stdout.write(
    "Desktop fuses hardened and independently recorded; signing remains required.\n",
  );
}

function assertHardeningPolicy() {
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
    policy.archive.asarRequired !== true ||
    policy.archive.embeddedIntegrityRequired !== true ||
    policy.archive.smartUnpackAllowed !== false
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
}

function parseArguments(values) {
  if (values.length !== 8) {
    throw new Error(FAILURE_MESSAGE);
  }
  const parsed = Object.create(null);
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (
      (name !== "--application" &&
        name !== "--assembly-receipt" &&
        name !== "--out" &&
        name !== "--source-sha") ||
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
    !isAbsolute(parsed["--assembly-receipt"]) ||
    !isAbsolute(parsed["--out"]) ||
    !/^[0-9a-f]{40}$/u.test(parsed["--source-sha"])
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  return Object.freeze({
    application: resolve(parsed["--application"]),
    assemblyReceipt: resolve(parsed["--assembly-receipt"]),
    out: resolve(parsed["--out"]),
    sourceSha: parsed["--source-sha"],
  });
}

async function verifyAssemblyInput(applicationPath, receiptPath) {
  if (
    extname(applicationPath) !== ".app" ||
    basename(receiptPath) !== "assembly-receipt-darwin-arm64.json"
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  const receipt = parseJson(await readFile(receiptPath, "utf8"));
  if (
    receipt.schemaVersion !== 1 ||
    receipt.target !== "darwin-arm64" ||
    !/^[0-9a-f]{40}$/u.test(receipt.sourceSha) ||
    receipt.assembler?.name !== policy.toolchain.assembler ||
    receipt.assembler?.version !== policy.toolchain.assemblerVersion ||
    receipt.assembler?.integritySha512 !==
      policy.toolchain.assemblerIntegritySha512 ||
    receipt.assembler?.signingEnabled !== false ||
    receipt.assembler?.frameworkResignAllowed !== false ||
    receipt.electron?.version !== policy.electronArchives.version ||
    receipt.electron?.releaseTag !== policy.electronArchives.releaseTag ||
    receipt.electron?.archiveFilename !==
      policy.electronArchives.targets["darwin-arm64"].filename ||
    receipt.electron?.archiveSha256 !==
      policy.electronArchives.targets["darwin-arm64"].sha256 ||
    receipt.archive?.asarRequired !== true ||
    receipt.archive?.embeddedIntegrityRequired !== true ||
    receipt.archive?.smartUnpackAllowed !== false ||
    receipt.archive?.unpackedRuntimePath !== policy.archive.unpackedRuntimePath ||
    !isSha256(receipt.archive?.appAsarSha256) ||
    !isSha256(receipt.archive?.unpackedRuntimeTreeSha256) ||
    !isSha256(receipt.preHardenedPackageTreeSha256) ||
    typeof receipt.packageDirectory !== "string" ||
    basename(receipt.packageDirectory) !== receipt.packageDirectory ||
    receipt.signed !== false ||
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
    (await hashTree(packageDirectory)) !== receipt.preHardenedPackageTreeSha256
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  const metadata = await verifyApplicationMetadata(applicationPath);
  if (
    metadata.appAsarSha256 !== receipt.archive.appAsarSha256 ||
    (await hashTree(metadata.unpackedRuntimePath)) !==
      receipt.archive.unpackedRuntimeTreeSha256
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  return Object.freeze({
    appAsarSha256: metadata.appAsarSha256,
    asarHeaderSha256: metadata.asarHeaderSha256,
    assemblyReceipt: basename(receiptPath),
    assemblySourceSha: receipt.sourceSha,
    inputTreeSha256: receipt.preHardenedPackageTreeSha256,
    packageDirectory,
    unpackedRuntimeTreeSha256: receipt.archive.unpackedRuntimeTreeSha256,
  });
}

async function verifyApplicationMetadata(applicationPath) {
  const application = await requireExactDirectory(applicationPath);
  const infoPath = await requireExactFile(resolve(application, "Contents", "Info.plist"));
  const info = parseJson(
    (await execFileAsync("plutil", ["-convert", "json", "-o", "-", infoPath], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    })).stdout,
  );
  if (
    info.CFBundleIdentifier !== policy.application.bundleIdentifier ||
    !hasCustomProtocol(info, policy.application.protocol) ||
    typeof info.CFBundleExecutable !== "string" ||
    basename(info.CFBundleExecutable) !== info.CFBundleExecutable
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  const executablePath = await requireExactFile(
    resolve(application, "Contents", "MacOS", info.CFBundleExecutable),
  );
  const resourcesPath = resolve(application, "Contents", "Resources");
  const appAsarPath = await requireExactFile(resolve(resourcesPath, "app.asar"));
  const unpackedRuntimePath = await requireExactDirectory(
    resolve(resourcesPath, "app.asar.unpacked", policy.archive.unpackedRuntimePath),
  );
  const vendorRequire = createRequire(resolve(runtimeRoot, "package.json"));
  const { getRawHeader } = vendorRequire("@electron/asar");
  const rawHeader = getRawHeader(appAsarPath);
  if (typeof rawHeader?.headerString !== "string") {
    throw new Error(FAILURE_MESSAGE);
  }
  const asarHeaderSha256 = createHash("sha256")
    .update(rawHeader.headerString, "utf8")
    .digest("hex");
  const embeddedIntegrity = info.ElectronAsarIntegrity?.["Resources/app.asar"];
  if (
    embeddedIntegrity?.algorithm !== "SHA256" ||
    embeddedIntegrity?.hash !== asarHeaderSha256
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  return Object.freeze({
    appAsarSha256: await hashFile(appAsarPath),
    asarHeaderSha256,
    executablePath,
    unpackedRuntimePath,
  });
}

async function applyFuses(executablePath) {
  const vendorRequire = createRequire(resolve(runtimeRoot, "package.json"));
  const { flipFuses, FuseV1Options, FuseVersion } =
    vendorRequire("@electron/fuses");
  await flipFuses(executablePath, {
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
    [FuseV1Options.WasmTrapHandlers]: policy.fuses.wasmTrapHandlers,
  });
}

async function verifyFuses(executablePath) {
  const vendorRequire = createRequire(resolve(runtimeRoot, "package.json"));
  const { getCurrentFuseWire, FuseV1Options } = vendorRequire("@electron/fuses");
  const wire = await getCurrentFuseWire(executablePath);
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
    if (wire[fuse] !== (enabled ? 49 : 48)) {
      throw new Error(FAILURE_MESSAGE);
    }
  }
  return wire;
}

async function writeReceipt(outputRoot, request, evidence, hardened) {
  const destination = resolve(outputRoot, "hardening-receipt-darwin-arm64.json");
  const temporary = `${destination}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceSha: request.sourceSha,
        assembly: {
          receipt: evidence.assemblyReceipt,
          sourceSha: evidence.assemblySourceSha,
          preHardenedPackageTreeSha256: evidence.inputTreeSha256,
        },
        target: "darwin-arm64",
        packageDirectory: basename(evidence.packageDirectory),
        archive: {
          appAsarSha256: evidence.appAsarSha256,
          asarHeaderSha256: evidence.asarHeaderSha256,
          unpackedRuntimeTreeSha256: evidence.unpackedRuntimeTreeSha256,
        },
        fuses: policy.fuses,
        fuseWire: hardened.fuseWire,
        hardenedPackageTreeSha256: hardened.hardenedTreeSha256,
        signed: false,
        notarized: false,
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

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
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

function parseJson(value) {
  const parsed = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(FAILURE_MESSAGE);
  }
  return parsed;
}

function hasCustomProtocol(info, protocol) {
  return (
    Array.isArray(info.CFBundleURLTypes) &&
    info.CFBundleURLTypes.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        Array.isArray(entry.CFBundleURLSchemes) &&
        entry.CFBundleURLSchemes.includes(protocol),
    )
  );
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
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

export { parseArguments, verifyFuses };
