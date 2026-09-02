import assert from "node:assert/strict";
import test from "node:test";

import {
  IOS_PCM_MAXIMUM_PACKET_BYTES,
  clearIosPcmBytes,
  decodeIosPcmBase64,
} from "../dist/esm/index.js";

test("decodes canonical Base64 into an exclusive full-span buffer", () => {
  const bytes = decodeIosPcmBase64("AQIDBA==");
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
  assert.equal(bytes.byteOffset, 0);
  assert.equal(bytes.byteLength, bytes.buffer.byteLength);

  clearIosPcmBytes(bytes);
  assert.deepEqual([...bytes], [0, 0, 0, 0]);
});

test("rejects malformed, empty, and oversized Base64 before allocation", () => {
  for (const encoded of ["", "AQ", "AQ==", "AQIDBA=", "AQIDBA==\n", "____"]) {
    assert.throws(() => decodeIosPcmBase64(encoded), {
      message: "ios_capture_invalid_arguments",
    });
  }
  const oversized = "A".repeat(
    Math.ceil(IOS_PCM_MAXIMUM_PACKET_BYTES / 3) * 4 + 4,
  );
  assert.throws(() => decodeIosPcmBase64(oversized), {
    message: "ios_capture_invalid_arguments",
  });
});

test("refuses to clear an aliased subview", () => {
  const storage = new Uint8Array([1, 2, 3, 4]);
  const subview = storage.subarray(1, 3);
  assert.throws(() => clearIosPcmBytes(subview), {
    message: "ios_capture_invalid_arguments",
  });
  assert.deepEqual([...storage], [1, 2, 3, 4]);
});
