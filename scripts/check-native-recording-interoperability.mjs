import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodeCaptureRecord } from "../apps/capture/src/storage/record-codec.ts";
import { encodeChunkAdditionalData, parseEnvelope } from "../packages/capture-protocol/src/generated.ts";

// Input comes from NativeRecordingEncryptionTests' explicit synthetic export.
const input = process.argv[2];
assert(input, "pass the synthetic native queue-record path");
const record = decodeCaptureRecord(readFileSync(input, "utf8"));
assert.equal(record.state, "encrypted");
assert.equal(record.revision, 2);
assert.equal(record.reservation.sequenceNumber, 1);
assert.equal(record.reservation.channel, "microphone");
if (record.state !== "encrypted") throw new Error("expected encrypted fixture");
assert.equal(record.byteLength, record.envelope.byteLength);
assert.equal(record.sha256, createHash("sha256").update(record.envelope).digest("hex"));
const parsed = parseEnvelope(record.envelope);
assert.equal(parsed.header.media_type, "audio/wav");
const aad = Buffer.from(record.reservation.additionalAuthenticatedData, "base64url");
const fields = JSON.parse(aad.toString("utf8"));
assert.deepEqual(aad, Buffer.from(encodeChunkAdditionalData({
  tenantId: fields.tenant_id,
  sessionId: record.reservation.sessionId,
  objectId: record.reservation.objectId,
  sequenceNumber: record.reservation.sequenceNumber,
  channel: record.reservation.channel,
})));
console.log("Native ciphertext accepted by existing queue decoder and generated protocol parser; scope, digest, size and revisions match.");
