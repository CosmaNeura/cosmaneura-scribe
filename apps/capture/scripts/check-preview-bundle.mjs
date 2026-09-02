import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(appRoot, "dist");
const files = await walk(distRoot);
const forbiddenNames = /(?:browser-microphone-source|capacitor-ios-native-pcm-bridge|pcm-capture-worklet)/u;
const forbiddenCode = /(?:getUserMedia|AudioWorkletNode|iosNativePcmEvent|CapacitorCustomPlatform)/u;
const deploymentAttestationName = "capture-preview-deployment.json";
const sourceSha = process.env.DEPLOY_SHA;

if (sourceSha === undefined || !/^[0-9a-f]{40}$/u.test(sourceSha)) {
  throw new Error("DEPLOY_SHA must be an exact lowercase 40-character Git commit SHA");
}

for (const file of files) {
  if (forbiddenNames.test(file)) {
    throw new Error("dormant preview bundle contains a microphone asset");
  }
  if (file.endsWith(".js") && forbiddenCode.test(await readFile(file, "utf8"))) {
    throw new Error("dormant preview bundle contains microphone or Capacitor runtime code");
  }
}

const staticConfig = await readFile(resolve(distRoot, "staticwebapp.config.json"), "utf8");
if (!staticConfig.includes("microphone=()") || staticConfig.includes("microphone=(self)")) {
  throw new Error("dormant preview bundle does not disable microphone permission");
}
const staticPolicy = JSON.parse(staticConfig);
const attestationRoute = staticPolicy.routes?.find(
  (route) => route?.route === `/${deploymentAttestationName}`,
);
if (attestationRoute?.headers?.["Cache-Control"] !== "no-store") {
  throw new Error("deployment attestation response is not explicitly non-cacheable");
}

const attestation = JSON.parse(
  await readFile(resolve(distRoot, deploymentAttestationName), "utf8"),
);
if (
  JSON.stringify(Object.keys(attestation).sort()) !==
    JSON.stringify(["microphone_enabled", "mode", "schema_version", "source_sha"]) ||
  attestation.schema_version !== 1 ||
  attestation.source_sha !== sourceSha ||
  attestation.mode !== "synthetic" ||
  attestation.microphone_enabled !== false
) {
  throw new Error("deployment attestation does not identify the exact synthetic build");
}

const serviceWorker = await readFile(resolve(distRoot, "sw.js"), "utf8");
if (serviceWorker.includes(deploymentAttestationName)) {
  throw new Error("deployment attestation must not be present in the service-worker precache");
}

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}
