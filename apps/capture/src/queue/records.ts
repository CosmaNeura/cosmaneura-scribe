import {
  base64UrlDecode,
  base64UrlEncode,
  CAPTURE_CHANNELS,
  MAX_CHUNKS,
  MAX_ENVELOPE_BYTES,
  parseEnvelope,
  PROTOCOL_VERSION,
} from "@cosmaneura-scribe/capture-protocol";

import { QueueInvariantError } from "./errors";
import {
  QUEUE_RECORD_SCHEMA_VERSION,
  type CaptureChunkMetadata,
  type CaptureChunkRecord,
  type ChunkIdempotencyKeys,
  type ChunkReservation,
  type ChunkRetryState,
  type EncryptedChunkRecord,
  type OperationRetryState,
  type PurgedChunkRecord,
  type QueueOperation,
  type RegisteredChunkRecord,
  type RegistrationReceipt,
  type ReservedChunkRecord,
  type UploadedChunkRecord,
  type UploadingChunkRecord,
} from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FORBIDDEN_PERSISTED_FIELD_NAMES = new Set([
  "accesstoken",
  "bearertoken",
  "blobpath",
  "bloburl",
  "dek",
  "entratoken",
  "objectpath",
  "patientdisplay",
  "patientdisplayvalue",
  "patientname",
  "rawdek",
  "refreshtoken",
  "sas",
  "sasurl",
  "token",
  "uploadurl",
]);

const EMPTY_OPERATION_RETRY: OperationRetryState = Object.freeze({
  attempts: 0,
  notBeforeEpochMs: null,
  terminalCode: null,
});

export function createReservedRecord(
  reservation: ChunkReservation,
  idempotencyKeys: ChunkIdempotencyKeys,
): ReservedChunkRecord {
  const record: ReservedChunkRecord = {
    schemaVersion: QUEUE_RECORD_SCHEMA_VERSION,
    revision: 1,
    state: "reserved",
    reservation: cloneReservation(reservation),
    idempotencyKeys: { ...idempotencyKeys },
    retry: {
      upload: { ...EMPTY_OPERATION_RETRY },
      registration: { ...EMPTY_OPERATION_RETRY },
    },
  };
  assertSafeCaptureRecord(record);
  return record;
}

export function attachEncryptedEnvelope(
  record: ReservedChunkRecord,
  envelope: Uint8Array,
  sha256: string,
): EncryptedChunkRecord {
  if (record.state !== "reserved") throw new QueueInvariantError("chunk_not_reserved");
  parseEnvelope(envelope);
  if (envelope.byteLength > MAX_ENVELOPE_BYTES) {
    throw new QueueInvariantError("envelope_too_large");
  }
  const next: EncryptedChunkRecord = {
    ...cloneCommon(record),
    revision: record.revision + 1,
    state: "encrypted",
    envelope: envelope.slice(),
    sha256: sha256.toLowerCase(),
    byteLength: envelope.byteLength,
  };
  assertSafeCaptureRecord(next);
  return next;
}

export function markUploading(record: EncryptedChunkRecord): UploadingChunkRecord {
  const next: UploadingChunkRecord = {
    ...cloneCommon(record),
    revision: record.revision + 1,
    state: "uploading",
    ...cloneEnvelope(record),
  };
  assertSafeCaptureRecord(next);
  return next;
}

export function markUploaded(record: UploadingChunkRecord): UploadedChunkRecord {
  const next: UploadedChunkRecord = {
    ...cloneCommon(record),
    revision: record.revision + 1,
    state: "uploaded",
    retry: {
      ...cloneRetry(record.retry),
      upload: { ...EMPTY_OPERATION_RETRY },
    },
    ...cloneEnvelope(record),
  };
  assertSafeCaptureRecord(next);
  return next;
}

export function markRegistered(
  record: UploadedChunkRecord,
  receipt: RegistrationReceipt,
): RegisteredChunkRecord {
  assertMatchingReceipt(record, receipt);
  const next: RegisteredChunkRecord = {
    ...cloneCommon(record),
    revision: record.revision + 1,
    state: "registered",
    retry: {
      ...cloneRetry(record.retry),
      registration: { ...EMPTY_OPERATION_RETRY },
    },
    ...cloneEnvelope(record),
    registrationReceipt: { ...receipt, sha256: receipt.sha256.toLowerCase() },
  };
  assertSafeCaptureRecord(next);
  return next;
}

export function markPurged(record: RegisteredChunkRecord, purgedAt: string): PurgedChunkRecord {
  assertTimestamp(purgedAt, "invalid_purge_timestamp");
  const next: PurgedChunkRecord = {
    ...cloneCommon(record),
    revision: record.revision + 1,
    state: "purged",
    registrationReceipt: { ...record.registrationReceipt },
    purgedAt,
  };
  assertSafeCaptureRecord(next);
  return next;
}

export function rotateUploadAuthorizationKey(
  record: UploadingChunkRecord,
  idempotencyKey: string,
): UploadingChunkRecord {
  assertIdempotencyKey(idempotencyKey);
  const next: UploadingChunkRecord = {
    ...cloneCommon(record),
    revision: record.revision + 1,
    state: "uploading",
    idempotencyKeys: {
      ...record.idempotencyKeys,
      uploadAuthorization: idempotencyKey,
      uploadAuthorizationGeneration: record.idempotencyKeys.uploadAuthorizationGeneration + 1,
    },
    retry: {
      ...cloneRetry(record.retry),
      upload: {
        ...record.retry.upload,
        notBeforeEpochMs: null,
        terminalCode: null,
      },
    },
    ...cloneEnvelope(record),
  };
  assertSafeCaptureRecord(next);
  return next;
}

export function scheduleRetry(
  record: EncryptedChunkRecord | UploadingChunkRecord | UploadedChunkRecord,
  operation: QueueOperation,
  notBeforeEpochMs: number,
): typeof record {
  if (!Number.isSafeInteger(notBeforeEpochMs) || notBeforeEpochMs < 0) {
    throw new QueueInvariantError("invalid_retry_time");
  }
  const current = record.retry[operation];
  const nextOperation: OperationRetryState = {
    attempts: current.attempts + 1,
    notBeforeEpochMs,
    terminalCode: null,
  };
  return cloneWithRetry(record, operation, nextOperation);
}

export function markTerminalFailure(
  record: EncryptedChunkRecord | UploadingChunkRecord | UploadedChunkRecord,
  operation: QueueOperation,
  code: string,
): typeof record {
  assertFixedCode(code);
  const current = record.retry[operation];
  const nextOperation: OperationRetryState = {
    attempts: current.attempts + 1,
    notBeforeEpochMs: null,
    terminalCode: code,
  };
  return cloneWithRetry(record, operation, nextOperation);
}

export function assertMatchingReceipt(
  record:
    | EncryptedChunkRecord
    | UploadingChunkRecord
    | UploadedChunkRecord
    | RegisteredChunkRecord,
  receipt: RegistrationReceipt,
): void {
  assertRegistrationReceipt(receipt);
  if (
    receipt.sha256.toLowerCase() !== record.sha256 ||
    receipt.byteLength !== record.byteLength
  ) {
    throw new QueueInvariantError("registration_receipt_mismatch");
  }
}

export function assertSafeCaptureRecord(record: CaptureChunkRecord): void {
  assertNoForbiddenFields(record);
  const baseKeys = [
    "idempotencyKeys",
    "reservation",
    "retry",
    "revision",
    "schemaVersion",
    "state",
  ];
  if (record.state === "reserved") {
    assertExactKeys(record, baseKeys, "invalid_reserved_record");
  } else if (
    record.state === "encrypted" ||
    record.state === "uploading" ||
    record.state === "uploaded"
  ) {
    assertExactKeys(
      record,
      [...baseKeys, "byteLength", "envelope", "sha256"],
      "invalid_encrypted_record",
    );
    assertEnvelopeRecord(record);
  } else if (record.state === "registered") {
    assertExactKeys(
      record,
      [...baseKeys, "byteLength", "envelope", "registrationReceipt", "sha256"],
      "invalid_registered_record",
    );
    assertEnvelopeRecord(record);
    assertMatchingReceipt(record, record.registrationReceipt);
  } else {
    assertExactKeys(
      record,
      [...baseKeys, "purgedAt", "registrationReceipt"],
      "invalid_purged_record",
    );
    assertTimestamp(record.purgedAt, "invalid_purge_timestamp");
    assertRegistrationReceipt(record.registrationReceipt);
  }

  if (record.schemaVersion !== QUEUE_RECORD_SCHEMA_VERSION) {
    throw new QueueInvariantError("unsupported_queue_record");
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new QueueInvariantError("invalid_record_revision");
  }
  assertReservation(record.reservation);
  assertIdempotencyKeys(record.idempotencyKeys);
  assertRetry(record.retry);
}

export function cloneCaptureRecord(record: CaptureChunkRecord): CaptureChunkRecord {
  assertSafeCaptureRecord(record);
  switch (record.state) {
    case "reserved":
      return { ...cloneCommon(record), state: "reserved" };
    case "encrypted":
      return { ...cloneCommon(record), state: "encrypted", ...cloneEnvelope(record) };
    case "uploading":
      return { ...cloneCommon(record), state: "uploading", ...cloneEnvelope(record) };
    case "uploaded":
      return { ...cloneCommon(record), state: "uploaded", ...cloneEnvelope(record) };
    case "registered":
      return {
        ...cloneCommon(record),
        state: "registered",
        ...cloneEnvelope(record),
        registrationReceipt: { ...record.registrationReceipt },
      };
    case "purged":
      return {
        ...cloneCommon(record),
        state: "purged",
        registrationReceipt: { ...record.registrationReceipt },
        purgedAt: record.purgedAt,
      };
  }
}

/** Project only after validating the complete record, including its envelope. */
export function captureChunkMetadata(record: CaptureChunkRecord): CaptureChunkMetadata {
  assertSafeCaptureRecord(record);
  const common = cloneCommon(record);
  switch (record.state) {
    case "reserved": return { ...common, state: "reserved" };
    case "purged": return { ...common, state: "purged", purgedAt: record.purgedAt,
      registrationReceipt: { ...record.registrationReceipt } };
    case "registered": return { ...common, state: "registered", sha256: record.sha256,
      byteLength: record.byteLength, registrationReceipt: { ...record.registrationReceipt } };
    default: return { ...common, state: record.state, sha256: record.sha256, byteLength: record.byteLength };
  }
}

function cloneWithRetry<Record extends EncryptedChunkRecord | UploadingChunkRecord | UploadedChunkRecord>(
  record: Record,
  operation: QueueOperation,
  nextOperation: OperationRetryState,
): Record {
  const next = {
    ...cloneCommon(record),
    revision: record.revision + 1,
    state: record.state,
    retry: {
      ...cloneRetry(record.retry),
      [operation]: nextOperation,
    },
    ...cloneEnvelope(record),
  } as Record;
  assertSafeCaptureRecord(next);
  return next;
}

function cloneCommon(record: CaptureChunkRecord) {
  return {
    schemaVersion: record.schemaVersion,
    revision: record.revision,
    reservation: cloneReservation(record.reservation),
    idempotencyKeys: { ...record.idempotencyKeys },
    retry: cloneRetry(record.retry),
  };
}

function cloneReservation(reservation: ChunkReservation): ChunkReservation {
  return { ...reservation };
}

function cloneRetry(retry: ChunkRetryState): ChunkRetryState {
  return {
    upload: { ...retry.upload },
    registration: { ...retry.registration },
  };
}

function cloneEnvelope(
  record:
    | EncryptedChunkRecord
    | UploadingChunkRecord
    | UploadedChunkRecord
    | RegisteredChunkRecord,
) {
  return {
    envelope: record.envelope.slice(),
    sha256: record.sha256,
    byteLength: record.byteLength,
  };
}

function assertReservation(reservation: ChunkReservation): void {
  assertExactKeys(
    reservation,
    [
      "additionalAuthenticatedData",
      "channel",
      "createdAt",
      "objectId",
      "protocolVersion",
      "sequenceNumber",
      "sessionId",
    ],
    "invalid_reservation",
  );
  if (reservation.protocolVersion !== PROTOCOL_VERSION) {
    throw new QueueInvariantError("unsupported_capture_protocol");
  }
  assertUuid(reservation.objectId, "invalid_object_id");
  assertUuid(reservation.sessionId, "invalid_session_id");
  if (!CAPTURE_CHANNELS.includes(reservation.channel)) {
    throw new QueueInvariantError("invalid_capture_channel");
  }
  if (
    !Number.isSafeInteger(reservation.sequenceNumber) ||
    reservation.sequenceNumber < 0 ||
    reservation.sequenceNumber >= MAX_CHUNKS
  ) {
    throw new QueueInvariantError("invalid_sequence_number");
  }
  let decoded: Uint8Array;
  try {
    decoded = base64UrlDecode(reservation.additionalAuthenticatedData);
  } catch {
    throw new QueueInvariantError("invalid_reservation_aad");
  }
  if (
    decoded.byteLength === 0 ||
    base64UrlEncode(decoded) !== reservation.additionalAuthenticatedData
  ) {
    throw new QueueInvariantError("invalid_reservation_aad");
  }
  assertTimestamp(reservation.createdAt, "invalid_reservation_timestamp");
}

function assertIdempotencyKeys(keys: ChunkIdempotencyKeys): void {
  assertExactKeys(
    keys,
    [
      "registration",
      "reservation",
      "uploadAuthorization",
      "uploadAuthorizationGeneration",
    ],
    "invalid_idempotency_keys",
  );
  assertIdempotencyKey(keys.reservation);
  assertIdempotencyKey(keys.uploadAuthorization);
  assertIdempotencyKey(keys.registration);
  if (
    !Number.isSafeInteger(keys.uploadAuthorizationGeneration) ||
    keys.uploadAuthorizationGeneration < 1
  ) {
    throw new QueueInvariantError("invalid_authorization_key_generation");
  }
}

function assertRetry(retry: ChunkRetryState): void {
  assertExactKeys(retry, ["registration", "upload"], "invalid_retry_state");
  assertOperationRetry(retry.upload);
  assertOperationRetry(retry.registration);
}

function assertOperationRetry(retry: OperationRetryState): void {
  assertExactKeys(
    retry,
    ["attempts", "notBeforeEpochMs", "terminalCode"],
    "invalid_retry_state",
  );
  if (!Number.isSafeInteger(retry.attempts) || retry.attempts < 0) {
    throw new QueueInvariantError("invalid_retry_state");
  }
  if (
    retry.notBeforeEpochMs !== null &&
    (!Number.isSafeInteger(retry.notBeforeEpochMs) || retry.notBeforeEpochMs < 0)
  ) {
    throw new QueueInvariantError("invalid_retry_state");
  }
  if (retry.terminalCode !== null) assertFixedCode(retry.terminalCode);
}

function assertEnvelopeRecord(
  record:
    | EncryptedChunkRecord
    | UploadingChunkRecord
    | UploadedChunkRecord
    | RegisteredChunkRecord,
): void {
  if (!(record.envelope instanceof Uint8Array)) {
    throw new QueueInvariantError("invalid_envelope_bytes");
  }
  try {
    parseEnvelope(record.envelope);
  } catch {
    throw new QueueInvariantError("invalid_envelope_bytes");
  }
  if (record.byteLength !== record.envelope.byteLength || record.byteLength > MAX_ENVELOPE_BYTES) {
    throw new QueueInvariantError("invalid_envelope_length");
  }
  if (!SHA256_PATTERN.test(record.sha256)) {
    throw new QueueInvariantError("invalid_envelope_digest");
  }
}

function assertRegistrationReceipt(receipt: RegistrationReceipt): void {
  assertExactKeys(
    receipt,
    ["byteLength", "chunkId", "registeredAt", "sha256"],
    "invalid_registration_receipt",
  );
  assertUuid(receipt.chunkId, "invalid_registration_receipt");
  if (!SHA256_PATTERN.test(receipt.sha256.toLowerCase())) {
    throw new QueueInvariantError("invalid_registration_receipt");
  }
  if (!Number.isSafeInteger(receipt.byteLength) || receipt.byteLength < 1) {
    throw new QueueInvariantError("invalid_registration_receipt");
  }
  assertTimestamp(receipt.registeredAt, "invalid_registration_receipt");
}

function assertNoForbiddenFields(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || value instanceof Uint8Array) return;
  if (seen.has(value)) throw new QueueInvariantError("cyclic_queue_record");
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
    if (FORBIDDEN_PERSISTED_FIELD_NAMES.has(normalized)) {
      throw new QueueInvariantError("forbidden_persisted_field");
    }
    assertNoForbiddenFields(nested, seen);
  }
  seen.delete(value);
}

function assertExactKeys(value: object, keys: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new QueueInvariantError(code);
  }
}

function assertIdempotencyKey(value: string): void {
  if (typeof value !== "string" || value.length < 8 || value.length > 255) {
    throw new QueueInvariantError("invalid_idempotency_key");
  }
}

function assertUuid(value: string, code: string): void {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new QueueInvariantError(code);
  }
}

function assertTimestamp(value: string, code: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new QueueInvariantError(code);
  }
}

function assertFixedCode(code: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(code)) {
    throw new QueueInvariantError("unsafe_failure_code");
  }
}
