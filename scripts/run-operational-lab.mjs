import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [destination, repetitions = "3", ...extra] = process.argv.slice(2);
if (!destination || extra.length || !/^(?:[1-9]|10)$/u.test(repetitions)) {
  throw new Error("Usage: node scripts/run-operational-lab.mjs NEW_OUTPUT_DIRECTORY [1-10 trials]");
}
if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Node 24 is required");
const npm = spawnSync("npm", ["--version"], { encoding: "utf8" });
if (npm.status !== 0 || npm.stdout.trim() !== "11.5.2") throw new Error("npm 11.5.2 is required on PATH");
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error("source_inventory_failed");
  return result.stdout.trim();
};
const commit = git("rev-parse", "HEAD"), dirty = git("status", "--porcelain") !== "";
if (dirty) throw new Error("Commit the intended test inputs first; operational evidence requires a clean source tree");
const output = resolve(destination);
mkdirSync(output, { mode: 0o700 }); // Existing evidence must never be overwritten.
const packageFile = resolve(repo, "apps/capture/e2e/package-lock.json");
const manifest = {
  schema_version: 1, source_commit: commit, source_dirty: dirty,
  dependency_lock_sha256: createHash("sha256").update(readFileSync(packageFile)).digest("hex"),
  node: process.versions.node, npm: "11.5.2", requested_trials: Number(repetitions),
  scope: "local synthetic browser capture, note save/recovery and accessibility; not staging/device acceptance",
  trials: [], passed: false,
};
const receipt = () => writeFileSync(resolve(output, "RESULT.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
receipt();
for (let trial = 1; trial <= Number(repetitions); trial++) {
  const report = resolve(output, `trial-${trial}.json`);
  const result = spawnSync(process.execPath, [
    "apps/capture/e2e/node_modules/@playwright/test/cli.js", "test",
    "--config", "apps/capture/e2e/playwright.config.mjs", "--reporter",
    "./apps/capture/e2e/support/timing-reporter.mjs",
  ], { cwd: repo, stdio: "inherit", env: { ...process.env, SCRIBE_TIMING_REPORT: report, SCRIBE_TEST_COMMIT: commit } });
  let evidence;
  try { evidence = JSON.parse(readFileSync(report, "utf8")); } catch { /* Missing evidence fails closed. */ }
  const passed = result.status === 0 && evidence?.status === "passed" && evidence.global_error_count === 0
    && evidence.expected_tests > 0 && evidence.tests.length === evidence.expected_tests
    && evidence.tests.every(test => test.status === "passed" && test.retry === 0);
  manifest.trials.push({ trial, exit_code: result.status, passed, report: `trial-${trial}.json` });
  receipt();
  if (!passed) break; // Preserve the failed trial. Do not retry until green.
}
manifest.source_changed_during_run = git("rev-parse", "HEAD") !== commit || git("status", "--porcelain") !== "";
manifest.passed = manifest.trials.length === Number(repetitions)
  && manifest.trials.every(trial => trial.passed) && !manifest.source_changed_during_run;
receipt();
process.exitCode = manifest.passed ? 0 : 1;
