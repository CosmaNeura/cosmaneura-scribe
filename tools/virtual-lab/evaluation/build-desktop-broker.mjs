// Bundle the actual host with Vite's normal SSR handling of its presentation imports.
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

try {
  const output = process.argv[2];
  if (!output || !isAbsolute(output)) throw new Error("fresh_absolute_output_required");
  try { await access(output); throw new Error("output_exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const { build } = await import(pathUrl(resolve(repo, "node_modules/vite/dist/node/index.js")));
  await mkdir(output, { mode: 0o700 });
  await build({ configFile: false, root: repo, logLevel: "silent", ssr: { noExternal: true },
    build: { ssr: fileURLToPath(new URL("./desktop-broker.mjs", import.meta.url)), outDir: output,
      emptyOutDir: false, minify: false, sourcemap: false,
      rollupOptions: { output: { entryFileNames: "desktop-broker.mjs" } } } });
  const bytes = await readFile(resolve(output, "desktop-broker.mjs"));
  const report = { status: "desktop_broker_built", sha256: createHash("sha256").update(bytes).digest("hex"), live_services_run: false };
  await writeFile(resolve(output, "BUILD.json"), JSON.stringify(report) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(report));
} catch { console.log('{"status":"desktop_broker_build_failed"}'); process.exitCode = 1; }
function pathUrl(path) { return new URL(`file://${path}`).href; }
