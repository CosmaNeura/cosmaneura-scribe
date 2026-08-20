import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(packageRoot, "dist-package");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  entryPoints: [resolve(packageRoot, "src/index.ts")],
  outfile: resolve(output, "index.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  treeShaking: true,
  external: ["@azure/functions"],
  banner: {
    js: 'import { createRequire as __captureCreateRequire } from "node:module"; const require = __captureCreateRequire(import.meta.url);',
  },
});
await cp(resolve(packageRoot, "host.json"), resolve(output, "host.json"));
for (const dependency of ["@azure/functions", "@azure/functions-extensions-base", "cookie"]) {
  await cp(
    resolve(packageRoot, "../../node_modules", dependency),
    resolve(output, "node_modules", dependency),
    { recursive: true },
  );
}
await writeFile(
  resolve(output, "package.json"),
  `${JSON.stringify(
    {
      name: "cosmaneura-capture-preview-function",
      version: "0.1.0",
      private: true,
      type: "module",
      main: "index.js",
      engines: { node: ">=24.0.0 <25" },
      dependencies: { "@azure/functions": "4.16.2" },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
