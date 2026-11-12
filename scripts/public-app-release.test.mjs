import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installPublicMacPresentation, PUBLIC_MAC_NAME, publicMacRelease } from "../apps/desktop-companion/src/public-app-release.ts";

const release = { schema: 1, displayName: "Cosmas Scribe", marketingVersion: "1.0.0", build: "126", distribution: "Direct beta" };
const repo = dirname(dirname(fileURLToPath(import.meta.url)));

test("public Mac display name is Cosmas Scribe and never contains Mac", async () => {
  assert.equal(PUBLIC_MAC_NAME, "Cosmas Scribe");
  assert.equal(/mac/i.test(PUBLIC_MAC_NAME), false);
  const desktopRelease = JSON.parse(await readFile(join(repo, "apps/desktop-companion/desktop-release.json"), "utf8"));
  assert.equal(desktopRelease.displayName, PUBLIC_MAC_NAME);
  assert.equal(/mac/i.test(desktopRelease.displayName), false);
  const html = await readFile(join(repo, "apps/desktop-companion/standalone/provider.html"), "utf8");
  assert.match(html, /<title>Cosmas Scribe<\/title>/);
  assert.equal(/for Mac|Scribe for Mac/i.test(html), false);
});

test("About distinguishes packaged environment from distribution", () => {
  assert.deepEqual(publicMacRelease(release, "https://staging-app.cosmaneura.com", "Direct beta"), {
    displayName: release.displayName, marketingVersion: "1.0.0", build: "126", distribution: "Direct beta", environment: "Staging", environmentMarker: "S",
  });
  const production = publicMacRelease({ ...release, distribution: "Apple distribution" }, "https://app.cosmaneura.com", "Apple distribution");
  assert.equal(production.environment, "Production");
  assert.equal(production.environmentMarker, "P");
});

test("About withholds unverifiable version or environment instead of labeling it production", () => {
  assert.equal(publicMacRelease(release, "https://unknown.invalid", "Direct beta"), null);
  assert.equal(publicMacRelease(release, "https://app.cosmaneura.com", "Apple distribution"), null);
  assert.equal(publicMacRelease({ ...release, build: 126 }, "https://app.cosmaneura.com", "Direct beta"), null);
  assert.equal(publicMacRelease({ ...release, internalIdentity: "must not be public" }, "https://app.cosmaneura.com", "Direct beta"), null);
  assert.equal(publicMacRelease({ ...release, environmentMarker: "P" }, "https://staging-app.cosmaneura.com", "Direct beta"), null);
});

test("public About/menu uses the packaged release without changing internal identity or storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scribe-public-release-test-"));
  try {
    await writeFile(join(directory, "release-metadata.json"), JSON.stringify(release));
    await writeFile(join(directory, "provider-profile.json"), JSON.stringify({ coreOrigin: "https://staging-app.cosmaneura.com" }));
    let about, template;
    installPublicMacPresentation({ getAppPath: () => directory, whenReady: () => Promise.resolve(),
      setAboutPanelOptions: value => { about = value; },
      getName: () => { throw new Error("Internal identity must not be read or changed"); },
      setPath: () => { throw new Error("Account storage must not be changed"); } },
    { buildFromTemplate: value => value, setApplicationMenu: value => { template = value; } }, "Direct beta");
    await Promise.resolve();
    assert.deepEqual(about, { applicationName: "Cosmas Scribe", applicationVersion: "1.0.0",
      version: "Build 126 · Direct beta · Staging (S)" });
    assert.equal(template[0].label, "Cosmas Scribe");
    assert.equal(/mac/i.test(template[0].label), false);
    assert.equal(template[0].submenu.at(-1).role, "quit");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const [coreOrigin, marker] of [
  ["https://staging-app.cosmaneura.com", "Staging (S)"],
  ["https://app.cosmaneura.com", "Production (P)"],
]) {
  for (const metadata of [release, null, { ...release, build: "unverified" }]) {
    test(`About retains ${marker} with ${metadata === release ? "verified" : metadata ? "invalid" : "missing"} release metadata`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "scribe-public-marker-test-"));
      try {
        if (metadata) await writeFile(join(directory, "release-metadata.json"), JSON.stringify(metadata));
        await writeFile(join(directory, "provider-profile.json"), JSON.stringify({ coreOrigin }));
        let about;
        installPublicMacPresentation({ getAppPath: () => directory, whenReady: () => Promise.resolve(),
          setAboutPanelOptions: value => { about = value; } },
        { buildFromTemplate: value => value, setApplicationMenu: () => {} }, "Direct beta");
        await Promise.resolve();
        assert.equal(about.version, metadata === release ? `Build 126 · Direct beta · ${marker}` : `Release details unavailable · ${marker}`);
        assert.equal(about.applicationVersion, metadata === release ? "1.0.0" : undefined);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  }
}

test("About does not invent an environment when the sealed origin is unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scribe-public-marker-test-"));
  try {
    await writeFile(join(directory, "release-metadata.json"), JSON.stringify(release));
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
