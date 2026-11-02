import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { storeBridgeMachoSha256 } from "../apps/desktop-companion/src/store-bridge-macho-hash.ts";

// The retained submitted/TestFlight bridge witnesses contain no accounts/audio.
// CI can omit these owned artifacts; no product or fixture executable is run.
const submitted = process.env.SCRIBE_STORE_SUBMITTED_BRIDGE;
const distributed = process.env.SCRIBE_STORE_DISTRIBUTED_BRIDGE;
const witness = submitted && distributed ? {
  submitted: await readFile(submitted), distributed: await readFile(distributed),
} : null;
const skip = witness === null;
test("actual Apple signature changes preserve the complete executable content digest", { skip }, () => {
  assert.notEqual(createHash("sha256").update(witness.submitted).digest("hex"),
    createHash("sha256").update(witness.distributed).digest("hex"));
  assert.equal(storeBridgeMachoSha256(witness.submitted), storeBridgeMachoSha256(witness.distributed));
});
test("one actual executable code-byte change cannot be concealed by signature normalization", { skip }, () => {
  const changed = Buffer.from(witness.distributed); changed[16_384] ^= 1;
  assert.notEqual(storeBridgeMachoSha256(changed), storeBridgeMachoSha256(witness.submitted));
});
test("load-command policy bytes remain included", { skip }, () => {
  const changed = Buffer.from(witness.distributed); changed[24] ^= 1;
  assert.notEqual(storeBridgeMachoSha256(changed), storeBridgeMachoSha256(witness.submitted));
});
test("truncation and an unadmitted fat architecture fail closed", { skip }, () => {
  assert.throws(() => storeBridgeMachoSha256(witness.distributed.subarray(0, 64)));
  const changed = Buffer.from(witness.distributed); changed.writeUInt32LE(0xcafebabe, 0);
  assert.throws(() => storeBridgeMachoSha256(changed));
});
test("signature extent cannot hide more executable bytes", { skip }, () => {
  const changed = Buffer.from(witness.distributed);
  let at = 32;
  for (let index = 0; index < changed.readUInt32LE(16); index++) {
    const command = changed.readUInt32LE(at), size = changed.readUInt32LE(at + 4);
    if (command === 0x1d) { changed.writeUInt32LE(32, at + 8); break; }
    at += size;
  }
  assert.throws(() => storeBridgeMachoSha256(changed));
});
test("malformed load commands fail closed", { skip }, () => {
  const changed = Buffer.from(witness.distributed); changed.writeUInt32LE(0xfffffff8, 36);
  assert.throws(() => storeBridgeMachoSha256(changed));
});
