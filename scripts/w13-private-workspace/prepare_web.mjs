import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repairBundle, sha256 } from "../w13-workspace-recovery/prepare.mjs";

const [root] = process.argv.slice(2);
if (!root) throw new Error("Usage: prepare_web.mjs owned-runtime-directory");
const entry = join(root, "iphone-source/apps/capture/ios/App/App/public/assets/index-BOeSnvhj.js");
const original = await readFile(entry);
const corrected = await repairBundle(original, { privateCatalog: true });
await writeFile(entry, corrected);
await writeFile(join(root, "web-correction.json"), JSON.stringify({
  input_sha256: sha256(original), output_sha256: sha256(corrected),
  catalog_transport: "native fixed private HTTPS endpoint; token retained by native bridge",
  native_catalog_enabled: true, other_operations_enabled: false,
}, null, 2) + "\n", { flag: "wx" });
console.log("Prepared the existing W13 encounter UI with the fixed native catalog transport.");
