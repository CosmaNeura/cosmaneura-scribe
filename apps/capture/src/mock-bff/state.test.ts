import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { MockBffError, MockCaptureService, MockDroppedResponseError } from "./state";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("MockCaptureService", () => {
  it("gates a lease on consent, session creation, and an immutable key receipt", () => {
    const service = new MockCaptureService();
    expect(() =>
      service.issueLease({ protocol_version: "1.0" }, "lease-key-00000001"),
    ).toThrowError(new MockBffError(409, "audio_key_required"));

    const consent = service.createConsent({
      appointment_id: "synthetic-appointment",
      practitioner_id: "synthetic-practitioner",
      patient_id: "synthetic-patient",
      modality: "in_person",
      method: "verbal_attestation",
      all_parties_consented: true,
      participant_regions: ["US-NY"],
      granted_at: "2026-08-18T12:00:00.000Z",
      evidence_object_id: null,
    }, "consent-key-000001");
    const session = service.createSession({
      appointment_id: consent.appointment_id,
      practitioner_id: consent.practitioner_id,
      patient_id: consent.patient_id,
      consent_record_id: consent.id,
      modality: consent.modality,
    }, "session-key-000001");
    const published = service.audioEncryptionKey();
    service.bindSessionAudioKey(session.id, {
      key_version: published.key_version,
      wrapped_dek: "a".repeat(512),
    }, "bind-key-0000001");

    expect(
      service.issueLease({ protocol_version: "1.0" }, "lease-key-00000002"),
    ).toMatchObject({ session_id: session.id, generation: 1 });
  });

  it("replays a committed mutation after a synthetic lost response", () => {
    const service = createService();
    service.enqueueFault({ operation: "issue-lease", phase: "after-commit" });

    expect(() =>
      service.issueLease({ protocol_version: "1.0" }, "lease-idempotency-0001"),
    ).toThrow(MockDroppedResponseError);

    const replay = service.issueLease(
      { protocol_version: "1.0" },
      "lease-idempotency-0001",
    );
    expect(replay.generation).toBe(1);
    expect(replay.session_id).toBe(SESSION_ID);
  });

  it("converges different reservation keys on one object and authoritative AAD", () => {
    const service = createService();
    const lease = service.issueLease({ protocol_version: "1.0" }, "lease-key-00000001");
    const request = {
      protocol_version: "1.0" as const,
      capture_lease_id: lease.lease_id,
      capture_lease_generation: lease.generation,
      channel: "microphone" as const,
      first_sequence_number: 0,
      count: 1,
    };

    const first = service.reserveChunks(request, "reserve-key-000001");
    const second = service.reserveChunks(request, "reserve-key-000002");

    expect(second.reservations).toEqual(first.reservations);
    expect(JSON.stringify(first)).not.toContain("22222222-2222-4222-8222-222222222222");
  });

  it("refreshes an expired credential without changing object or AAD", () => {
    let now = new Date("2026-08-17T12:00:00.000Z");
    const service = createService(() => now);
    const lease = service.issueLease({ protocol_version: "1.0" }, "lease-key-00000001");
    const reservation = service.reserveChunks(
      {
        protocol_version: "1.0",
        capture_lease_id: lease.lease_id,
        capture_lease_generation: lease.generation,
        channel: "microphone",
        first_sequence_number: 0,
        count: 1,
      },
      "reserve-key-000001",
    ).reservations[0];
    expect(reservation).toBeDefined();
    const objectId = reservation?.object_id ?? "";
    const first = service.authorizeUpload(
      objectId,
      { protocol_version: "1.0" },
      "authorize-key-0001",
    );

    expect(() =>
      service.authorizeUpload(
        objectId,
        { protocol_version: "1.0" },
        "authorize-key-0002",
      ),
    ).toThrowError(new MockBffError(409, "upload_authorization_active"));

    now = new Date(first.expires_at);
    const refreshed = service.authorizeUpload(
      objectId,
      { protocol_version: "1.0" },
      "authorize-key-0003",
    );
    expect(refreshed.object_id).toBe(first.object_id);
    expect(refreshed.additional_authenticated_data).toBe(
      first.additional_authenticated_data,
    );
    expect(refreshed.authorization_receipt_id).not.toBe(first.authorization_receipt_id);
  });

  it("runs a synthetic reservation-to-receipt flow without exposing tenant context", () => {
    const service = createService();
    const lease = service.issueLease({ protocol_version: "1.0" }, "lease-key-00000001");
    const reservation = service.reserveChunks(
      {
        protocol_version: "1.0",
        capture_lease_id: lease.lease_id,
        capture_lease_generation: lease.generation,
        channel: "microphone",
        first_sequence_number: 0,
        count: 1,
      },
      "reserve-key-000001",
    ).reservations[0];
    expect(reservation).toBeDefined();
    const objectId = reservation?.object_id ?? "";
    const authorization = service.authorizeUpload(
      objectId,
      { protocol_version: "1.0" },
      "authorize-key-0001",
    );
    const uploadUrl = new URL(authorization.upload_url);
    const envelope = new Uint8Array([1, 2, 3, 4]);
    service.putEnvelope(objectId, uploadUrl.searchParams.get("receipt") ?? "", envelope);
    const registered = service.registerChunk(
      {
        sequence_number: 0,
        channel: "microphone",
        object_id: objectId,
        sha256: createHash("sha256").update(envelope).digest("hex"),
        ciphertext_size_bytes: envelope.byteLength,
      },
      "register-key-00001",
    );

    const receipt = service.chunkReceipt(objectId);
    expect(receipt.state).toBe("registered");
    expect(receipt.registration?.chunk_id).toBe(registered.id);
    expect(
      service.completeCapture(
        {
          protocol_version: "1.0",
          capture_lease_id: lease.lease_id,
          capture_lease_generation: lease.generation,
          channels: [{ channel: "microphone", final_sequence_number: 0 }],
        },
        "complete-key-00001",
      ).status,
    ).toBe("uploaded");
  });
});

function createService(now?: () => Date): MockCaptureService {
  let identifier = 1;
  return new MockCaptureService({
    sessionId: SESSION_ID,
    requirePreparation: false,
    ...(now === undefined ? {} : { now }),
    idFactory: () =>
      `00000000-0000-4000-8000-${String(identifier++).padStart(12, "0")}`,
  });
}
