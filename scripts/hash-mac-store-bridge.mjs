// Local packaging admission only. Never launches, signs or modifies the bridge.
import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { STORE_BRIDGE_HASH_ALGORITHM, storeBridgeMachoSha256 } from "../apps/desktop-companion/src/store-bridge-macho-hash.ts";

const [path] = process.argv.slice(2);
if (process.argv.length !== 3 || !path || !isAbsolute(path) || await realpath(path) !== path) throw new Error("An exact built Store bridge is required");
const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
let bytes;
try {
  const before = await file.stat();
  if (!before.isFile() || before.size < 32 || before.size > 134_217_728) throw new Error("Invalid Store bridge file");
  bytes = await file.readFile();
  const sha256 = storeBridgeMachoSha256(bytes), after = await lstat(path);
  if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino
    || after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size) throw new Error("Store bridge changed");
  process.stdout.write(JSON.stringify({ path: "Contents/MacOS/ScribeStorePipeBridge", sha256,
    hashAlgorithm: STORE_BRIDGE_HASH_ALGORITHM }) + "\n");
} finally { bytes?.fill(0); await file.close(); }
