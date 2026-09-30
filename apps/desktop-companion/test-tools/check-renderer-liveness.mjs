import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
if (require("electron/package.json").version !== "44.4.3") throw new Error("Pinned Electron 44.4.3 is required.");
const directory = await mkdtemp(join(tmpdir(), "scribe-renderer-liveness-"));
const source = fileURLToPath(new URL("renderer-liveness.electron.mjs", import.meta.url));
try {
  const bundle = join(directory, "main.mjs");
  await build({ entryPoints: [source], outfile: bundle, bundle: true, format: "esm", platform: "node", external: ["electron"] });
  const environment = { ...process.env, SCRIBE_LIVENESS_TEST_DIR: join(directory, "profile") };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [bundle], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 20000);
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  clearTimeout(deadline);
  if (code !== 0) throw new Error(`Virtual Electron test failed (${code}): ${stderr}`);
  const result = JSON.parse(stdout.trim());
  result.source_sha256 = createHash("sha256").update(await readFile(source)).digest("hex");
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
