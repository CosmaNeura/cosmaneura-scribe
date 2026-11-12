#!/usr/bin/env node
/**
 * CI-only macOS proof: sandboxed Store Release launch with Apple-style
 * entitlements reaches the first screen without the Store launch error.
 *
 * Hard stops: no Apple Distribution / MAS / Developer ID signing, no
 * App Store Connect, no TestFlight. Synthetic fixtures only.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "darwin") {
  console.error("This check runs only on GitHub Actions macOS runners.");
  process.exit(1);
}

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const env = {
  ...process.env,
  SCRIBE_CI_STORE_SANDBOXED_LAUNCH: "1",
  CI: "true",
};

const appleStyle = {
  "com.apple.security.app-sandbox": true,
  "com.apple.security.application-groups": [
    "[REDACTED].com.cosmaneura.scribe.beta.desktop.store",
  ],
  "com.apple.application-identifier":
    "[REDACTED].com.cosmaneura.scribe.beta.desktop.store",
  "com.apple.developer.team-identifier": "[REDACTED]",
  "com.apple.security.network.client": true,
  "beta-reports-active": true,
  "get-task-allow": false,
};

const scratch = mkdtempSync(join(tmpdir(), "scribe-ci-apple-ents-"));
const entitlementsPath = join(scratch, "apple-style-parent.entitlements.plist");
try {
  const jsonPath = join(scratch, "apple-style-parent.json");
  writeFileSync(jsonPath, JSON.stringify(appleStyle));
  const converted = spawnSync(
    "plutil",
    ["-convert", "xml1", jsonPath, "-o", entitlementsPath],
    { encoding: "utf8" },
  );
  if (converted.status !== 0) {
    console.error(converted.stderr || converted.stdout || "plutil failed");
    process.exit(converted.status ?? 1);
  }
  console.log(`Apple-style entitlement fixture: ${entitlementsPath}`);

  const vitest = spawnSync(
    process.execPath,
    [
      join(repo, "node_modules/vitest/vitest.mjs"),
      "run",
      "src/store-sandboxed-release-launch.ci.test.ts",
      "src/store-launch-recovery.test.ts",
    ],
    {
      cwd: join(repo, "apps/desktop-companion"),
      env: {
        ...env,
        SCRIBE_CI_APPLE_STYLE_ENTITLEMENTS_PATH: entitlementsPath,
      },
      stdio: "inherit",
    },
  );
  if (vitest.status !== 0) process.exit(vitest.status ?? 1);

  const firstScreen = spawnSync(
    process.execPath,
    [
      join(repo, "node_modules/vitest/vitest.mjs"),
      "run",
      "src/provider/application-first-launch.test.ts",
    ],
    {
      cwd: join(repo, "apps/capture"),
      env,
      stdio: "inherit",
    },
  );
  if (firstScreen.status !== 0) process.exit(firstScreen.status ?? 1);

  // Native Release XCTest for the whole ScribeDesktopAudio package is out of
  // scope here: SPM still typechecks unrelated suites (e.g. AlignedMeetingPCM)
  // under -c release. Apple-style entitlement claims are stamped above and
  // asserted in the Store entry vitest; get-task-allow=false tolerance remains
  // sibling #553.

  console.log(
    "CI sandboxed Release Store launch reached first screen without the launch error.",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
