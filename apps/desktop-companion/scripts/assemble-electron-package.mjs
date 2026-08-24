import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const FAILURE_MESSAGE = "Unsigned desktop assembly is not approved or its inputs are invalid";
const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = resolve(packageRoot, "vendor-runtime");
const sdkRelativePath = "vendor-runtime/node_modules/@recallai/desktop-sdk";
const policy = JSON.parse(
  await readFile(resolve(packageRoot, "release", "package-policy.json"), "utf8"),
);
const appPackage = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
);
const vendorPackage = JSON.parse(
  await readFile(resolve(runtimeRoot, "package.json"), "utf8"),
);
const vendorLock = JSON.parse(
  await readFile(resolve(runtimeRoot, "package-lock.json"), "utf8"),
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
  assertAssemblyPolicy();
  const request = parseArguments(process.argv.slice(2));
  const target = targetDefinition(request.target);
  await assertCleanSource(request.sourceSha);
  const electronZip = await requireExactFile(request.electronZip);
  const outputRoot = await requireNewOutputPath(request.out);
  if (
    basename(electronZip) !== target.archive.filename ||
    (await hashFile(electronZip)) !== target.archive.sha256
  ) {
    throw new Error(FAILURE_MESSAGE);
  }

  const canonicalTemporaryParent = await realpath(tmpdir());
  const temporaryRoot = await mkdtemp(
    join(canonicalTemporaryParent, "cosmas-desktop-assembly-"),
  );
  const stagingRoot = resolve(temporaryRoot, "stage");
  const extractionRoot = resolve(temporaryRoot, "extracted-asar");
  const packagerTemporaryRoot = resolve(temporaryRoot, "packager-tmp");
  const incompleteMarker = resolve(outputRoot, "ASSEMBLY-INCOMPLETE");
  try {
    await mkdir(stagingRoot, { mode: 0o700 });
    await mkdir(packagerTemporaryRoot, { mode: 0o700 });
    await buildStagingTree(stagingRoot, request.target);
    const stagingTreeSha256 = await hashTree(stagingRoot);
    await mkdir(outputRoot, { mode: 0o700 });
    await writeFile(incompleteMarker, "Unsigned assembly is incomplete.\n", {
      flag: "wx",
      mode: 0o600,
    });
    const packageDirectory = await runPackager({
      electronZip,
      outputRoot,
      packagerTemporaryRoot,
      stagingRoot,
      target,
    });
    const evidence = await verifyPackage({
      extractionRoot,
      packageDirectory,
      stagingRoot,
      target,
    });
    await writeReceipt(outputRoot, request, target, {
      ...evidence,
      stagingTreeSha256,
      packageTreeSha256: await hashTree(packageDirectory),
      packageDirectory: basename(packageDirectory),
    });
    await unlink(incompleteMarker);
    process.stdout.write("Unsigned desktop assembly completed; signing remains required.\n");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function assertAssemblyPolicy() {
  if (
    policy.release.packagingEnabled !== true ||
    policy.release.captureEnabled !== false ||
    policy.release.clinicalReleaseApproved !== false ||
    policy.release.unsignedDistributionAllowed !== false ||
    policy.toolchain.assembler !== "@electron/packager" ||
    policy.toolchain.assemblerVersion !== "20.3.0" ||
    policy.toolchain.assemblerSigningEnabled !== false ||
    policy.toolchain.assemblerFrameworkResignAllowed !== false ||
    policy.toolchain.externalSigningRequired !== true ||
    policy.toolchain.recallOsxSignForkAllowed !== false ||
    policy.archive.asarRequired !== true ||
    policy.archive.embeddedIntegrityRequired !== true ||
    policy.archive.smartUnpackAllowed !== false ||
    policy.archive.unpackedRuntimePath !== sdkRelativePath
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
      (name !== "--target" &&
        name !== "--electron-zip" &&
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
    (parsed["--target"] !== "darwin-arm64" &&
      parsed["--target"] !== "win32-x64") ||
    !/^[0-9a-f]{40}$/u.test(parsed["--source-sha"]) ||
    !isAbsolute(parsed["--electron-zip"]) ||
    !isAbsolute(parsed["--out"])
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  return Object.freeze({
    target: parsed["--target"],
    electronZip: resolve(parsed["--electron-zip"]),
    out: resolve(parsed["--out"]),
    sourceSha: parsed["--source-sha"],
  });
}

function targetDefinition(target) {
  const archive = policy.electronArchives.targets[target];
  const runtimeTree =
    policy.runtimeTrees.targets[target]?.[
      "node_modules/@recallai/desktop-sdk"
    ];
  if (
    policy.electronArchives.version !== "43.4.1" ||
    policy.electronArchives.releaseTag !== "v43.4.1" ||
    archive === undefined ||
    !isSha256(runtimeTree)
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  const [platform, arch] = target.split("-");
  if (
    (platform !== "darwin" && platform !== "win32") ||
    (arch !== "arm64" && arch !== "x64")
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  return Object.freeze({ archive, arch, platform, target });
}

async function assertCleanSource(sourceSha) {
  const head = await runGit(["rev-parse", "HEAD"]);
  const trackedChanges = await runGit([
    "status",
    "--porcelain=v1",
    "--untracked-files=no",
  ]);
  if (head.trim() !== sourceSha || trackedChanges.trim().length !== 0) {
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

async function buildStagingTree(stagingRoot, target) {
  await verifyDistInventory();
  const verifier = await import(
    new URL("../dist/recall-sdk-loader.js", import.meta.url)
  );
  const runtimeEvidence = await verifier.verifyRecallSdkRuntime(
    undefined,
    target,
  );
  if (runtimeEvidence.clinicalReleaseApproved !== false) {
    throw new Error(FAILURE_MESSAGE);
  }

  const stagedPackage = {
    name: appPackage.name,
    version: appPackage.version,
    productName: appPackage.productName,
    description: appPackage.description,
    author: appPackage.author,
    type: "module",
    main: policy.application.main,
  };
  await writeJson(resolve(stagingRoot, "package.json"), stagedPackage);
  await copyApprovedPath(resolve(packageRoot, "dist"), resolve(stagingRoot, "dist"));
  await copyApprovedPath(
    resolve(packageRoot, "archive-safety.mjs"),
    resolve(stagingRoot, "archive-safety.mjs"),
  );
  await copyApprovedPath(
    resolve(packageRoot, "vendor", "recall-desktop-sdk.provenance.json"),
    resolve(stagingRoot, "vendor", "recall-desktop-sdk.provenance.json"),
  );
  await writeJson(resolve(stagingRoot, "vendor-runtime", "package.json"), {
    name: vendorPackage.name,
    version: vendorPackage.version,
    private: true,
    dependencies: vendorPackage.dependencies,
  });
  await copyApprovedPath(
    resolve(runtimeRoot, "package-lock.json"),
    resolve(stagingRoot, "vendor-runtime", "package-lock.json"),
  );

  const productionPackages = Object.entries(vendorLock.packages)
    .filter(([name, value]) => name !== "" && value.dev !== true)
    .map(([name]) => name)
    .sort();
  if (
    productionPackages.length !== 8 ||
    !productionPackages.includes("node_modules/@recallai/desktop-sdk")
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  for (const lockPath of productionPackages) {
    if (!isSafeLockPath(lockPath)) {
      throw new Error(FAILURE_MESSAGE);
    }
    const source = resolve(runtimeRoot, lockPath);
    const destination = resolve(stagingRoot, "vendor-runtime", lockPath);
    const expectedTreeSha256 =
      lockPath === "node_modules/@recallai/desktop-sdk"
        ? policy.runtimeTrees.targets[target][lockPath]
        : policy.runtimeTrees.common[lockPath];
    if (
      !isSha256(expectedTreeSha256) ||
      (await hashTree(source)) !== expectedTreeSha256
    ) {
      throw new Error(FAILURE_MESSAGE);
    }
    await copyApprovedPath(source, destination, {
      symlinkBoundary:
        lockPath === "node_modules/@recallai/desktop-sdk" ? source : undefined,
    });
  }
  await inspectTree(stagingRoot, {
    symlinkBoundary: resolve(stagingRoot, sdkRelativePath),
  });
}

async function verifyDistInventory() {
  const expected = new Set();
  for (const path of await listFiles(resolve(packageRoot, "src"))) {
    if (path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts")) {
      expected.add(path.slice(0, -3) + ".js");
    }
  }
  for (const path of await listFiles(resolve(packageRoot, "static", "renderer"))) {
    expected.add(`renderer/${path}`);
  }
  expected.add("preload.cjs");
  const actual = await listFiles(resolve(packageRoot, "dist"));
  if (
    actual.length !== expected.size ||
    actual.some((path) => !expected.has(path))
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
}

async function runPackager({
  electronZip,
  outputRoot,
  packagerTemporaryRoot,
  stagingRoot,
  target,
}) {
  const vendorRequire = createRequire(resolve(runtimeRoot, "package.json"));
  const loaded = vendorRequire("@electron/packager");
  const packager = selectPackagerExport(loaded);
  const paths = await packager(
    createPackagerOptions({
      electronZip,
      outputRoot,
      packagerTemporaryRoot,
      stagingRoot,
      target,
    }),
  );
  if (!Array.isArray(paths) || paths.length !== 1) {
    throw new Error(FAILURE_MESSAGE);
  }
  const packageDirectory = await realpath(paths[0]);
  if (!isWithin(outputRoot, packageDirectory)) {
    throw new Error(FAILURE_MESSAGE);
  }
  return packageDirectory;
}

function createPackagerOptions({
  electronZip,
  outputRoot,
  packagerTemporaryRoot,
  stagingRoot,
  target,
}) {
  return {
    appBundleId: policy.application.bundleIdentifier,
    appVersion: appPackage.version,
    arch: target.arch,
    asar: {
      smartUnpack: false,
      unpackDir: policy.archive.unpackedRuntimePath,
    },
    asarIntegrityDigest: false,
    buildVersion: appPackage.version,
    derefSymlinks: false,
    dir: stagingRoot,
    electronVersion: policy.electronArchives.version,
    electronZipDir: dirname(electronZip),
    ignore: () => false,
    junk: false,
    name: policy.application.productName,
    out: outputRoot,
    overwrite: false,
    platform: target.platform,
    prune: false,
    quiet: true,
    tmpdir: packagerTemporaryRoot,
    afterCopy: [
      async ({ arch, buildPath, electronVersion, platform }) => {
        if (
          arch !== target.arch ||
          platform !== target.platform ||
          electronVersion !== policy.electronArchives.version ||
          !isWithin(packagerTemporaryRoot, await requireExactDirectory(buildPath))
        ) {
          throw new Error(FAILURE_MESSAGE);
        }
        await restoreApprovedRuntimeSymlinks(stagingRoot, buildPath);
      },
    ],
    ...(target.platform === "darwin"
      ? {
          protocols: [
            {
              name: "CosmaNeura Capture",
              schemes: [policy.application.protocol],
            },
          ],
        }
      : {}),
  };
}

async function restoreApprovedRuntimeSymlinks(stagingRoot, buildPath) {
  const sourceRoot = resolve(stagingRoot, sdkRelativePath);
  const destinationRoot = resolve(buildPath, sdkRelativePath);
  await inspectTree(sourceRoot, { symlinkBoundary: sourceRoot });
  await requireExactDirectory(destinationRoot);
  const links = await listInternalSymlinks(sourceRoot);
  if (links.length === 0) {
    throw new Error(FAILURE_MESSAGE);
  }
  for (const { path, target } of links) {
    const destination = resolve(destinationRoot, path);
    if (!isWithin(destinationRoot, destination)) {
      throw new Error(FAILURE_MESSAGE);
    }
    const details = await lstat(destination);
    if (!details.isSymbolicLink()) {
      throw new Error(FAILURE_MESSAGE);
    }
    await unlink(destination);
    await symlink(target, destination);
  }
  await inspectTree(destinationRoot, { symlinkBoundary: destinationRoot });
  if ((await hashTree(sourceRoot)) !== (await hashTree(destinationRoot))) {
    throw new Error(FAILURE_MESSAGE);
  }
}

async function listInternalSymlinks(root) {
  const links = [];
  const visit = async (path, prefix) => {
    const names = (await readdir(path)).sort();
    for (const name of names) {
      const child = resolve(path, name);
      const childPrefix = prefix.length === 0 ? name : `${prefix}/${name}`;
      const details = await lstat(child);
      if (details.isSymbolicLink()) {
        links.push({ path: childPrefix, target: await readlink(child) });
      } else if (details.isDirectory()) {
        await visit(child, childPrefix);
      }
    }
  };
  await visit(await requireExactDirectory(root), "");
  return links;
}

function selectPackagerExport(loaded) {
  if (typeof loaded === "function") {
    return loaded;
  }
  if (
    typeof loaded === "object" &&
    loaded !== null &&
    typeof loaded.packager === "function"
  ) {
    return loaded.packager;
  }
  if (
    typeof loaded === "object" &&
    loaded !== null &&
    typeof loaded.default === "function"
  ) {
    return loaded.default;
  }
  throw new Error(FAILURE_MESSAGE);
}

async function verifyPackage({
  extractionRoot,
  packageDirectory,
  stagingRoot,
  target,
}) {
  const resourcesPath =
    target.platform === "darwin"
      ? resolve(
          packageDirectory,
          `${policy.application.productName}.app`,
          "Contents",
          "Resources",
        )
      : resolve(packageDirectory, "resources");
  const archivePath = await requireExactFile(resolve(resourcesPath, "app.asar"));
  await requireAbsent(resolve(resourcesPath, "app"));
  const unpackedRoot = await requireExactDirectory(
    resolve(resourcesPath, "app.asar.unpacked"),
  );
  await assertOnlyRuntimeIsUnpacked(unpackedRoot);

  const stagedSdk = resolve(stagingRoot, sdkRelativePath);
  const unpackedSdk = resolve(unpackedRoot, sdkRelativePath);
  if ((await hashTree(stagedSdk)) !== (await hashTree(unpackedSdk))) {
    throw new Error(FAILURE_MESSAGE);
  }

  const vendorRequire = createRequire(resolve(runtimeRoot, "package.json"));
  const asar = vendorRequire("@electron/asar");
  if (typeof asar.extractAll !== "function" || typeof asar.getRawHeader !== "function") {
    throw new Error(FAILURE_MESSAGE);
  }
  verifyAsarIntegrityHeader(asar.getRawHeader(archivePath).header);
  await mkdir(extractionRoot, { mode: 0o700 });
  await asar.extractAll(archivePath, extractionRoot);
  if ((await hashTree(stagingRoot)) !== (await hashTree(extractionRoot))) {
    throw new Error(FAILURE_MESSAGE);
  }
  return Object.freeze({
    appAsarSha256: await hashFile(archivePath),
    unpackedRuntimeTreeSha256: await hashTree(unpackedSdk),
  });
}

function verifyAsarIntegrityHeader(header) {
  if (typeof header !== "object" || header === null || typeof header.files !== "object") {
    throw new Error(FAILURE_MESSAGE);
  }
  let packedFileCount = 0;
  const visit = (entries) => {
    for (const entry of Object.values(entries)) {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(FAILURE_MESSAGE);
      }
      if (entry.files !== undefined) {
        visit(entry.files);
      } else if (entry.link === undefined && entry.unpacked !== true) {
        packedFileCount += 1;
        if (
          entry.integrity?.algorithm !== "SHA256" ||
          !/^[0-9a-f]{64}$/u.test(entry.integrity.hash) ||
          !Number.isSafeInteger(entry.integrity.blockSize) ||
          entry.integrity.blockSize <= 0 ||
          !Array.isArray(entry.integrity.blocks) ||
          entry.integrity.blocks.some((block) => !/^[0-9a-f]{64}$/u.test(block))
        ) {
          throw new Error(FAILURE_MESSAGE);
        }
      }
    }
  };
  visit(header.files);
  if (packedFileCount === 0) {
    throw new Error(FAILURE_MESSAGE);
  }
}

async function assertOnlyRuntimeIsUnpacked(unpackedRoot) {
  const allowed = policy.archive.unpackedRuntimePath;
  const entries = await listTreeEntries(unpackedRoot);
  if (!entries.includes(allowed)) {
    throw new Error(FAILURE_MESSAGE);
  }
  for (const entry of entries) {
    if (
      entry !== allowed &&
      !entry.startsWith(`${allowed}/`) &&
      !allowed.startsWith(`${entry}/`)
    ) {
      throw new Error(FAILURE_MESSAGE);
    }
  }
  await inspectTree(resolve(unpackedRoot, allowed), {
    symlinkBoundary: resolve(unpackedRoot, allowed),
  });
}

async function writeReceipt(outputRoot, request, target, evidence) {
  const receipt = {
    schemaVersion: 1,
    sourceSha: request.sourceSha,
    target: request.target,
    assembler: {
      name: policy.toolchain.assembler,
      version: policy.toolchain.assemblerVersion,
      integritySha512: policy.toolchain.assemblerIntegritySha512,
      signingEnabled: false,
      frameworkResignAllowed: false,
    },
    electron: {
      version: policy.electronArchives.version,
      releaseTag: policy.electronArchives.releaseTag,
      archiveFilename: target.archive.filename,
      archiveSha256: target.archive.sha256,
    },
    runtimeTrees: {
      common: policy.runtimeTrees.common,
      target: policy.runtimeTrees.targets[request.target],
    },
    archive: {
      asarRequired: true,
      embeddedIntegrityRequired: true,
      smartUnpackAllowed: false,
      unpackedRuntimePath: policy.archive.unpackedRuntimePath,
      appAsarSha256: evidence.appAsarSha256,
      unpackedRuntimeTreeSha256: evidence.unpackedRuntimeTreeSha256,
    },
    stagingTreeSha256: evidence.stagingTreeSha256,
    packageDirectory: evidence.packageDirectory,
    preHardenedPackageTreeSha256: evidence.packageTreeSha256,
    signed: false,
    distributionAllowed: false,
  };
  const destination = resolve(
    outputRoot,
    `assembly-receipt-${request.target}.json`,
  );
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, destination);
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

async function copyApprovedPath(source, destination, options = {}) {
  await inspectTree(source, options);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await cp(source, destination, {
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: false,
    recursive: true,
    verbatimSymlinks: true,
  });
}

async function inspectTree(root, { symlinkBoundary } = {}) {
  const requestedRoot = resolve(root);
  const rootPath = await realpath(requestedRoot);
  if (rootPath !== requestedRoot) {
    throw new Error(FAILURE_MESSAGE);
  }
  const boundary =
    symlinkBoundary === undefined ? undefined : await realpath(symlinkBoundary);
  if (
    symlinkBoundary !== undefined &&
    boundary !== resolve(symlinkBoundary)
  ) {
    throw new Error(FAILURE_MESSAGE);
  }
  const visit = async (path) => {
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
      if (boundary === undefined || !isWithin(boundary, path)) {
        throw new Error(FAILURE_MESSAGE);
      }
      const target = await readlink(path);
      if (
        isAbsolute(target) ||
        !isWithin(boundary, resolve(dirname(path), target)) ||
        !isWithin(boundary, await realpath(path))
      ) {
        throw new Error(FAILURE_MESSAGE);
      }
      return;
    }
    if (details.isDirectory()) {
      const names = (await readdir(path)).sort();
      for (const name of names) {
        await visit(resolve(path, name));
      }
      return;
    }
    if (!details.isFile()) {
      throw new Error(FAILURE_MESSAGE);
    }
  };
  await visit(rootPath);
}

async function listFiles(root) {
  const files = [];
  const visit = async (path, prefix) => {
    const names = (await readdir(path)).sort();
    for (const name of names) {
      const child = resolve(path, name);
      const childPrefix = prefix.length === 0 ? name : `${prefix}/${name}`;
      const details = await lstat(child);
      if (details.isDirectory() && !details.isSymbolicLink()) {
        await visit(child, childPrefix);
      } else if (details.isFile() && !details.isSymbolicLink()) {
        files.push(childPrefix);
      } else {
        throw new Error(FAILURE_MESSAGE);
      }
    }
  };
  await visit(await requireExactDirectory(root), "");
  return files;
}

async function listTreeEntries(root) {
  const entries = [];
  const visit = async (path, prefix) => {
    const names = (await readdir(path)).sort();
    for (const name of names) {
      const child = resolve(path, name);
      const childPrefix = prefix.length === 0 ? name : `${prefix}/${name}`;
      entries.push(childPrefix);
      const details = await lstat(child);
      if (details.isDirectory() && !details.isSymbolicLink()) {
        await visit(child, childPrefix);
      }
    }
  };
  await visit(await requireExactDirectory(root), "");
  return entries;
}

async function hashTree(root) {
  const records = [];
  const rootPath = await requireExactDirectory(root);
  const visit = async (path, prefix) => {
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
      records.push(`link\0${prefix}\0${await readlink(path)}\n`);
      return;
    }
    if (details.isDirectory()) {
      if (prefix.length > 0) {
        records.push(`directory\0${prefix}\n`);
      }
      const names = (await readdir(path)).sort();
      for (const name of names) {
        await visit(
          resolve(path, name),
          prefix.length === 0 ? name : `${prefix}/${name}`,
        );
      }
      return;
    }
    if (!details.isFile()) {
      throw new Error(FAILURE_MESSAGE);
    }
    records.push(`file\0${prefix}\0${await hashFile(path)}\n`);
  };
  await visit(rootPath, "");
  return createHash("sha256").update(records.join(""), "utf8").digest("hex");
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function requireExactFile(requestedPath) {
  const resolvedPath = resolve(requestedPath);
  const canonicalPath = await realpath(resolvedPath);
  const details = await lstat(canonicalPath);
  if (canonicalPath !== resolvedPath || !details.isFile() || details.isSymbolicLink()) {
    throw new Error(FAILURE_MESSAGE);
  }
  return canonicalPath;
}

async function requireExactDirectory(requestedPath) {
  const resolvedPath = resolve(requestedPath);
  const canonicalPath = await realpath(resolvedPath);
  const details = await lstat(canonicalPath);
  if (canonicalPath !== resolvedPath || !details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(FAILURE_MESSAGE);
  }
  return canonicalPath;
}

async function requireNewOutputPath(requestedPath) {
  const outputPath = resolve(requestedPath);
  const parent = resolve(dirname(outputPath));
  if ((await realpath(parent)) !== parent) {
    throw new Error(FAILURE_MESSAGE);
  }
  await requireExactDirectory(parent);
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

function isSafeLockPath(path) {
  return (
    path.startsWith("node_modules/") &&
    !path.includes("\\") &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
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

export {
  createPackagerOptions,
  hashTree,
  isSafeLockPath,
  isWithin,
  parseArguments,
  restoreApprovedRuntimeSymlinks,
  selectPackagerExport,
  verifyAsarIntegrityHeader,
};
