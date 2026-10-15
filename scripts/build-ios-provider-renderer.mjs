// Package the existing iOS entry around one exact built provider library.
// No account configuration, native operation, installation or service access.
import { build } from "vite";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [output, option, providerDirectory] = process.argv.slice(2);
if (!output || option !== "--provider-dir" || !providerDirectory) {
  throw new Error("Usage: build-ios-provider-renderer.mjs NEW_OUTPUT --provider-dir BUILT_PROVIDER_DIR");
}
const destination = resolve(output), provider = resolve(providerDirectory);
const names = ["provider-capture.js", "provider-capture.css"];
const inputs = await Promise.all(names.map(name => readFile(join(provider, name))));
const hashes = Object.fromEntries(names.map((name, index) => [name, createHash("sha256").update(inputs[index]).digest("hex")]));
await mkdir(destination); // Exclusive output: never empty another build.
await build({
  configFile: join(repo, "apps/capture/standalone.vite.config.ts"),
  root: join(repo, "apps/capture/standalone"),
  build: { outDir: destination },
  plugins: [{ name: "verified-provider-library", enforce: "pre", resolveId(id) {
    if (id === "../src/provider/native-application") return { id: "./provider-capture.js", external: true };
  } }],
});
const assets = await readdir(join(destination, "assets"));
const workspace = assets.find(name => /^ios-workspace-.*\.js$/u.test(name));
if (!workspace || !(await readFile(join(destination, "assets", workspace), "utf8")).includes("./provider-capture.js")) {
  throw new Error("The existing iOS entry did not link the provider library");
}
for (const [index, name] of names.entries()) await writeFile(join(destination, "assets", name), inputs[index]);
const entry = join(destination, "index.html");
await writeFile(entry, (await readFile(entry, "utf8")).replace("</head>", '<link rel="stylesheet" href="./assets/provider-capture.css"></head>'));
await writeFile(join(destination, "provider-inputs.json"), JSON.stringify({
  schema: 1, provider_files_sha256: hashes, externalized_entry: "../src/provider/native-application", enabled: false,
}, null, 2) + "\n");
console.log(JSON.stringify({ renderer: destination, provider_files_sha256: hashes }));
