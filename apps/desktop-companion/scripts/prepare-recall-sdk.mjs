import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeRecallNativeArchiveEntry } from "../archive-safety.mjs";
import {
  patchRecallWrapper,
  SAFE_SETUP_SOURCE,
  sha256,
} from "./recall-vendor-patch.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = resolve(packageRoot, "vendor-runtime");
const sdkRoot = resolve(
  runtimeRoot,
  "node_modules",
  "@recallai",
  "desktop-sdk",
);
const manifestPath = resolve(
  packageRoot,
  "vendor",
  "recall-desktop-sdk.provenance.json",
);
const lockPath = resolve(runtimeRoot, "package-lock.json");
const receiptDirectory = resolve(sdkRoot, ".cosmas-provenance");
const receiptPath = resolve(receiptDirectory, "receipt.json");

const args = process.argv.slice(2);
const mode =
  args[0] === "--verify-source" || args[0] === "--patch-source"
    ? args[0]
    : "prepare";
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

await verifyManifestAndLock();
const sourceState = await verifySource();

if (mode === "--verify-source") {
  process.stdout.write(`Recall SDK source verified (${sourceState}).\n`);
} else if (mode === "--patch-source") {
  await patchSource(sourceState);
  process.stdout.write("Recall SDK source patch verified; native runtime remains disabled.\n");
} else if (mode === "prepare") {
  const options = parsePrepareArguments(args);
  await prepareRuntime(options, sourceState);
  process.stdout.write("Recall SDK package, patch, and native artifact verified.\n");
} else {
  throw new Error("Unsupported Recall SDK preparation mode");
}

async function verifyManifestAndLock() {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.clinicalReleaseApproved !== false ||
    manifest.package?.name !== "@recallai/desktop-sdk" ||
    manifest.package?.version !== "2.0.28" ||
    manifest.package?.commitSha !== "62bf3a1f8995af470272b2198f39f2f53c150fdc" ||
    manifest.electron?.version !== "43.4.1"
  ) {
    throw new Error("Recall provenance manifest is invalid");
  }
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const sdkLock = lock.packages?.["node_modules/@recallai/desktop-sdk"];
  const electronLock = lock.packages?.["node_modules/electron"];
  if (
    sdkLock?.version !== manifest.package.version ||
    sdkLock?.integrity !== manifest.package.registryIntegritySha512 ||
    sdkLock?.hasInstallScript !== true ||
    electronLock?.version !== manifest.electron.version ||
    electronLock?.integrity !== manifest.electron.registryIntegritySha512
  ) {
    throw new Error("Desktop runtime lock does not match reviewed provenance");
  }
  const packageMetadata = JSON.parse(
    await readFile(resolve(sdkRoot, "package.json"), "utf8"),
  );
  if (
    packageMetadata.name !== manifest.package.name ||
    packageMetadata.version !== manifest.package.version ||
    packageMetadata.commit_sha !== manifest.package.commitSha
  ) {
    throw new Error("Installed Recall package metadata is not approved");
  }
}

async function verifySource() {
  for (const [file, expected] of Object.entries(manifest.package.sourceFiles)) {
    if (file === "index.js" || file === "setup.js") {
      continue;
    }
    if ((await hashFile(resolve(sdkRoot, file))) !== expected) {
      throw new Error("Installed Recall source does not match reviewed package");
    }
  }
  const indexHash = await hashFile(resolve(sdkRoot, "index.js"));
  const setupHash = await hashFile(resolve(sdkRoot, "setup.js"));
  const upstream =
    indexHash === manifest.package.sourceFiles["index.js"] &&
    setupHash === manifest.package.sourceFiles["setup.js"];
  const patched =
    indexHash === manifest.package.patchedFiles["index.js"] &&
    setupHash === manifest.package.patchedFiles["setup.js"];
  if (!upstream && !patched) {
    throw new Error("Recall source is neither reviewed upstream nor reviewed patched content");
  }
  return upstream ? "upstream" : "patched";
}

async function patchSource(sourceState) {
  if (sourceState === "upstream") {
    const sourcePath = resolve(sdkRoot, "index.js");
    const source = await readFile(sourcePath, "utf8");
    await atomicWrite(sourcePath, patchRecallWrapper(source));
    await atomicWrite(resolve(sdkRoot, "setup.js"), SAFE_SETUP_SOURCE);
  }
  if (
    (await hashFile(resolve(sdkRoot, "index.js"))) !==
      manifest.package.patchedFiles["index.js"] ||
    (await hashFile(resolve(sdkRoot, "setup.js"))) !==
      manifest.package.patchedFiles["setup.js"]
  ) {
    throw new Error("Recall source patch verification failed");
  }
}

function parsePrepareArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (
      (name !== "--package-archive" &&
        name !== "--native-archive" &&
        name !== "--platform") ||
      value === undefined
    ) {
      throw new Error("Recall preparation arguments are invalid");
    }
    result[name.slice(2)] = value;
  }
  if (
    typeof result["package-archive"] !== "string" ||
    typeof result["native-archive"] !== "string" ||
    (result.platform !== "darwin-arm64" && result.platform !== "win32-x64")
  ) {
    throw new Error("Recall preparation requires package archive, native archive, and platform");
  }
  return {
    packageArchive: resolve(result["package-archive"]),
    nativeArchive: resolve(result["native-archive"]),
    platform: result.platform,
  };
}

async function prepareRuntime(options, sourceState) {
  const native = manifest.nativeArtifacts[options.platform];
  if (
    (await hashFile(options.packageArchive)) !==
      manifest.package.registryTarballSha256 ||
    (await hashFile(options.nativeArchive)) !== native.sha256
  ) {
    throw new Error("Recall package or native archive checksum is not approved");
  }
  for (const root of native.allowedRoots) {
    try {
      await stat(resolve(sdkRoot, root));
      throw new Error("Unverified Recall native files already exist");
    } catch (error) {
      if (error instanceof Error && error.message === "Unverified Recall native files already exist") {
        throw error;
      }
      if (!isMissingFileError(error)) {
        throw new Error("Recall native destination could not be inspected", {
          cause: error,
        });
      }
    }
  }

  await patchSource(sourceState);
  const archiveEvidence = await inspectArchive(
    options.nativeArchive,
    native.allowedRoots,
  );
  if (!native.allowedRoots.some((root) => archiveEvidence.roots.has(root))) {
    throw new Error("Recall native archive has no expected executable root");
  }

  const runtimeRequire = createRequire(resolve(runtimeRoot, "package.json"));
  const tar = runtimeRequire("tar");
  await tar.extract({
    cwd: sdkRoot,
    file: options.nativeArchive,
    preservePaths: false,
    strict: true,
  });

  await mkdir(receiptDirectory, { recursive: true });
  const packageCopy = resolve(receiptDirectory, "registry-package.tgz");
  const nativeCopy = resolve(
    receiptDirectory,
    `native-${options.platform}.tar`,
  );
  await copyFile(options.packageArchive, packageCopy);
  await copyFile(options.nativeArchive, nativeCopy);
  const nativeTreeSha256 = await hashNativeTree(native.allowedRoots);
  if (nativeTreeSha256 !== archiveEvidence.treeSha256) {
    throw new Error("Extracted Recall native tree differs from the pinned archive");
  }
  const receipt = {
    schemaVersion: 1,
    platform: options.platform,
    packageTarballSha256: await hashFile(packageCopy),
    nativeArchiveSha256: await hashFile(nativeCopy),
    nativeArchiveTreeSha256: archiveEvidence.treeSha256,
    nativeTreeSha256,
    patchedIndexSha256: await hashFile(resolve(sdkRoot, "index.js")),
    patchedSetupSha256: await hashFile(resolve(sdkRoot, "setup.js")),
  };
  await atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

async function inspectArchive(archivePath, allowedRoots) {
  const runtimeRequire = createRequire(resolve(runtimeRoot, "package.json"));
  const tar = runtimeRequire("tar");
  const seen = new Set();
  const records = [];
  const pendingFiles = [];
  await tar.list({
    file: archivePath,
    strict: true,
    onReadEntry(entry) {
      const normalized = normalizeRecallNativeArchiveEntry(
        entry.path,
        entry.linkpath,
        allowedRoots,
      );
      const root = normalized.split("/")[0];
      seen.add(root);
      if (entry.type === "Directory") {
        return;
      }
      if (entry.type === "SymbolicLink") {
        records.push(`${normalized}\0link\0${entry.linkpath ?? ""}`);
        return;
      }
      if (entry.type !== "File" && entry.type !== "OldFile") {
        throw new Error("Recall native archive contains an unsupported entry");
      }
      const digest = createHash("sha256");
      pendingFiles.push(
        new Promise((resolveEntry, rejectEntry) => {
          entry.on("data", (chunk) => digest.update(chunk));
          entry.on("end", () => {
            records.push(`${normalized}\0file\0${digest.digest("hex")}`);
            resolveEntry();
          });
          entry.on("error", rejectEntry);
        }),
      );
    },
  });
  await Promise.all(pendingFiles);
  records.sort();
  return { roots: seen, treeSha256: sha256(records.join("\n")) };
}

async function hashNativeTree(allowedRoots) {
  const records = [];
  for (const root of allowedRoots) {
    await collectTree(resolve(sdkRoot, root), root, records);
  }
  records.sort();
  return sha256(records.join("\n"));
}

async function collectTree(path, relative, records) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    records.push(`${relative}\0link\0${await readlink(path)}`);
    return;
  }
  if (metadata.isFile()) {
    records.push(`${relative}\0file\0${await hashFile(path)}`);
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error("Recall native tree contains an unsupported entry");
  }
  const children = await readdir(path);
  children.sort();
  for (const child of children) {
    await collectTree(join(path, child), `${relative}/${child}`, records);
  }
}

async function hashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function atomicWrite(path, content) {
  if (!isAbsolute(path) || !path.startsWith(`${sdkRoot}${sep}`)) {
    throw new Error("Refusing to write outside the isolated Recall package");
  }
  const temporary = join(dirname(path), `.${basename(path)}.cosmas-new`);
  await writeFile(temporary, content, { mode: 0o644 });
  await rename(temporary, path);
}

function isMissingFileError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
