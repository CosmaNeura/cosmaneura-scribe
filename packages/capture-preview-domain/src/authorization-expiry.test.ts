import {
  CAPTURE_LEASE_TTL_SECONDS,
  NONCE_BYTES,
  PROTOCOL_VERSION,
  base64UrlEncode,
  encodeEnvelope,
} from "@cosmaneura-scribe/capture-protocol";
import { describe, expect, it } from "vitest";

import { PreviewCaptureDomain, PreviewDomainError } from "./domain";
import { InMemoryPreviewRepository, type JsonValue } from "./repository";

const SCOPE_ID = "a".repeat(64);

describe("preview upload authorization expiry", () => {
  it("uses server time, rejects expired replay, and preserves the reservation binding", async () => {
    let now = new Date("2026-08-20T00:00:00.000Z");
    const repository = new InMemoryPreviewRepository();
    const domain = new PreviewCaptureDomain(repository, { now: () => new Date(now) });
    await domain.bootstrap(SCOPE_ID);

    const consent = await domain.createConsent(
      SCOPE_ID,
      {
        appointment_id: "synthetic-appointment",
        practitioner_id: "synthetic-practitioner",
        patient_id: "synthetic-patient",
        modality: "in_person",
        method: "verbal_attestation",
        all_parties_consented: true,
        participant_regions: ["US-NY"],
        granted_at: now.toISOString(),
        evidence_object_id: null,
      },
      "expiry-consent-0001",
    );
    const consentId = field(consent, "id");
    const session = await domain.createSession(
      SCOPE_ID,
      {
        appointment_id: "synthetic-appointment",
        practitioner_id: "synthetic-practitioner",
        patient_id: "synthetic-patient",
        consent_record_id: consentId,
        modality: "in_person",
      },
      "expiry-session-0001",
    );
    const sessionId = field(session, "id");
    await domain.bindAudioKey(
      SCOPE_ID,
      sessionId,
      { key_version: "synthetic-wrapping-key-v1", wrapped_dek: "a".repeat(512) },
      "expiry-bind-0001",
    );
    const lease = await domain.issueLease(
      SCOPE_ID,
      sessionId,
      { protocol_version: PROTOCOL_VERSION },
      "expiry-lease-0001",
    );
    const reservationBatch = await domain.reserveChunks(
      SCOPE_ID,
      sessionId,
      {
        protocol_version: PROTOCOL_VERSION,
        capture_lease_id: field(lease, "lease_id"),
        capture_lease_generation: integerField(lease, "generation"),
        channel: "microphone",
        first_sequence_number: 0,
        count: 1,
      },
      "expiry-reserve-0001",
    );
    const reservation = firstObject(reservationBatch, "reservations");
    const objectId = field(reservation, "object_id");

    const firstAuthorization = await domain.authorizeUpload(
      SCOPE_ID,
      sessionId,
      objectId,
      { protocol_version: PROTOCOL_VERSION },
      "expiry-authorize-0001",
    );
    const firstReceipt = uploadReceipt(firstAuthorization);

    now = new Date(now.getTime() + (CAPTURE_LEASE_TTL_SECONDS + 1) * 1_000);
    await expect(
      domain.putEnvelope(SCOPE_ID, objectId, firstReceipt, syntheticEnvelope()),
    ).rejects.toEqual(new PreviewDomainError(403, "upload_authorization_invalid"));
    await expect(repository.readEnvelope(SCOPE_ID, objectId)).resolves.toBeNull();
    await expect(
      domain.authorizeUpload(
        SCOPE_ID,
        sessionId,
        objectId,
        { protocol_version: PROTOCOL_VERSION },
        "expiry-authorize-0001",
      ),
    ).rejects.toEqual(new PreviewDomainError(409, "upload_authorization_expired"));

    const refreshed = await domain.authorizeUpload(
      SCOPE_ID,
      sessionId,
      objectId,
      { protocol_version: PROTOCOL_VERSION },
      "expiry-authorize-0002",
    );
    expect(field(refreshed, "object_id")).toBe(objectId);
    expect(field(refreshed, "additional_authenticated_data")).toBe(
      field(firstAuthorization, "additional_authenticated_data"),
    );
    expect(field(refreshed, "upload_url")).not.toBe(field(firstAuthorization, "upload_url"));
    await expect(
      domain.putEnvelope(SCOPE_ID, objectId, uploadReceipt(refreshed), syntheticEnvelope()),
    ).resolves.toBeUndefined();
  });
});

function field(value: JsonValue, name: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`missing ${name}`);
  }
  const fieldValue = value[name];
  if (typeof fieldValue !== "string") throw new Error(`invalid ${name}`);
  return fieldValue;
}

function integerField(value: JsonValue, name: string): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`missing ${name}`);
  }
  const fieldValue = value[name];
  if (typeof fieldValue !== "number" || !Number.isSafeInteger(fieldValue)) {
    throw new Error(`invalid ${name}`);
  }
  return fieldValue;
}

function firstObject(value: JsonValue, name: string): JsonValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`missing ${name}`);
  }
  const fieldValue = value[name];
  if (!Array.isArray(fieldValue) || fieldValue.length !== 1 || fieldValue[0] === undefined) {
    throw new Error(`invalid ${name}`);
  }
  return fieldValue[0];
}

function uploadReceipt(value: JsonValue): string {
  const url = new URL(field(value, "upload_url"), "https://preview.example.test");
  const receipt = url.hash.slice("#receipt=".length);
  if (!/^[0-9a-f-]{36}$/u.test(receipt)) throw new Error("invalid upload receipt");
  return receipt;
}

function syntheticEnvelope(): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce.fill(7);
  const ciphertextAndTag = new Uint8Array(48);
  ciphertextAndTag.fill(11);
  return encodeEnvelope(
    {
      schema_version: PROTOCOL_VERSION,
      content_encryption: "A256GCM",
      nonce: base64UrlEncode(nonce),
      media_type: "audio/wav",
    },
    ciphertextAndTag,
  );
}
