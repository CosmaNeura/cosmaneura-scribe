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

test("isolates iOS Keychain integration tests in a simulator-only host", async () => {
  const hostedProject = await source(
    "../ios/Tests/SecureQueueHostedTests.xcodeproj/project.pbxproj",
  );
  const hostedEntitlements = await source(
    "../ios/Tests/SecureQueueTestHost/SecureQueueTestHost.entitlements",
  );
  const productionProject = await source("../../../ios/App/App.xcodeproj/project.pbxproj");
  const productionPackage = await source("../../../ios/App/CapApp-SPM/Package.swift");
  const swiftPackage = await source("../Package.swift");

  assert.match(hostedProject, /name = SecureQueueTestHost;/u);
  assert.match(hostedProject, /SUPPORTED_PLATFORMS = iphonesimulator;/u);
  assert.match(hostedProject, /SKIP_INSTALL = YES;/u);
  assert.match(hostedProject, /BUNDLE_LOADER = "\$\(TEST_HOST\)";/u);
  assert.match(
    hostedProject,
    /CODE_SIGN_ENTITLEMENTS = SecureQueueTestHost\/SecureQueueTestHost\.entitlements;/u,
  );
  assert.match(hostedEntitlements, /<key>keychain-access-groups<\/key>/u);
  assert.doesNotMatch(hostedEntitlements, /\*/u);
  assert.doesNotMatch(productionProject, /SecureQueue(?:TestHost|HostedTests)/u);
  assert.doesNotMatch(productionPackage, /SecureQueue(?:TestHost|HostedTests)/u);
  assert.doesNotMatch(swiftPackage, /\.testTarget\(/u);
  assert.match(swiftPackage, /targets:\s*\["CosmaneuraSecureQueue"\]/u);
});

test("runs native secure-storage behavior on hosted emulators", async () => {
  const workflow = await source("../../../../../.github/workflows/ci.yml");
  const gradleWrapper = await source(
    "../../../android/gradle/wrapper/gradle-wrapper.properties",
  );

  assert.match(workflow, /Test iOS secure queue/u);
  assert.match(workflow, /Test Android secure queue on API 36/u);
  assert.match(workflow, /system-images;android-36;google_apis;x86_64/u);
  assert.match(workflow, /connectedDebugAndroidTest/u);
  assert.match(workflow, /\/dev\/kvm/u);
  assert.match(workflow, /-no-metrics/u);
  assert.match(workflow, /-partition-size 2048/u);
  assert.match(workflow, /export ANDROID_AVD_HOME="\$\{avd_home\}"/u);
  assert.match(workflow, /ANDROID_AVD_HOME.*avd_name.*\.ini/u);
  assert.match(workflow, /timeout 180s "\$\{adb_path\}" wait-for-device/u);
  assert.doesNotMatch(workflow, /android-emulator-runner/u);
  assert.match(
    gradleWrapper,
    /distributionSha256Sum=ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c/u,
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
