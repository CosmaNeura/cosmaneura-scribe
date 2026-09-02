import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const supportDirectory = dirname(fileURLToPath(import.meta.url));
const goldenPath = resolve(supportDirectory, "../../../../protocol/golden/capture_protocol_v1.json");
const protocolPath = resolve(supportDirectory, "../../../../protocol/capture_protocol_v1.json");
const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
const protocol = JSON.parse(readFileSync(protocolPath, "utf8"));
fixed(golden.protocol_version === protocol.protocol_version, "protocol_golden_version_invalid");
fixed(Array.isArray(golden.vectors) && golden.vectors.length > 0, "protocol_golden_vectors_missing");

const validatedGoldenVectors = golden.vectors.map(validateGoldenVector);
const microphoneGolden = validatedGoldenVectors.find(
  ({ vector }) => vector.input.channel === "microphone" && vector.input.sequence_number === 0,
);
fixed(microphoneGolden !== undefined, "protocol_microphone_golden_vector_missing");

export function assertUploadedEnvelopeContract(envelope, registration) {
  const parts = splitEnvelope(envelope);
  fixed(
    envelope.length <= protocol.encryption.envelope.max_complete_envelope_bytes,
    "uploaded_envelope_too_large",
  );
  fixed(
    envelope.subarray(0, 12).equals(microphoneGolden.envelope.subarray(0, 12)),
    "uploaded_envelope_prefix_mismatch",
  );
  fixed(parts.magic === microphoneGolden.parts.magic, "uploaded_envelope_magic_mismatch");

  let header;
  try {
    header = JSON.parse(parts.headerText);
  } catch {
    throw new Error("uploaded_envelope_header_invalid");
  }
  fixed(
    typeof header.nonce === "string" &&
      /^[A-Za-z0-9_-]+$/u.test(header.nonce) &&
      header.nonce.length === Buffer.alloc(protocol.encryption.nonce_bytes).toString("base64url").length,
    "uploaded_envelope_nonce_invalid",
  );
  const nonce = Buffer.from(header.nonce, "base64url");
  fixed(nonce.length === protocol.encryption.nonce_bytes, "uploaded_envelope_nonce_invalid");
  fixed(nonce.toString("base64url") === header.nonce, "uploaded_envelope_nonce_invalid");
  fixed(parts.headerText === canonicalHeader(header.nonce), "uploaded_envelope_header_mismatch");
  fixed(
    parts.ciphertext.length >= protocol.encryption.authentication_tag_bytes,
    "uploaded_envelope_ciphertext_too_short",
  );
  fixed(parts.ciphertext.toString("ascii", 0, 4) !== "RIFF", "uploaded_envelope_is_plaintext");

  const digest = createHash("sha256").update(envelope).digest("hex");
  fixed(/^[0-9a-f]{64}$/u.test(registration.sha256), "registration_digest_invalid");
  fixed(registration.sha256 === digest, "registration_digest_mismatch");
  fixed(registration.ciphertextSizeBytes === envelope.length, "registration_size_mismatch");
  fixed(
    registration.channel === microphoneGolden.vector.input.channel,
    "registration_channel_mismatch",
  );
  fixed(
    registration.sequenceNumber === microphoneGolden.vector.input.sequence_number,
    "registration_sequence_mismatch",
  );
}

export function assertCompletionContract(completion, finalSequenceNumber) {
  fixed(
    completion.protocolVersion === protocol.protocol_version,
    "completion_protocol_version_mismatch",
  );
  fixed(completion.channels.length === 1, "completion_channel_count_mismatch");
  const channel = completion.channels[0];
  fixed(
    channel?.channel === microphoneGolden.vector.input.channel,
    "completion_channel_mismatch",
  );
  fixed(
    channel?.final_sequence_number === finalSequenceNumber,
    "completion_sequence_mismatch",
  );
}

function validateGoldenVector(vector) {
  fixed(typeof vector?.name === "string" && vector.name.length > 0, "protocol_golden_name_invalid");
  const envelope = decodeCanonicalBase64Url(
    vector.expected?.envelope_base64url,
    "protocol_golden_envelope_invalid",
  );
  const parts = splitEnvelope(envelope);
  const nonceBytes = Buffer.from(vector.input?.nonce_hex ?? "", "hex");
  fixed(
    nonceBytes.length === protocol.encryption.nonce_bytes &&
      nonceBytes.toString("hex") === vector.input.nonce_hex,
    "protocol_golden_nonce_invalid",
  );
  fixed(
    parts.magic === protocol.encryption.envelope.magic_ascii,
    "protocol_golden_magic_invalid",
  );
  fixed(
    parts.headerText === canonicalHeader(nonceBytes.toString("base64url")),
    "protocol_golden_header_invalid",
  );
  fixed(
    createHash("sha256").update(envelope).digest("hex") ===
      vector.expected.envelope_sha256,
    "protocol_golden_digest_invalid",
  );
  fixed(
    parts.ciphertext.toString("hex") === vector.input.ciphertext_hex,
    "protocol_golden_ciphertext_invalid",
  );

  const aad = canonicalAdditionalData(vector.input);
  fixed(aad === vector.expected.aad_utf8, "protocol_golden_aad_invalid");
  fixed(
    Buffer.from(aad, "utf8").toString("base64url") === vector.expected.aad_base64url,
    "protocol_golden_aad_encoding_invalid",
  );
  return { envelope, parts, vector };
}

function splitEnvelope(envelope) {
  fixed(Buffer.isBuffer(envelope), "uploaded_envelope_missing");
  fixed(envelope.length > 12, "uploaded_envelope_too_short");
  const headerLength = envelope.readUInt32BE(8);
  fixed(
    headerLength > 0 && headerLength <= protocol.encryption.envelope.max_header_bytes,
    "uploaded_envelope_header_length_invalid",
  );
  const headerEnd = 12 + headerLength;
  fixed(headerEnd < envelope.length, "uploaded_envelope_header_truncated");
  return {
    magic: envelope.toString("ascii", 0, 8),
    headerText: new TextDecoder("utf-8", { fatal: true }).decode(
      envelope.subarray(12, headerEnd),
    ),
    ciphertext: envelope.subarray(headerEnd),
  };
}

function canonicalHeader(nonce) {
  return JSON.stringify({
    content_encryption: protocol.encryption.algorithm,
    media_type: protocol.media_profile.media_type,
    nonce,
    schema_version: protocol.protocol_version,
  });
}

function canonicalAdditionalData(input) {
  return JSON.stringify({
    channel: input.channel,
    object_id: input.object_id,
    sequence_number: input.sequence_number,
    session_id: input.session_id,
    tenant_id: input.tenant_id,
  });
}

function decodeCanonicalBase64Url(value, code) {
  fixed(typeof value === "string" && /^[A-Za-z0-9_-]+$/u.test(value), code);
  const decoded = Buffer.from(value, "base64url");
  fixed(decoded.toString("base64url") === value, code);
  return decoded;
}

function fixed(condition, code) {
  if (!condition) throw new Error(code);
}
