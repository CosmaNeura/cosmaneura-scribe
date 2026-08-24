import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_ROOT = resolve(SCRIPT_PATH, "../..");
const POLICY_PATH = resolve(DESKTOP_ROOT, "release/package-policy.json");
const PROVENANCE_PATH = resolve(
  DESKTOP_ROOT,
  "vendor/recall-desktop-sdk.provenance.json",
);
const VENDOR_LOCK_PATH = resolve(DESKTOP_ROOT, "vendor-runtime/package-lock.json");
const ALLOWED_TARGETS = new Set(["darwin-arm64", "win32-x64"]);

export async function generateDesktopSbom(target) {
  if (!ALLOWED_TARGETS.has(target)) {
    throw new Error("SBOM target is invalid");
  }
  const [policy, provenance, lock] = await Promise.all([
    readJson(POLICY_PATH),
    readJson(PROVENANCE_PATH),
    readJson(VENDOR_LOCK_PATH),
  ]);
  assertReleaseRemainsDisabled(policy);
  const runtimePaths = new Set([
    ...Object.keys(policy.runtimeTrees.common),
    ...Object.keys(policy.runtimeTrees.targets[target]),
  ]);
  if (
    [...runtimePaths].some(
      (path) => policy.runtimeTrees.targets[target]?.[path] === "UNCONFIGURED",
    )
  ) {
    throw new Error("SBOM target runtime is not configured");
  }

  const npmComponents = npmLockComponents(lock, runtimePaths);
  const archiveComponents = inputArchiveComponents(
    target,
    policy,
    provenance,
  );
  const components = [...npmComponents, ...archiveComponents].sort((left, right) =>
    left["bom-ref"].localeCompare(right["bom-ref"]),
  );
  const rootRef = "pkg:npm/%40cosmaneura-scribe/desktop-companion@0.0.0";
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: policy.application.productName,
        version: "0.0.0",
        "bom-ref": rootRef,
        properties: releaseProperties(policy, target),
      },
    },
    components,
    dependencies: npmLockDependencies(lock, rootRef),
  };
}

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      typeof key !== "string" ||
      typeof value !== "string" ||
      !["--target", "--out"].includes(key) ||
      values.has(key)
    ) {
      throw new Error("SBOM arguments are invalid");
    }
    values.set(key, value);
  }
  const target = values.get("--target");
  const out = values.get("--out");
  if (
    values.size !== 2 ||
    !ALLOWED_TARGETS.has(target) ||
    typeof out !== "string" ||
    !isAbsolute(out) ||
    !out.endsWith(".cdx.json")
  ) {
    throw new Error("SBOM arguments are invalid");
  }
  return Object.freeze({ target, out });
}

function npmLockComponents(lock, runtimePaths) {
  return Object.entries(lock.packages)
    .filter(([path]) => path !== "")
    .map(([path, entry]) => {
      const name = packageNameFromPath(path);
      const component = {
        type: "library",
        group: name.startsWith("@") ? name.split("/")[0] : undefined,
        name: name.startsWith("@") ? name.split("/")[1] : name,
        version: requiredString(entry.version),
        scope: runtimePaths.has(path) ? "required" : "excluded",
        "bom-ref": npmBomRef(path, name, entry.version),
        purl: npmPurl(name, entry.version),
        properties: [
          { name: "cosmaneura:lock-path", value: path },
          { name: "cosmaneura:development-only", value: String(entry.dev === true) },
        ],
      };
      if (typeof entry.integrity === "string") {
        component.hashes = [integrityHash(entry.integrity)];
      }
      if (typeof entry.license === "string") {
        component.licenses = [{ license: { id: entry.license } }];
      }
      return removeUndefined(component);
    });
}

function inputArchiveComponents(target, policy, provenance) {
  const electron = policy.electronArchives.targets[target];
  const native = provenance.nativeArtifacts[target];
  return [
    archiveComponent(
      `electron-archive:${target}`,
      electron.filename,
      policy.electronArchives.version,
      electron.sha256,
      target,
    ),
    archiveComponent(
      "recall-registry-package",
      "@recallai/desktop-sdk registry package",
      provenance.package.version,
      provenance.package.registryTarballSha256,
      "all",
    ),
    archiveComponent(
      `recall-native:${target}`,
      `Recall Desktop SDK native ${target}`,
      provenance.package.version,
      native.sha256,
      target,
    ),
  ];
}

function archiveComponent(ref, name, version, sha256, target) {
  return {
    type: "file",
    name: requiredString(name),
    version: requiredString(version),
    scope: "required",
    "bom-ref": ref,
    hashes: [{ alg: "SHA-256", content: sha256.toUpperCase() }],
    properties: [{ name: "cosmaneura:target", value: target }],
  };
}

function npmLockDependencies(lock, rootRef) {
  return Object.entries(lock.packages)
    .map(([path, entry]) => {
      const ref =
        path === ""
          ? rootRef
          : npmBomRef(path, packageNameFromPath(path), entry.version);
      const names = [
        ...Object.keys(entry.dependencies ?? {}),
        ...Object.keys(entry.devDependencies ?? {}),
        ...Object.keys(entry.optionalDependencies ?? {}),
      ];
      const dependsOn = [...new Set(names)]
        .map((name) => resolveDependencyRef(lock.packages, path, name))
        .filter((value) => value !== null)
        .sort();
      return { ref, dependsOn };
    })
    .sort((left, right) => left.ref.localeCompare(right.ref));
}

function resolveDependencyRef(packages, sourcePath, name) {
  let base = sourcePath;
  while (true) {
    const candidate = base === "" ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    const entry = packages[candidate];
    if (entry !== undefined) {
      return npmBomRef(candidate, name, entry.version);
    }
    const marker = base.lastIndexOf("/node_modules/");
    if (marker === -1) {
      if (base === "") {
        return null;
      }
      base = "";
    } else {
      base = base.slice(0, marker);
    }
  }
}

function npmBomRef(path, name, version) {
  return `${npmPurl(name, version)}?lock_path=${encodeURIComponent(path)}`;
}

function npmPurl(name, version) {
  return `pkg:npm/${name.startsWith("@") ? "%40" + name.slice(1) : name}@${requiredString(version)}`;
}

function packageNameFromPath(path) {
  const marker = path.lastIndexOf("node_modules/");
  if (marker === -1) {
    throw new Error("SBOM lock path is invalid");
  }
  return path.slice(marker + "node_modules/".length);
}

function integrityHash(integrity) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity);
  if (match === null) {
    throw new Error("SBOM package integrity is invalid");
  }
  return {
    alg: "SHA-512",
    content: Buffer.from(match[1], "base64").toString("hex").toUpperCase(),
  };
}

function releaseProperties(policy, target) {
  return [
    { name: "cosmaneura:target", value: target },
    {
      name: "cosmaneura:capture-enabled",
      value: String(policy.release.captureEnabled),
    },
    {
      name: "cosmaneura:clinical-release-approved",
      value: String(policy.release.clinicalReleaseApproved),
    },
    {
      name: "cosmaneura:unsigned-distribution-allowed",
      value: String(policy.release.unsignedDistributionAllowed),
    },
  ];
}

function assertReleaseRemainsDisabled(policy) {
  if (
    policy.release.packagingEnabled !== true ||
    policy.release.captureEnabled !== false ||
    policy.release.clinicalReleaseApproved !== false ||
    policy.release.unsignedDistributionAllowed !== false
  ) {
    throw new Error("SBOM generation requires the non-clinical packaging policy");
  }
}

function removeUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function requiredString(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("SBOM source metadata is invalid");
  }
  return value;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const request = parseArguments(process.argv.slice(2));
  const sbom = await generateDesktopSbom(request.target);
  const serialized = `${JSON.stringify(sbom, null, 2)}\n`;
  await writeFile(request.out, serialized, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const digest = createHash("sha256").update(serialized).digest("hex");
  process.stdout.write(`DESKTOP_SBOM_SHA256=${digest}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}
