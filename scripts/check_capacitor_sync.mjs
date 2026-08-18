import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const supportedPlatforms = new Set(["android", "ios"]);
const platform = process.argv[2];

if (!supportedPlatforms.has(platform)) {
  console.error("usage: node scripts/check_capacitor_sync.mjs <android|ios>");
  process.exit(2);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout ?? "";
}

function repositoryStatus() {
  return run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { capture: true },
  ).trim();
}

run("npm", ["run", "build"]);

const before = repositoryStatus();
if (before !== "") {
  console.error(`The repository must be clean before the sync check:\n${before}`);
  process.exit(1);
}

run("npm", [
  "run",
  `cap:sync:${platform}`,
  "--workspace",
  "@cosmaneura-scribe/capture",
]);

const generatedConfigPath =
  platform === "android"
    ? "apps/capture/android/app/src/main/assets/capacitor.config.json"
    : "apps/capture/ios/App/App/capacitor.config.json";
const generatedConfig = JSON.parse(readFileSync(generatedConfigPath, "utf8"));
if (generatedConfig.loggingBehavior !== "none") {
  console.error(`Capacitor ${platform} generated config permits bridge logging.`);
  process.exit(1);
}

const after = repositoryStatus();
if (after !== "") {
  console.error(`Capacitor ${platform} sync changed the repository:\n${after}`);
  process.exit(1);
}

console.log(`Capacitor ${platform} sync is reproducible.`);
