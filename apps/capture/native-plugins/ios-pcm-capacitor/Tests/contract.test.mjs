import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

test("pins one exact JavaScript and Swift Capacitor boundary", async () => {
  const manifest = JSON.parse(await source("../package.json"));
  const swiftPackage = await source("../Package.swift");

  assert.equal(manifest.peerDependencies["@capacitor/core"], "8.5.0");
  assert.equal(manifest.peerDependencies["@capacitor/ios"], "8.5.0");
  assert.match(swiftPackage, /exact:\s+"8\.5\.0"/u);
  assert.match(swiftPackage, /\.package\(path:\s+"\.\.\/ios-pcm-capture"\)/u);
});

test("links the wrapper while keeping app selection explicitly false by default", async () => {
  const captureManifest = await source("../../../package.json");
  const appPackage = await source("../../../ios/App/CapApp-SPM/Package.swift");
  const nativeFactory = await source("../../../src/capture-source-factory.ts");

  assert.match(captureManifest, /@cosmaneura-scribe\/capacitor-ios-pcm/u);
  assert.match(appPackage, /CosmaneuraScribeCapacitorIosPcm/u);
  assert.match(nativeFactory, /VITE_CAPTURE_IOS_NATIVE_PCM_ENABLED/u);
  assert.match(nativeFactory, /IOS_NATIVE_PCM_CAPTURE_ENABLED/u);
  assert.match(nativeFactory, /import\("@capacitor\/core"\)/u);
  assert.doesNotMatch(nativeFactory, /^import .* from "@capacitor\/core";/mu);
});

test("exposes only the bounded reviewed method and event surface", async () => {
  const plugin = await source(
    "../Sources/CosmaneuraIOSPCMCapacitor/IOSPCMCapacitorPlugin.swift",
  );
  const definitions = await source("../src/definitions.ts");

  for (const method of [
    "getAppState",
    "start",
    "ready",
    "heartbeat",
    "stop",
    "acknowledge",
    "replayPendingPacket",
  ]) {
    assert.match(plugin, new RegExp(`CAPPluginMethod\\(name: "${method}"`, "u"));
    assert.match(definitions, new RegExp(`\\b${method}\\(`, "u"));
  }
  assert.match(plugin, /jsName = "IOSPCM"/u);
  assert.match(plugin, /"iosNativePcmEvent"/u);
  assert.doesNotMatch(plugin, /\b(?:print|debugPrint|NSLog|os_log)\s*\(/u);
});

test("documents immutable transport copies and physical-device gates", async () => {
  const readme = await source("../README.md");
  assert.match(readme, /Swift `String`/u);
  assert.match(readme, /JavaScript strings/u);
  assert.match(readme, /WebKit message copies/u);
  assert.match(readme, /physical\s+device/u);
  assert.match(readme, /non-PHI TestFlight canary/u);
});

test("the live driver treats inactive application state as foreground loss", async () => {
  const liveSystem = await source(
    "../../ios-pcm-capture/Sources/CosmaneuraIOSAVFoundationDriver/LiveAVFoundationSystem.swift",
  );
  const driver = await source(
    "../../ios-pcm-capture/Sources/CosmaneuraIOSAVFoundationDriver/AVFoundationPCMDriver.swift",
  );

  assert.match(liveSystem, /UIApplication\.willResignActiveNotification/u);
  assert.match(liveSystem, /emit\(\.backgrounded\)/u);
  assert.match(driver, /case \.backgrounded: \.backgrounded/u);
});

test("the app adapter has no payload, token, or native-detail logging surface", async () => {
  const adapter = await source("../../../src/native/capacitor-ios-native-pcm-bridge.ts");
  assert.doesNotMatch(adapter, /\b(?:console\.|print\s*\(|debugPrint\s*\(|NSLog\s*\(|os_log\s*\()/u);
  assert.doesNotMatch(adapter, /throw\s+error\b/u);
  assert.match(adapter, /clearIosPcmBytes/u);
  assert.match(adapter, /finally/u);
});
