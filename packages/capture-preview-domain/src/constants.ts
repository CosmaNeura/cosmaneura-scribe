import {
  AUDIO_CHANNELS,
  AUDIO_ENCODING,
  CAPTURE_LEASE_TTL_SECONDS,
  MAX_ENVELOPE_BYTES,
  MEDIA_TYPE,
  PROTOCOL_VERSION,
  RESERVATION_PLAINTEXT_BUDGET_BYTES,
  RESERVATION_WINDOW_SECONDS,
  SAMPLE_RATE_HZ,
  TARGET_CHUNK_DURATION_MS,
  UPLOAD_CONCURRENCY,
} from "@cosmaneura-scribe/capture-protocol";

export const HOSTED_MAX_CHUNKS = 6;
export const PREVIEW_TTL_SECONDS = 24 * 60 * 60;
export const PREVIEW_ENVELOPE_TTL_SECONDS = 60 * 60;
export const SYNTHETIC_KEY_VERSION = "synthetic-wrapping-key-v1";
export const SYNTHETIC_APPOINTMENT_ID = "synthetic-appointment";
export const SYNTHETIC_PRACTITIONER_ID = "synthetic-practitioner";
export const SYNTHETIC_PATIENT_ID = "synthetic-patient";
export const PREVIEW_COOKIE_NAME = "__Host-capture_preview";

export const SYNTHETIC_PUBLIC_KEY = Object.freeze({
  key_version: SYNTHETIC_KEY_VERSION,
  algorithm: "RSA-OAEP-256",
  public_jwk: {
    kty: "RSA",
    n: "o_AtBxyAWpYN21-Dd-bJAKxbZssBG-g00AqfKkzcTqGxDEheaAZmxkCvBlx9Zj0tuCfNPGJOZpN4TSnvcC2HDtJqWhkkmWas8KH8HKWTmQwN-YN_kC5m6WZEd5bUBERsFE4icqK8U4eBpcHv_LSvTtth-s9qhhSFQQE73PRce3boZy3_6MOCiCu0XNiD9vpG3kFpUoUwSxgK4Pjedg5UJ20-eb3iR3DHddWCb8BaIKEeCOwWo30DuYVGqy7muu0F-VAchG3utCfhVyxzlHYsc3vVvj-pWVM7PlAgWn5M9tlGo73NrOKOk4Z4WusWyyLHzBUv6HCakVDUjVVOsZGhdCJQTxYe_zOYQcDYM1Uso7XkFOlvXjHQSxhCaMmrKEdTLJopQdBagM8EO1PhAjZhXAvQ77Z683t5vC6w_O7BrsIu1yhTwAPU_4Exx7WIQ-YpSCLLk_b_FIz-K-3w59rytUNlZh6lujJeSqzlI0-hBTilfBj2QdyQBdPgWCIXrccP",
    e: "AQAB",
    alg: "RSA-OAEP-256",
    ext: true,
    key_ops: ["wrapKey"],
  },
} as const);

export function hostedCapabilities(reservationCount: number) {
  return {
    protocol_version: PROTOCOL_VERSION,
    media: {
      media_type: MEDIA_TYPE,
      encoding: AUDIO_ENCODING,
      channels: AUDIO_CHANNELS,
      sample_rate_hz: SAMPLE_RATE_HZ,
    },
    target_chunk_duration_ms: TARGET_CHUNK_DURATION_MS,
    max_envelope_bytes: MAX_ENVELOPE_BYTES,
    max_chunks: HOSTED_MAX_CHUNKS,
    remaining_aggregate_plaintext_bytes:
      Math.max(0, HOSTED_MAX_CHUNKS - reservationCount) *
      RESERVATION_PLAINTEXT_BUDGET_BYTES,
    capture_lease_ttl_seconds: CAPTURE_LEASE_TTL_SECONDS,
    reservation_window_seconds: RESERVATION_WINDOW_SECONDS,
    max_reservations_per_batch: HOSTED_MAX_CHUNKS,
    upload_concurrency: UPLOAD_CONCURRENCY,
  } as const;
}
