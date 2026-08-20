import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(packageRoot, "dist-package");
const entryPoint = resolve(output, "index.js");
const manifest = JSON.parse(
  await readFile(resolve(output, "package.json"), "utf8"),
);

assert.equal(process.version, "v22.23.2", "unexpected Node 22 verification patch");
assert.equal(manifest.engines?.node, ">=22.0.0 <23");

const syntaxCheck = spawnSync(process.execPath, ["--check", entryPoint], {
  encoding: "utf8",
});
assert.equal(
  syntaxCheck.status,
  0,
  `Node 22 syntax check failed: ${syntaxCheck.stderr || syntaxCheck.stdout}`,
);

Object.assign(process.env, {
  CAPTURE_PREVIEW_ALLOWED_HOSTS: "synthetic-preview.azurestaticapps.net",
  CAPTURE_PREVIEW_COSMOS_CONTAINER: "state",
  CAPTURE_PREVIEW_COSMOS_DATABASE: "capture-preview",
  CAPTURE_PREVIEW_COSMOS_ENDPOINT: "https://synthetic-preview.documents.azure.com/",
  CAPTURE_PREVIEW_MANAGED_IDENTITY_CLIENT_ID:
    "00000000-0000-4000-8000-000000000001",
});

await import(pathToFileURL(entryPoint).href);
