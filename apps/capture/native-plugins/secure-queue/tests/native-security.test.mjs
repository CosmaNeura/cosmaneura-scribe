import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));

async function source(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

test("pins the JavaScript and Apple Capacitor compatibility boundary", async () => {
  const manifest = JSON.parse(await readFile(`${pluginRoot}/package.json`, "utf8"));
  const podspec = await source("../CosmaneuraScribeCapacitorSecureQueue.podspec");
  const swiftPackage = await source("../Package.swift");

  for (const dependency of ["@capacitor/android", "@capacitor/core", "@capacitor/ios"]) {
    assert.equal(manifest.peerDependencies[dependency], "8.5.0");
  }
  assert.match(podspec, /s\.dependency\s+'Capacitor',\s+'8\.5\.0'/u);
  assert.match(podspec, /s\.name\s+=\s+'CosmaneuraScribeCapacitorSecureQueue'/u);
  assert.match(swiftPackage, /exact:\s+"8\.5\.0"/u);
  assert.match(swiftPackage, /name:\s+"CosmaneuraScribeCapacitorSecureQueue"/u);
  assert.match(
    swiftPackage,
    /\.product\(name:\s+"Cordova",\s+package:\s+"capacitor-swift-pm"\)/u,
  );
});

test("uses device-only keys, authenticated encryption, no-backup storage, and atomic writes", async () => {
  const ios = await source("../ios/Sources/CosmaneuraSecureQueue/SecureQueueStore.swift");
  const android = await source(
    "../android/src/main/java/com/cosmaneura/capture/securequeue/SecureQueueStore.java",
  );

  assert.match(ios, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/u);
  assert.match(ios, /isExcludedFromBackup\s*=\s*true/u);
  assert.match(ios, /AES\.GCM/u);
  assert.match(ios, /\.atomic/u);
  assert.match(android, /AndroidKeyStore/u);
  assert.match(android, /getNoBackupFilesDir/u);
  assert.match(android, /AES\/GCM\/NoPadding/u);
  assert.match(android, /AtomicFile/u);
  assert.match(android, /cipher\.init\(Cipher\.ENCRYPT_MODE, storageKey\)/u);
  assert.match(android, /nonce = cipher\.getIV\(\)/u);
  assert.doesNotMatch(
    android,
    /Cipher\.ENCRYPT_MODE, storageKey, new GCMParameterSpec/u,
  );
});

test("keeps the bridge narrow and contains no native logging calls", async () => {
  const capacitorConfig = await source("../../../capacitor.config.ts");
  const definitions = await source("../src/definitions.ts");
  const distributedIndex = await source("../dist/esm/index.d.ts");
  const distributedDefinitions = await source("../dist/esm/definitions.d.ts");
  const distributedJavaScript = await source("../dist/esm/index.js");
  const ios = await source("../ios/Sources/CosmaneuraSecureQueue/SecureQueuePlugin.swift");
  const android = await source(
    "../android/src/main/java/com/cosmaneura/capture/securequeue/SecureQueuePlugin.java",
  );

  for (const method of [
    "put",
    "create",
    "get",
    "list",
    "compareAndSwap",
    "delete",
    "clear",
  ]) {
    assert.match(definitions, new RegExp(`\\b${method}\\(`, "u"));
    assert.match(distributedDefinitions, new RegExp(`\\b${method}\\(`, "u"));
  }
  assert.match(distributedIndex, /from "\.\/definitions\.js"/u);
  assert.match(distributedJavaScript, /registerPlugin\("SecureQueue"\)/u);
  assert.match(capacitorConfig, /loggingBehavior:\s*"none"/u);
  assert.doesNotMatch(definitions, /storageKey|encryptionKey|secretKey/iu);
  assert.doesNotMatch(ios, /\b(?:NSLog|print)\s*\(/u);
  assert.doesNotMatch(android, /\bLog\s*\./u);
});

test("implements atomic create and compare-and-swap with fixed conflict codes", async () => {
  const iosStore = await source("../ios/Sources/CosmaneuraSecureQueue/SecureQueueStore.swift");
  const iosErrors = await source("../ios/Sources/CosmaneuraSecureQueue/SecureQueueError.swift");
  const androidStore = await source(
    "../android/src/main/java/com/cosmaneura/capture/securequeue/SecureQueueStore.java",
  );
  const androidErrors = await source(
    "../android/src/main/java/com/cosmaneura/capture/securequeue/SecureQueueException.java",
  );

  assert.match(iosStore, /operationLock\.lock\(\)/u);
  assert.match(iosStore, /func compareAndSwap\(/u);
  assert.match(androidStore, /synchronized long compareAndSwap\(/u);
  assert.match(iosErrors, /SECURE_QUEUE_ALREADY_EXISTS/u);
  assert.match(iosErrors, /SECURE_QUEUE_REVISION_CONFLICT/u);
  assert.match(androidErrors, /SECURE_QUEUE_ALREADY_EXISTS/u);
  assert.match(androidErrors, /SECURE_QUEUE_REVISION_CONFLICT/u);
});
