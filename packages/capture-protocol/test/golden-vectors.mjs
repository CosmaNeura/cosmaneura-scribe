import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  SOURCE_SHA256,
  base64UrlEncode,
  encodeChunkAdditionalData,
  encodeEnvelope,
  parseEnvelope,
} from "../src/generated.ts";

const path = new URL("../../../protocol/golden/capture_protocol_v1.json", import.meta.url);
const golden = JSON.parse(await readFile(path, "utf8"));
assert.equal(golden.source_sha256, SOURCE_SHA256);

for (const vector of golden.vectors) {
  const input = vector.input;
  const aad = encodeChunkAdditionalData({
    tenantId: input.tenant_id,
    sessionId: input.session_id,
    objectId: input.object_id,
    sequenceNumber: input.sequence_number,
    channel: input.channel,
  });
  assert.equal(new TextDecoder().decode(aad), vector.expected.aad_utf8, vector.name);
  assert.equal(base64UrlEncode(aad), vector.expected.aad_base64url, vector.name);

  const ciphertext = Uint8Array.from(Buffer.from(input.ciphertext_hex, "hex"));
  const envelope = encodeEnvelope(
    {
      schema_version: golden.protocol_version,
      content_encryption: "A256GCM",
      nonce: base64UrlEncode(Uint8Array.from(Buffer.from(input.nonce_hex, "hex"))),
      media_type: "audio/wav",
    },
    ciphertext,
  );
  assert.equal(base64UrlEncode(envelope), vector.expected.envelope_base64url, vector.name);
  assert.equal(createHash("sha256").update(envelope).digest("hex"), vector.expected.envelope_sha256, vector.name);
  const decoded = parseEnvelope(envelope);
  assert.deepEqual(decoded.ciphertext, ciphertext, vector.name);
}
