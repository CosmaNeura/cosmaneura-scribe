// Build main/preload and the packaged UI using existing repository tooling.
// Includes the native/backend factory. It does not sign, launch, or write to an existing app/data directory.
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const [providerInput, outputInput] = process.argv.slice(2);
if (process.argv.length !== 4 || !providerInput || !outputInput) throw new Error("Usage: build-desktop-provider-host.mjs provider-build-directory new-output-directory");
const repo = dirname(dirname(fileURLToPath(import.meta.url))), input = await realpath(providerInput), output = resolve(outputInput);
await mkdir(output); // Refuse an existing package; never overwrite a prior app.
const renderer = join(output, "renderer"), standalone = join(repo, "apps/desktop-companion/standalone");
await mkdir(renderer);
const hash = value => createHash("sha256").update(value).digest("hex"), files = {};
for (const name of ["provider.html", "desktop-start.js", "provider-capture.js", "provider-capture.css"]) {
  const source = join(name.startsWith("provider-capture") ? input : standalone, name), info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error("Invalid renderer build input");
  const bytes = await readFile(source); await writeFile(join(renderer, name), bytes); files[name] = hash(bytes);
}
const icon = await readFile(join(standalone, "Scribe.icns"));
await writeFile(join(output, "Scribe.icns"), icon);
await writeFile(join(renderer, "renderer-manifest.json"), JSON.stringify({ schema: 1, files }, null, 2) + "\n");
const main = await build({ absWorkingDir: repo, entryPoints: [join(standalone, "main.mjs")], bundle: true, platform: "node", target: "node24",
  format: "cjs", outfile: join(output, "main.cjs"), external: ["electron", "./provider-host.mjs"], metafile: true, logLevel: "silent" });
const preload = await build({ absWorkingDir: repo, entryPoints: [join(standalone, "preload.mjs")], bundle: true, platform: "node", target: "node24",
  format: "cjs", outfile: join(output, "preload.cjs"), external: ["electron"], metafile: true, logLevel: "silent" });
const factory = await build({ absWorkingDir: repo, entryPoints: [join(standalone, "provider-host.mjs")], bundle: true,
  platform: "node", target: "node24", format: "esm", outfile: join(output, "provider-host.mjs"),
  external: ["electron"], metafile: true, logLevel: "silent" });
const imports = Object.values(preload.metafile.outputs).flatMap(value => value.imports);
if (imports.length !== 1 || imports[0].path !== "electron" || !imports[0].external) throw new Error("Preload has an unexpected runtime dependency");
await writeFile(join(output, "package.json"), JSON.stringify({ name: "cosmaneura-scribe-beta", productName: "Cosmaneura Scribe Beta",
  version: "0.1.0", private: true, main: "main.cjs", type: "commonjs" }, null, 2) + "\n");
const sourceFiles = [...new Set([...Object.keys(main.metafile.inputs), ...Object.keys(preload.metafile.inputs), ...Object.keys(factory.metafile.inputs)])].sort();
const sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, hash(await readFile(join(repo, name)))])));
const artifacts = {};
for (const name of ["main.cjs", "preload.cjs", "provider-host.mjs", "package.json", "Scribe.icns", "renderer/renderer-manifest.json", ...Object.keys(files).map(name => "renderer/" + name)]) {
  artifacts[name] = hash(await readFile(join(output, name)));
}
await writeFile(join(output, "host-build.json"), JSON.stringify({ schema: 1, proposed_electron_version: "44.4.3", source_sha256: sourceSha256,
  artifacts_sha256: artifacts, preload_external_imports: ["electron"], installed: false, signed: false, launch_ready: false,
  missing: ["reviewed package profile and native helper bundles", "staging qualification", "signed app packaging"] }, null, 2) + "\n");
process.stdout.write(JSON.stringify({ output, artifacts: Object.keys(artifacts).length, provider_factory_bundled: true, runtime_installed: false, launched: false }) + "\n");
