import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  readlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isRecallNativeArchiveRootDirectory,
  normalizeRecallNativeArchiveEntry,
} from "../archive-safety.mjs";
import type {
  RecallEventName,
  RecallPermission,
  RecallSdkInitOptions,
  RecallSdkPort,
} from "./recall-sdk-adapter.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface RecallRuntimePaths {
  readonly manifestPath: string;
  readonly runtimeRoot: string;
  readonly sdkRoot: string;
}

export interface RecallRuntimeEvidence {
  readonly platform: "darwin-arm64" | "win32-x64";
  readonly packageVersion: "2.0.28";
  readonly patched: true;
  readonly clinicalReleaseApproved: boolean;
}

export const DEFAULT_RECALL_RUNTIME_PATHS: RecallRuntimePaths = Object.freeze({
  manifestPath: resolve(
    packageRoot,
    "vendor",
    "recall-desktop-sdk.provenance.json",
  ),
  runtimeRoot: resolve(packageRoot, "vendor-runtime"),
  sdkRoot: resolve(
    packageRoot,
    "vendor-runtime",
    "node_modules",
    "@recallai",
    "desktop-sdk",
  ),
});

/**
 * Verify the patched JavaScript, the retained registry/native archives, and the
 * extracted native tree before allowing the vendor module to load.
 */
export async function verifyRecallSdkRuntime(
  paths: RecallRuntimePaths = DEFAULT_RECALL_RUNTIME_PATHS,
  platform = runtimePlatform(),
): Promise<RecallRuntimeEvidence> {
  const manifest = await readManifest(paths.manifestPath);
  await verifyRecallSdkSource(paths, manifest, true);
  const native = manifest.nativeArtifacts[platform];
  if (native === undefined) {
    throw new Error("Recall runtime platform is not approved");
  }
  const receiptPath = resolve(
    paths.sdkRoot,
    ".cosmas-provenance",
    "receipt.json",
  );
  const receipt = asRecord(JSON.parse(await readFile(receiptPath, "utf8")));
  assertExactKeys(receipt, [
    "schemaVersion",
    "platform",
    "packageTarballSha256",
    "nativeArchiveSha256",
    "nativeArchiveTreeSha256",
    "nativeTreeSha256",
    "patchedIndexSha256",
    "patchedSetupSha256",
  ]);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.platform !== platform ||
    receipt.packageTarballSha256 !== manifest.package.registryTarballSha256 ||
    receipt.nativeArchiveSha256 !== native.sha256 ||
    receipt.patchedIndexSha256 !== manifest.package.patchedFiles["index.js"] ||
    receipt.patchedSetupSha256 !== manifest.package.patchedFiles["setup.js"]
  ) {
    throw new Error("Recall runtime provenance receipt is invalid");
  }
  const provenanceRoot = resolve(paths.sdkRoot, ".cosmas-provenance");
  const nativeArchivePath = resolve(
    provenanceRoot,
    `native-${platform}.tar`,
  );
  const archiveTreeSha256 = await hashNativeArchive(
    nativeArchivePath,
    native.allowedRoots,
    paths.runtimeRoot,
  );
  assertRecallNativeRuntimeEvidence({
    packageTarballSha256: await hashFile(
      resolve(provenanceRoot, "registry-package.tgz"),
    ),
    expectedPackageTarballSha256: manifest.package.registryTarballSha256,
    nativeArchiveSha256: await hashFile(nativeArchivePath),
    expectedNativeArchiveSha256: native.sha256,
    archiveTreeSha256,
    receiptArchiveTreeSha256: receipt.nativeArchiveTreeSha256,
    receiptNativeTreeSha256: receipt.nativeTreeSha256,
    extractedNativeTreeSha256: await hashNativeTree(
      paths.sdkRoot,
      native.allowedRoots,
    ),
  });
  return Object.freeze({
    platform,
    packageVersion: "2.0.28",
    patched: true,
    clinicalReleaseApproved: manifest.clinicalReleaseApproved,
  });
}

/** The disabled application bootstrap does not call this loader. */
export async function loadVerifiedRecallSdk(
  paths: RecallRuntimePaths = DEFAULT_RECALL_RUNTIME_PATHS,
): Promise<RecallSdkPort> {
  const releaseManifest = await readManifest(paths.manifestPath);
  assertRecallClinicalReleaseApproved(
    releaseManifest.clinicalReleaseApproved,
  );
  const evidence = await verifyRecallSdkRuntime(paths);
  assertRecallClinicalReleaseApproved(evidence.clinicalReleaseApproved);
  const runtimeRequire = createRequire(resolve(paths.runtimeRoot, "package.json"));
  const loaded: unknown = runtimeRequire("@recallai/desktop-sdk");
  const module = asRecord(loaded);
  const candidate = isRecord(module.default) ? module.default : module;
  for (const name of [
    "init",
    "shutdown",
    "startRecording",
    "stopRecording",
    "requestPermission",
    "addEventListener",
    "removeEventListener",
  ]) {
    if (typeof candidate[name] !== "function") {
      throw new Error("Verified Recall module has an invalid runtime surface");
    }
  }
  return Object.freeze({
    init: (options: RecallSdkInitOptions) =>
      callPromise(candidate, "init", [options]),
    shutdown: () => callPromise(candidate, "shutdown", []),
    startRecording: (config: { windowId: string; uploadToken: string }) =>
      callPromise(candidate, "startRecording", [config]),
    stopRecording: (config: { readonly windowId: string }) =>
      callPromise(candidate, "stopRecording", [config]),
    requestPermission: (permission: RecallPermission) =>
      callPromise(candidate, "requestPermission", [permission]),
    addEventListener: (
      type: RecallEventName,
      callback: (payload: unknown) => void,
    ) => callVoid(candidate, "addEventListener", [type, callback]),
    removeEventListener: (
      type: RecallEventName,
      callback: (payload: unknown) => void,
    ) => callVoid(candidate, "removeEventListener", [type, callback]),
  });
}

export async function verifyRecallSdkSource(
  paths: RecallRuntimePaths,
  manifestValue?: RecallProvenanceManifest,
  requirePatched = true,
): Promise<"upstream" | "patched"> {
  const manifest = manifestValue ?? (await readManifest(paths.manifestPath));
  const lock = asRecord(
    JSON.parse(
      await readFile(resolve(paths.runtimeRoot, "package-lock.json"), "utf8"),
    ),
  );
  const packages = asRecord(lock.packages);
  const sdkLock = asRecord(packages["node_modules/@recallai/desktop-sdk"]);
  const electronLock = asRecord(packages["node_modules/electron"]);
  if (
    sdkLock.version !== manifest.package.version ||
    sdkLock.integrity !== manifest.package.registryIntegritySha512 ||
    sdkLock.hasInstallScript !== true ||
    electronLock.version !== manifest.electron.version ||
    electronLock.integrity !== manifest.electron.registryIntegritySha512
  ) {
    throw new Error("Desktop runtime lock is not approved");
  }
  const metadata = asRecord(
    JSON.parse(await readFile(resolve(paths.sdkRoot, "package.json"), "utf8")),
  );
  if (
    metadata.name !== manifest.package.name ||
    metadata.version !== manifest.package.version ||
    metadata.commit_sha !== manifest.package.commitSha ||
    (await hashFile(resolve(paths.sdkRoot, "index.d.ts"))) !==
      manifest.package.sourceFiles["index.d.ts"] ||
    (await hashFile(resolve(paths.sdkRoot, "package.json"))) !==
      manifest.package.sourceFiles["package.json"]
  ) {
    throw new Error("Recall package metadata or declarations are not approved");
  }
  const indexHash = await hashFile(resolve(paths.sdkRoot, "index.js"));
  const setupHash = await hashFile(resolve(paths.sdkRoot, "setup.js"));
  return classifyRecallWrapperHashes(
    { indexHash, setupHash },
    {
      upstreamIndexHash: manifest.package.sourceFiles["index.js"] ?? "",
      upstreamSetupHash: manifest.package.sourceFiles["setup.js"] ?? "",
      patchedIndexHash: manifest.package.patchedFiles["index.js"] ?? "",
      patchedSetupHash: manifest.package.patchedFiles["setup.js"] ?? "",
    },
    requirePatched,
  );
}

export function classifyRecallWrapperHashes(
  actual: { readonly indexHash: string; readonly setupHash: string },
  expected: {
    readonly upstreamIndexHash: string;
    readonly upstreamSetupHash: string;
    readonly patchedIndexHash: string;
    readonly patchedSetupHash: string;
  },
  requirePatched = true,
): "upstream" | "patched" {
  const upstream =
    actual.indexHash === expected.upstreamIndexHash &&
    actual.setupHash === expected.upstreamSetupHash;
  const patched =
    actual.indexHash === expected.patchedIndexHash &&
    actual.setupHash === expected.patchedSetupHash;
  if ((!upstream && !patched) || (requirePatched && !patched)) {
    throw new Error("Recall wrapper is not the exact reviewed patched source");
  }
  return patched ? "patched" : "upstream";
}

export function assertRecallClinicalReleaseApproved(approved: unknown): void {
  if (approved !== true) {
    throw new Error("Recall runtime is not approved for clinical use");
  }
}

export interface RecallNativeRuntimeEvidenceComparison {
  readonly packageTarballSha256: unknown;
  readonly expectedPackageTarballSha256: string;
  readonly nativeArchiveSha256: unknown;
  readonly expectedNativeArchiveSha256: string;
  readonly archiveTreeSha256: unknown;
  readonly receiptArchiveTreeSha256: unknown;
  readonly receiptNativeTreeSha256: unknown;
  readonly extractedNativeTreeSha256: unknown;
}

export function assertRecallNativeRuntimeEvidence(
  evidence: RecallNativeRuntimeEvidenceComparison,
): void {
  if (
    evidence.packageTarballSha256 !==
      evidence.expectedPackageTarballSha256 ||
    evidence.nativeArchiveSha256 !== evidence.expectedNativeArchiveSha256 ||
    typeof evidence.archiveTreeSha256 !== "string" ||
    evidence.archiveTreeSha256.length === 0 ||
    evidence.receiptArchiveTreeSha256 !== evidence.archiveTreeSha256 ||
    evidence.receiptNativeTreeSha256 !== evidence.archiveTreeSha256 ||
    evidence.extractedNativeTreeSha256 !== evidence.archiveTreeSha256
  ) {
    throw new Error("Recall runtime artifact verification failed");
  }
}

interface RecallProvenanceManifest {
  readonly schemaVersion: 1;
  readonly clinicalReleaseApproved: boolean;
  readonly package: {
    readonly name: "@recallai/desktop-sdk";
    readonly version: "2.0.28";
    readonly commitSha: string;
    readonly registryTarballSha256: string;
    readonly registryIntegritySha512: string;
    readonly sourceFiles: Readonly<Record<string, string>>;
    readonly patchedFiles: Readonly<Record<string, string>>;
  };
  readonly electron: {
    readonly version: "43.4.1";
    readonly registryIntegritySha512: string;
  };
  readonly nativeArtifacts: Readonly<
    Record<
      "darwin-arm64" | "win32-x64",
      { readonly sha256: string; readonly allowedRoots: readonly string[] }
    >
  >;
}

async function readManifest(path: string): Promise<RecallProvenanceManifest> {
  const value = asRecord(JSON.parse(await readFile(path, "utf8")));
  if (
    value.schemaVersion !== 1 ||
    typeof value.clinicalReleaseApproved !== "boolean"
  ) {
    throw new Error("Recall provenance manifest is invalid");
  }
  return value as unknown as RecallProvenanceManifest;
}

function runtimePlatform(): "darwin-arm64" | "win32-x64" {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "darwin-arm64";
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return "win32-x64";
  }
  throw new Error("Recall runtime platform is not approved");
}

async function hashNativeTree(
  sdkRoot: string,
  allowedRoots: readonly string[],
): Promise<string> {
  const records: string[] = [];
  for (const root of allowedRoots) {
    await collectTree(resolve(sdkRoot, root), root, records);
  }
  records.sort();
  return createHash("sha256").update(records.join("\n")).digest("hex");
}

async function hashNativeArchive(
  archivePath: string,
  allowedRoots: readonly string[],
  runtimeRoot: string,
): Promise<string> {
  const runtimeRequire = createRequire(resolve(runtimeRoot, "package.json"));
  const tar = runtimeRequire("tar") as TarPort;
  const records: string[] = [];
  const pendingFiles: Array<Promise<void>> = [];
  await tar.list({
    file: archivePath,
    strict: true,
    onReadEntry(entry): void {
      if (
        entry.type === "Directory" &&
        isRecallNativeArchiveRootDirectory(entry.path, entry.linkpath)
      ) {
        return;
      }
      const normalized = normalizeRecallNativeArchiveEntry(
        entry.path,
        entry.linkpath,
        allowedRoots,
      );
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
          entry.on("data", (chunk) => {
            digest.update(chunk);
          });
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
  return createHash("sha256").update(records.join("\n")).digest("hex");
}

interface TarPort {
  list(options: {
    readonly file: string;
    readonly strict: true;
    readonly onReadEntry: (entry: TarEntry) => void;
  }): Promise<void>;
}

interface TarEntry {
  readonly path: string;
  readonly type: string;
  readonly linkpath?: string;
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
}

async function collectTree(
  path: string,
  relative: string,
  records: string[],
): Promise<void> {
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

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Recall runtime metadata is invalid");
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("Recall runtime metadata has unexpected fields");
  }
}

function callPromise(
  target: Record<string, unknown>,
  name: string,
  args: readonly unknown[],
): Promise<unknown> {
  const method = target[name];
  if (typeof method !== "function") {
    throw new Error("Verified Recall module method is unavailable");
  }
  const result: unknown = Reflect.apply(method, target, args);
  return Promise.resolve(result);
}

function callVoid(
  target: Record<string, unknown>,
  name: string,
  args: readonly unknown[],
): void {
  const method = target[name];
  if (typeof method !== "function") {
    throw new Error("Verified Recall module method is unavailable");
  }
  Reflect.apply(method, target, args);
}
