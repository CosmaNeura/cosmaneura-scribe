import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const options = { output: "", profile: "all", model: "modern-clean", preparation: "combined", continuation: "combined", runs: 1 };
for (let index = 0; index < args.length; index += 2) {
  const option = args[index], value = args[index + 1];
  if (!value) throw new Error("Expected --output PATH [--profile NAME] [--runs 1-5]");
  if (option === "--output") options.output = resolve(value);
  else if (option === "--profile") options.profile = value;
  else if (option === "--model") options.model = value;
  else if (option === "--preparation") options.preparation = value;
  else if (option === "--continuation") options.continuation = value;
  else if (option === "--runs") options.runs = Number(value);
  else throw new Error("Unknown benchmark option");
}
const profiles = ["local-zero-delay", "moderate-dependencies", "slow-dependencies"];
const models = ["modern-clean", "modern-interrupted", "legacy-clean", "dependency-sensitivity"];
if (!options.output || !["all", ...profiles].includes(options.profile)
  || !models.includes(options.model)
  || !["combined", "legacy"].includes(options.preparation)
  || !["combined", "legacy"].includes(options.continuation)
  || !Number.isInteger(options.runs) || options.runs < 1 || options.runs > 5
  || Number(process.versions.node.split(".")[0]) !== 24) {
  throw new Error("Node 24, --output PATH, a known --profile/--model and --runs 1-5 are required.");
}
// A new directory prevents accidental replacement of earlier measurements.
await mkdir(options.output, { mode: 0o700 });
const inputs = ["src/provider-recorder.ts", "src/controller.ts", "src/pcm-capture-source.ts",
  "src/native-process-driver.ts", "src/native-pcm-driver.ts",
  "../capture/src/native/native-pcm-source.ts", "../capture/src/native/native-pcm-bridge.ts",
  "native/ScribeDesktopAudio/Sources/ScribeDesktopAudio/MacMeetingAudio.swift",
  "src/durable-record-store.ts", "src/durable-flow-store.ts", "src/provider-recorder-ipc.ts",
  "../capture/src/flow/controller.ts", "../capture/src/flow/types.ts", "../capture/src/flow/encrypted-store.ts",
  "../capture/src/bff/contracts.ts", "../capture/src/provider/desktop-recorder-view.ts",
  "src/native-provider-backend.ts", "../../scripts/standalone-provider/NativeSourceStartOwner.swift",
  "test-tools/desktop-readiness-native-model.mjs", "test-tools/desktop-readiness-native-model.test.mjs",
  "test-tools/desktop-readiness-benchmark.mjs", "test-tools/desktop-readiness.benchmark.mjs", "test-tools/readiness.vitest.config.mjs", "../../package-lock.json"];
const hashes = {};
for (const file of inputs) hashes[file] = createHash("sha256").update(await readFile(join(workspace, file))).digest("hex");
let sourceCommit = null, sourceDirty = null;
try {
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: workspace, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  if (resolve(top) !== resolve(workspace, "../..")) throw new Error("Isolated source copy");
  sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  sourceDirty = execFileSync("git", ["status", "--porcelain"], { cwd: workspace, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() !== "";
} catch { /* An isolated copy is still identified by its exact input hashes. */ }
const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const command = [vitest, "run", "--config", "test-tools/readiness.vitest.config.mjs"];
const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "scribe-readiness-")));
const ownProcessGroup = process.platform !== "win32";
const child = spawn(process.execPath, command, { cwd: workspace, detached: ownProcessGroup, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, SCRIBE_DESKTOP_TIMING_OUTPUT: options.output, SCRIBE_DESKTOP_TIMING_TEMP_ROOT: temporaryRoot,
    SCRIBE_DESKTOP_TIMING_PROFILE: options.profile, SCRIBE_DESKTOP_TIMING_MODEL: options.model,
    SCRIBE_DESKTOP_TIMING_PREPARATION: options.preparation,
    SCRIBE_DESKTOP_TIMING_CONTINUATION: options.continuation,
    SCRIBE_DESKTOP_TIMING_RUNS: String(options.runs) } });
let log = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { log += String(chunk); });
const terminate = signal => {
  if (ownProcessGroup && child.pid) {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  } else child.kill(signal);
};
let forceStop;
const timeout = setTimeout(() => {
  terminate("SIGTERM"); forceStop = setTimeout(() => terminate("SIGKILL"), 2000);
}, options.runs * (options.profile === "all" ? 3 : 1) * 45000 + 10000);
let exit;
try {
  exit = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
} finally {
  clearTimeout(timeout); clearTimeout(forceStop);
  await rm(temporaryRoot, { recursive: true, force: true });
}
await writeFile(join(options.output, "benchmark.log"), log);
const observations = [];
for (const name of (await readdir(options.output)).filter(name => profiles.some(profile => name.startsWith(profile + "-run-")) && name.endsWith(".json"))) {
  const value = JSON.parse(await readFile(join(options.output, name), "utf8"));
  observations.push({ file: name, model: value.model, preparation: value.preparation, continuation: value.continuation,
    profile: value.profile, assertions: value.assertions, actions: value.actions });
}
const finalHashes = {}, changedInputs = [];
for (const file of inputs) {
  try { finalHashes[file] = createHash("sha256").update(await readFile(join(workspace, file))).digest("hex"); }
  catch { finalHashes[file] = null; }
  if (finalHashes[file] !== hashes[file]) changedInputs.push(file);
}
const success = exit.code === 0 && changedInputs.length === 0;
const receipt = { schema: 6, source_commit: sourceCommit, source_dirty: sourceDirty, input_sha256: hashes,
  final_input_sha256: finalHashes, changed_inputs: changedInputs, success,
  command: [process.execPath, ...command], options, exit, observations,
  scope: "Selected model with real controller/flow/encrypted temporary SQLite/cloned IPC and loopback mock BFF. Modern/legacy modes use the real backend with simulated Swift owner/HTTP; dependency-sensitivity retains the historical per-callback delays. No microphone/native helper/installed app/DOM paint.",
  cold_definition: "First recorder preparation in a fresh temporary store; excludes Node/Electron app startup and fixture consent setup." };
await writeFile(join(options.output, "RESULT.json"), JSON.stringify(receipt, null, 2) + "\n");
process.stdout.write(JSON.stringify({ output: options.output, success, exit, changed_inputs: changedInputs, observations }, null, 2) + "\n");
if (!success) process.exitCode = 1;
