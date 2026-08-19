import { PROTOCOL_VERSION } from "@cosmaneura-scribe/capture-protocol";

import {
  HOSTED_MAX_CHUNKS,
  SYNTHETIC_APPOINTMENT_ID,
  SYNTHETIC_KEY_VERSION,
  SYNTHETIC_PATIENT_ID,
  SYNTHETIC_PRACTITIONER_ID,
} from "./constants";
import type { JsonObject, JsonValue } from "./repository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const WRAPPED_DEK = /^[A-Za-z0-9_-]{512}$/u;

export class PreviewValidationError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "PreviewValidationError";
  }
}

export function parseConsent(value: JsonValue): JsonObject {
  const object = exactObject(value, [
    "all_parties_consented",
    "appointment_id",
    "evidence_object_id",
    "granted_at",
    "method",
    "modality",
    "participant_regions",
    "patient_id",
    "practitioner_id",
  ]);
  if (
    object.appointment_id !== SYNTHETIC_APPOINTMENT_ID ||
    object.practitioner_id !== SYNTHETIC_PRACTITIONER_ID ||
    object.patient_id !== SYNTHETIC_PATIENT_ID ||
    object.modality !== "in_person" ||
    object.method !== "verbal_attestation" ||
    object.all_parties_consented !== true ||
    object.evidence_object_id !== null ||
    !isExactStringArray(object.participant_regions, ["US-NY"]) ||
    !isIsoDate(object.granted_at)
  ) {
    reject("synthetic_input_required");
  }
  return object;
}

export function parseSession(value: JsonValue, consentId: string): JsonObject {
  const object = exactObject(value, [
    "appointment_id",
    "consent_record_id",
    "modality",
    "patient_id",
    "practitioner_id",
  ]);
  if (
    object.appointment_id !== SYNTHETIC_APPOINTMENT_ID ||
    object.practitioner_id !== SYNTHETIC_PRACTITIONER_ID ||
    object.patient_id !== SYNTHETIC_PATIENT_ID ||
    object.consent_record_id !== consentId ||
    object.modality !== "in_person"
  ) {
    reject("synthetic_input_required");
  }
  return object;
}

export function parseAudioKey(value: JsonValue): JsonObject {
  const object = exactObject(value, ["key_version", "wrapped_dek"]);
  if (
    object.key_version !== SYNTHETIC_KEY_VERSION ||
    typeof object.wrapped_dek !== "string" ||
    !WRAPPED_DEK.test(object.wrapped_dek)
  ) {
    reject("audio_key_version_conflict", 409);
  }
  return object;
}

export function parseProtocolOnly(value: JsonValue): JsonObject {
  const object = exactObject(value, ["protocol_version"]);
  if (object.protocol_version !== PROTOCOL_VERSION) reject("protocol_version_invalid");
  return object;
}

export function parseRenewal(value: JsonValue): JsonObject {
  const object = exactObject(value, ["expected_generation", "protocol_version"]);
  if (
    object.protocol_version !== PROTOCOL_VERSION ||
    !isSafeInteger(object.expected_generation, 1, Number.MAX_SAFE_INTEGER)
  ) {
    reject("request_invalid");
  }
  return object;
}

export interface ReservationInput extends JsonObject {
  readonly capture_lease_generation: number;
  readonly capture_lease_id: string;
  readonly channel: "microphone";
  readonly count: number;
  readonly first_sequence_number: number;
  readonly protocol_version: typeof PROTOCOL_VERSION;
}

export function parseReservation(value: JsonValue): ReservationInput {
  const object = exactObject(value, [
    "capture_lease_generation",
    "capture_lease_id",
    "channel",
    "count",
    "first_sequence_number",
    "protocol_version",
  ]);
  if (
    object.protocol_version !== PROTOCOL_VERSION ||
    object.channel !== "microphone" ||
    typeof object.capture_lease_id !== "string" ||
    !UUID.test(object.capture_lease_id) ||
    !isSafeInteger(object.capture_lease_generation, 1, Number.MAX_SAFE_INTEGER) ||
    !isSafeInteger(object.first_sequence_number, 0, HOSTED_MAX_CHUNKS - 1) ||
    !isSafeInteger(object.count, 1, HOSTED_MAX_CHUNKS) ||
    object.first_sequence_number + object.count > HOSTED_MAX_CHUNKS
  ) {
    reject("reservation_batch_out_of_range");
  }
  return object as ReservationInput;
}

export interface RegistrationInput extends JsonObject {
  readonly channel: "microphone";
  readonly ciphertext_size_bytes: number;
  readonly object_id: string;
  readonly sequence_number: number;
  readonly sha256: string;
}

export function parseRegistration(value: JsonValue, maximumBytes: number): RegistrationInput {
  const object = exactObject(value, [
    "channel",
    "ciphertext_size_bytes",
    "object_id",
    "sequence_number",
    "sha256",
  ]);
  if (
    object.channel !== "microphone" ||
    typeof object.object_id !== "string" ||
    !UUID.test(object.object_id) ||
    !isSafeInteger(object.sequence_number, 0, HOSTED_MAX_CHUNKS - 1) ||
    !isSafeInteger(object.ciphertext_size_bytes, 1, maximumBytes) ||
    typeof object.sha256 !== "string" ||
    !SHA256.test(object.sha256)
  ) {
    reject("request_invalid");
  }
  return object as RegistrationInput;
}

export interface CompletionInput extends JsonObject {
  readonly capture_lease_generation: number;
  readonly capture_lease_id: string;
  readonly channels: [{ readonly channel: "microphone"; readonly final_sequence_number: number }];
  readonly protocol_version: typeof PROTOCOL_VERSION;
}

export function parseCompletion(value: JsonValue): CompletionInput {
  const object = exactObject(value, [
    "capture_lease_generation",
    "capture_lease_id",
    "channels",
    "protocol_version",
  ]);
  if (
    object.protocol_version !== PROTOCOL_VERSION ||
    typeof object.capture_lease_id !== "string" ||
    !UUID.test(object.capture_lease_id) ||
    !isSafeInteger(object.capture_lease_generation, 1, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(object.channels) ||
    object.channels.length !== 1
  ) {
    reject("request_invalid");
  }
  const channel = exactObject(object.channels[0] ?? null, ["channel", "final_sequence_number"]);
  if (
    channel.channel !== "microphone" ||
    !isSafeInteger(channel.final_sequence_number, 0, HOSTED_MAX_CHUNKS - 1)
  ) {
    reject("request_invalid");
  }
  return { ...object, channels: [channel] } as CompletionInput;
}

export function requireUuid(value: string): string {
  if (!UUID.test(value)) reject("route_parameter_invalid", 404);
  return value;
}

export function exactObject(value: JsonValue, exactKeys: readonly string[]): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("request_invalid");
  }
  const object = value;
  const actualKeys = Object.keys(object).sort();
  const expectedKeys = [...exactKeys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    reject("request_invalid");
  }
  return object;
}

function isSafeInteger(
  value: JsonValue | undefined,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isIsoDate(value: JsonValue | undefined): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isExactStringArray(
  value: JsonValue | undefined,
  expected: readonly string[],
): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function reject(code: string, status = 422): never {
  throw new PreviewValidationError(status, code);
}
