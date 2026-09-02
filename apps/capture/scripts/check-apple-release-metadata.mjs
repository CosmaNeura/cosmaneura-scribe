import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import capacitorConfig from "../capacitor.config.ts";

const EXPECTED_APP_ID = "com.cosmaneura.capture";
const EXPECTED_APP_NAME = "Cosmaneura Capture";
const EXPECTED_DEVELOPMENT_TEAM = "JVV65668U6";
const EXPECTED_MICROPHONE_USAGE =
  "Cosmaneura Capture uses the microphone to record a visit after you confirm the patient’s consent.";

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function plistString(plist, key) {
  const match = plist.match(
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "u"),
  );
  return match?.[1];
}

test("Capacitor keeps the approved native identity", () => {
  assert.equal(capacitorConfig.appId, EXPECTED_APP_ID);
  assert.equal(capacitorConfig.appName, EXPECTED_APP_NAME);
});

test("Xcode target identity matches the approved Apple team without a profile", () => {
  const project = read("ios/App/App.xcodeproj/project.pbxproj");
  const bundleIdentifiers = [
    ...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/gu),
  ].map((match) => match[1]);
  const infoPlistFiles = [
    ...project.matchAll(/\bINFOPLIST_FILE\s*=\s*([^;]+);/gu),
  ].map((match) => match[1]);
  const developmentTeams = [
    ...project.matchAll(/\bDEVELOPMENT_TEAM\s*=\s*([^;]+);/gu),
  ].map((match) => match[1]);
  const signingStyles = [
    ...project.matchAll(/\bCODE_SIGN_STYLE\s*=\s*([^;]+);/gu),
  ].map((match) => match[1]);
  const signingConfiguration = `${project}\n${read("ios/debug.xcconfig")}`;

  assert.deepEqual(bundleIdentifiers, [EXPECTED_APP_ID, EXPECTED_APP_ID]);
  assert.deepEqual(infoPlistFiles, ["App/Info.plist", "App/Info.plist"]);
  assert.deepEqual(developmentTeams, [
    EXPECTED_DEVELOPMENT_TEAM,
    EXPECTED_DEVELOPMENT_TEAM,
  ]);
  assert.deepEqual(signingStyles, ["Automatic", "Automatic"]);
  assert.doesNotMatch(project, /\bGENERATE_INFOPLIST_FILE\s*=\s*YES;/u);
  assert.doesNotMatch(project, /\bDevelopmentTeam\s*=/u);
  assert.doesNotMatch(
    signingConfiguration,
    /\bPROVISIONING_PROFILE(?:_SPECIFIER)?\s*=/u,
  );
  assert.doesNotMatch(signingConfiguration, /\bCODE_SIGN_STYLE\s*=\s*Manual;/u);
});

test("iOS declares accurate microphone permission copy and no camera permission", () => {
  const plist = read("ios/App/App/Info.plist");

  assert.equal(plistString(plist, "CFBundleIdentifier"), "$(PRODUCT_BUNDLE_IDENTIFIER)");
  assert.equal(plistString(plist, "CFBundleDisplayName"), EXPECTED_APP_NAME);
  assert.equal(
    plistString(plist, "NSMicrophoneUsageDescription"),
    EXPECTED_MICROPHONE_USAGE,
  );
  assert.doesNotMatch(plist, /<key>NSCameraUsageDescription<\/key>/u);
});
