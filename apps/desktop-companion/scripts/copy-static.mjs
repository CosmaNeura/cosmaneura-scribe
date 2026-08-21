import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(packageRoot, "dist");

await rm(resolve(output, "renderer"), { recursive: true, force: true });
await mkdir(resolve(output, "renderer"), { recursive: true });
await cp(resolve(packageRoot, "static", "renderer"), resolve(output, "renderer"), {
  recursive: true,
});
await cp(
  resolve(packageRoot, "static", "preload.cjs"),
  resolve(output, "preload.cjs"),
);
