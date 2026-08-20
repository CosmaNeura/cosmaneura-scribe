import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(appRoot, "dist");
const files = await walk(distRoot);
const forbiddenNames = /(?:browser-microphone-source|pcm-capture-worklet)/u;
const forbiddenCode = /(?:getUserMedia|AudioWorkletNode)/u;

for (const file of files) {
  if (forbiddenNames.test(file)) {
    throw new Error("dormant preview bundle contains a microphone asset");
  }
  if (file.endsWith(".js") && forbiddenCode.test(await readFile(file, "utf8"))) {
    throw new Error("dormant preview bundle contains microphone runtime code");
  }
}

const staticConfig = await readFile(resolve(distRoot, "staticwebapp.config.json"), "utf8");
if (!staticConfig.includes("microphone=()") || staticConfig.includes("microphone=(self)")) {
  throw new Error("dormant preview bundle does not disable microphone permission");
}

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}
