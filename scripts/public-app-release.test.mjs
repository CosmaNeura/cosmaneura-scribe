import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installPublicMacPresentation,
  PUBLIC_DIRECT_BETA_MAC_NAME,
  PUBLIC_STORE_MAC_NAME,
  publicMacDisplayName,
  publicMacRelease,
} from "../apps/desktop-companion/src/public-app-release.ts";

const directRelease = {
  schema: 1, displayName: PUBLIC_DIRECT_BETA_MAC_NAME, marketingVersion: "1.0.0", build: "126", distribution: "Direct beta",
};
const storeRelease = {
  schema: 1, displayName: PUBLIC_STORE_MAC_NAME, marketingVersion: "1.0.0", build: "126", distribution: "Apple distribution",
};
const repo = dirname(dirname(fileURLToPath(import.meta.url)));

test("splits Store Cosmas Scribe from direct-beta Cosmaneura Scribe for Mac", async () => {
  assert.equal(PUBLIC_DIRECT_BETA_MAC_NAME, "Cosmaneura Scribe for Mac");
  assert.equal(PUBLIC_STORE_MAC_NAME, "Cosmas Scribe");
  assert.equal(/mac/i.test(PUBLIC_STORE_MAC_NAME), false);
  assert.equal(publicMacDisplayName("Direct beta"), PUBLIC_DIRECT_BETA_MAC_NAME);
  assert.equal(publicMacDisplayName("Apple distribution"), PUBLIC_STORE_MAC_NAME);
  const desktopRelease = JSON.parse(await readFile(join(repo, "apps/desktop-companion/desktop-release.json"), "utf8"));
  assert.equal(desktopRelease.displayName, PUBLIC_DIRECT_BETA_MAC_NAME);
  const html = await readFile(join(repo, "apps/desktop-companion/standalone/provider.html"), "utf8");
  assert.match(html, new RegExp(`<title>${PUBLIC_DIRECT_BETA_MAC_NAME}</title>`));
});

test("About distinguishes packaged environment from distribution", () => {
  assert.deepEqual(publicMacRelease(directRelease, "https://staging-app.cosmaneura.com", "Direct beta"), {
    displayName: PUBLIC_DIRECT_BETA_MAC_NAME, marketingVersion: "1.0.0", build: "126", distribution: "Direct beta",
    environment: "Staging", environmentMarker: "S",
  });
  const production = publicMacRelease(storeRelease, "https://app.cosmaneura.com", "Apple distribution");
  assert.equal(production.environment, "Production");
  assert.equal(production.environmentMarker, "P");
  assert.equal(production.displayName, PUBLIC_STORE_MAC_NAME);
});

test("About withholds unverifiable version or environment instead of labeling it production", () => {
  assert.equal(publicMacRelease(directRelease, "https://unknown.invalid", "Direct beta"), null);
  assert.equal(publicMacRelease(directRelease, "https://app.cosmaneura.com", "Apple distribution"), null);
  assert.equal(publicMacRelease({ ...directRelease, build: 126 }, "https://app.cosmaneura.com", "Direct beta"), null);
  assert.equal(publicMacRelease({ ...directRelease, internalIdentity: "must not be public" }, "https://app.cosmaneura.com", "Direct beta"), null);
  assert.equal(publicMacRelease({ ...directRelease, environmentMarker: "P" }, "https://staging-app.cosmaneura.com", "Direct beta"), null);
  assert.equal(publicMacRelease({ ...storeRelease, displayName: PUBLIC_DIRECT_BETA_MAC_NAME }, "https://app.cosmaneura.com", "Apple distribution"), null);
});

test("direct-beta About/menu keeps the legacy public name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scribe-public-release-test-"));
  try {
    await writeFile(join(directory, "release-metadata.json"), JSON.stringify(directRelease));
    await writeFile(join(directory, "provider-profile.json"), JSON.stringify({ coreOrigin: "https://staging-app.cosmaneura.com" }));
    let about, template;
    installPublicMacPresentation({ getAppPath: () => directory, whenReady: () => Promise.resolve(),
      setAboutPanelOptions: value => { about = value; },
      getName: () => { throw new Error("Internal identity must not be read or changed"); },
      setPath: () => { throw new Error("Account storage must not be changed"); } },
    { buildFromTemplate: value => value, setApplicationMenu: value => { template = value; } }, "Direct beta");
    await Promise.resolve();
    assert.deepEqual(about, { applicationName: PUBLIC_DIRECT_BETA_MAC_NAME, applicationVersion: "1.0.0",
      version: "Build 126 · Direct beta · Staging (S)" });
    assert.equal(template[0].label, PUBLIC_DIRECT_BETA_MAC_NAME);
    assert.equal(template[0].submenu.at(-1).role, "quit");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Store About/menu uses Cosmas Scribe without Mac", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scribe-public-store-release-test-"));
  try {
    await writeFile(join(directory, "release-metadata.json"), JSON.stringify(storeRelease));
    await writeFile(join(directory, "provider-profile.json"), JSON.stringify({ coreOrigin: "https://staging-app.cosmaneura.com" }));
    let about, template;
    installPublicMacPresentation({ getAppPath: () => directory, whenReady: () => Promise.resolve(),
      setAboutPanelOptions: value => { about = value; } },
    { buildFromTemplate: value => value, setApplicationMenu: value => { template = value; } }, "Apple distribution");
    await Promise.resolve();
    assert.equal(about.applicationName, PUBLIC_STORE_MAC_NAME);
    assert.equal(/mac/i.test(about.applicationName), false);
    assert.equal(template[0].label, PUBLIC_STORE_MAC_NAME);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const [coreOrigin, marker] of [
  ["https://staging-app.cosmaneura.com", "Staging (S)"],
  ["https://app.cosmaneura.com", "Production (P)"],
]) {
  for (const metadata of [directRelease, null, { ...directRelease, build: "unverified" }]) {
    test(`About retains ${marker} with ${metadata === directRelease ? "verified" : metadata ? "invalid" : "missing"} release metadata`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "scribe-public-marker-test-"));
      try {
        if (metadata) await writeFile(join(directory, "release-metadata.json"), JSON.stringify(metadata));
        await writeFile(join(directory, "provider-profile.json"), JSON.stringify({ coreOrigin }));
        let about;
        installPublicMacPresentation({ getAppPath: () => directory, whenReady: () => Promise.resolve(),
          setAboutPanelOptions: value => { about = value; } },
        { buildFromTemplate: value => value, setApplicationMenu: () => {} }, "Direct beta");
        await Promise.resolve();
        assert.equal(about.version, metadata === directRelease ? `Build 126 · Direct beta · ${marker}` : `Release details unavailable · ${marker}`);
        assert.equal(about.applicationVersion, metadata === directRelease ? "1.0.0" : undefined);
        assert.equal(about.applicationName, PUBLIC_DIRECT_BETA_MAC_NAME);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  }
}

test("About does not invent an environment when the sealed origin is unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scribe-public-marker-test-"));
  try {
    await writeFile(join(directory, "release-metadata.json"), JSON.stringify(directRelease));
    await writeFile(join(directory, "provider-profile.json"), JSON.stringify({ coreOrigin: "https://unknown.invalid", environmentMarker: "P" }));
    let about;
    installPublicMacPresentation({ getAppPath: () => directory, whenReady: () => Promise.resolve(),
      setAboutPanelOptions: value => { about = value; } },
    { buildFromTemplate: value => value, setApplicationMenu: () => {} }, "Direct beta");
    await Promise.resolve();
    assert.equal(about.version, "Release details unavailable");
    assert.equal(about.applicationVersion, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
