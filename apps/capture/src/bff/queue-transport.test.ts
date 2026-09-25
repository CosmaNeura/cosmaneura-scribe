import { describe, expect, it, vi } from "vitest";

import type { CaptureBff, CiphertextUploadTarget } from "./contracts";
import { BffResponseError } from "./http-client";
import { BffCaptureQueueTransport } from "./queue-transport";
import { HttpCiphertextUploadTarget, UploadResponseError } from "./upload-target";

describe("BffCaptureQueueTransport", () => {
  it.each([
    ["2026-08-17T12:00:00Z", "2026-08-17T12:00:00.000000Z", true],
    ["2026-08-17T08:00:00.123-04:00", "2026-08-17T12:00:00.123000Z", true],
    ["2026-08-18T00:00:00.000001+02:00", "2026-08-17T22:00:00.000001Z", true],
    ["2026-08-17T12:00:00.123001Z", "2026-08-17T12:00:00.123000Z", false],
    ["invalid", "invalid", false],
    ["2026-02-30T12:00:00Z", "2026-02-30T12:00:00Z", false],
    ["2026-08-17T24:00:00Z", "2026-08-17T24:00:00Z", false],
    ["2026-08-17T12:00:00.1230001Z", "2026-08-17T12:00:00.1230001Z", false],
  ])("compares reservation timestamps without losing microsecond identity: %s", async (remote, local, matches) => {
    const reservation = { ...testReservation(), createdAt: local };
    const getChunkReceipt = vi.fn<CaptureBff["getChunkReceipt"]>().mockResolvedValue({ state: "reserved", registration: null,
      reservation: { protocol_version: "1.0", object_id: reservation.objectId, session_id: reservation.sessionId,
        channel: reservation.channel, sequence_number: reservation.sequenceNumber,
        additional_authenticated_data: reservation.additionalAuthenticatedData, created_at: remote } });
    const transport = new BffCaptureQueueTransport(bffStub({ getChunkReceipt }), { putCompleteEnvelope: vi.fn() });
    if (matches) await expect(transport.getReceipt(reservation)).resolves.toEqual({ state: "reserved" });
    else await expect(transport.getReceipt(reservation)).rejects.toMatchObject({ code: "chunk_receipt_reservation_mismatch" });
  });

  it("normalizes receipts without exposing BFF transport details", async () => {
    const getChunkReceipt = vi.fn<CaptureBff["getChunkReceipt"]>().mockResolvedValue({
      state: "registered",
      reservation: {
        protocol_version: "1.0",
        object_id: "22222222-2222-4222-8222-222222222222",
        session_id: "11111111-1111-4111-8111-111111111111",
        channel: "microphone",
        sequence_number: 0,
        additional_authenticated_data: "c3ludGhldGlj",
        created_at: "2026-08-17T12:00:00Z",
      },
      registration: {
        chunk_id: "33333333-3333-4333-8333-333333333333",
        sha256: "A".repeat(64),
        ciphertext_size_bytes: 128,
        registered_at: "2026-08-17T12:01:00Z",
      },
    });
    const bff = bffStub({ getChunkReceipt });
    const transport = new BffCaptureQueueTransport(bff, {
      putCompleteEnvelope: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      transport.getReceipt(testReservation()),
    ).resolves.toEqual({
      state: "registered",
      registration: {
        chunkId: "33333333-3333-4333-8333-333333333333",
        sha256: "a".repeat(64),
        byteLength: 128,
        registeredAt: "2026-08-17T12:01:00Z",
      },
    });
  });

  it("passes an ephemeral upload URL directly to the non-persisting target", async () => {
    const authorizeUpload = vi.fn<CaptureBff["authorizeUpload"]>().mockResolvedValue({
      protocol_version: "1.0",
      authorization_receipt_id: "33333333-3333-4333-8333-333333333333",
      object_id: "22222222-2222-4222-8222-222222222222",
      additional_authenticated_data: "c3ludGhldGlj",
      upload_url: "https://upload.example.test/chunk?sig=synthetic",
      expires_at: "2026-08-17T12:15:00Z",
    });
    const bff = bffStub({ authorizeUpload });
    const putCompleteEnvelope = vi.fn<CiphertextUploadTarget["putCompleteEnvelope"]>()
      .mockResolvedValue(undefined);
    const uploadTarget: CiphertextUploadTarget = { putCompleteEnvelope };
    const transport = new BffCaptureQueueTransport(bff, uploadTarget);
    const authorization = await transport.authorizeUpload(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "authorization-key-0001",
    );
    const envelope = new Uint8Array([1, 2, 3]);

    await transport.upload(authorization.uploadUrl, envelope);

    expect(putCompleteEnvelope).toHaveBeenCalledWith(
      "https://upload.example.test/chunk?sig=synthetic",
      envelope,
      { signal: expect.any(AbortSignal) },
    );
  });

  it("maps upload throttling and expiry to fixed queue error classes", async () => {
    const putCompleteEnvelope = vi
      .fn<CiphertextUploadTarget["putCompleteEnvelope"]>()
      .mockRejectedValueOnce(new UploadResponseError(429, 21_000))
      .mockRejectedValueOnce(new UploadResponseError(403, null));
    const transport = new BffCaptureQueueTransport(
      bffStub(),
      { putCompleteEnvelope },
    );

    await expect(transport.upload("https://upload.invalid/one", new Uint8Array([1])))
      .rejects.toMatchObject({
        kind: "retryable",
        code: "upload_temporarily_unavailable",
        retryAfterMs: 21_000,
      });
    await expect(transport.upload("https://upload.invalid/two", new Uint8Array([2])))
      .rejects.toMatchObject({
        kind: "credential_expired",
        code: "upload_credential_expired",
      });
  });

  it("treats an ambiguous mutation failure as unknown success", async () => {
    const registerChunk = vi.fn<CaptureBff["registerChunk"]>().mockRejectedValue(
      new TypeError("synthetic network failure"),
    );
    const transport = new BffCaptureQueueTransport(
      bffStub({ registerChunk }),
      { putCompleteEnvelope: vi.fn().mockResolvedValue(undefined) },
    );

    await expect(
      transport.register({
        sessionId: "11111111-1111-4111-8111-111111111111",
        objectId: "22222222-2222-4222-8222-222222222222",
        channel: "microphone",
        sequenceNumber: 0,
        sha256: "a".repeat(64),
        byteLength: 128,
        idempotencyKey: "register-key-0001",
      }),
    ).rejects.toMatchObject({
      kind: "unknown_success",
      code: "bff_result_unknown",
    });
  });

  it("treats an unusable successful mutation response as unknown success", async () => {
    const registerChunk = vi.fn<CaptureBff["registerChunk"]>().mockRejectedValue(
      new BffResponseError(201, null, null, "synthetic invalid response body"),
    );
    const transport = new BffCaptureQueueTransport(
      bffStub({ registerChunk }),
      { putCompleteEnvelope: vi.fn().mockResolvedValue(undefined) },
    );

    await expect(transport.register(testRegistrationRequest())).rejects.toMatchObject({
      kind: "unknown_success",
      code: "bff_result_unknown",
    });
  });

  it("treats an unusable successful receipt response as retryable", async () => {
    const getChunkReceipt = vi.fn<CaptureBff["getChunkReceipt"]>().mockRejectedValue(
      new BffResponseError(200, null, null, "synthetic invalid response body"),
    );
    const transport = new BffCaptureQueueTransport(
      bffStub({ getChunkReceipt }),
      { putCompleteEnvelope: vi.fn().mockResolvedValue(undefined) },
    );

    await expect(transport.getReceipt(testReservation())).rejects.toMatchObject({
      kind: "retryable",
      code: "bff_temporarily_unavailable",
    });
  });

  it("terminalizes upload-target policy rejection before sending ciphertext", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const transport = new BffCaptureQueueTransport(
      bffStub(),
      new HttpCiphertextUploadTarget(
        ["https://upload.example.test"],
        fetchImplementation,
      ),
    );

    await expect(
      transport.upload("https://evil.example/chunk", new Uint8Array([1])),
    ).rejects.toMatchObject({
      kind: "terminal",
      code: "upload_target_rejected",
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("treats unexpected successful upload status as unknown success", async () => {
    const transport = new BffCaptureQueueTransport(
      bffStub(),
      new HttpCiphertextUploadTarget(
        ["https://upload.example.test"],
        vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 })),
      ),
    );

    await expect(
      transport.upload("https://upload.example.test/chunk", new Uint8Array([1])),
    ).rejects.toMatchObject({
      kind: "unknown_success",
      code: "upload_result_unknown",
    });
  });

  it("bounds a hung mutation and preserves its replay identity", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const registerChunk = vi.fn<CaptureBff["registerChunk"]>().mockImplementation(
        (_sessionId, _request, options) => {
          if (options.signal !== undefined) signals.push(options.signal);
          return new Promise<never>(() => undefined);
        },
      );
      const transport = new BffCaptureQueueTransport(
        bffStub({ registerChunk }),
        { putCompleteEnvelope: vi.fn().mockResolvedValue(undefined) },
        1_000,
      );
      const request = testRegistrationRequest();

      const first = expect(transport.register(request)).rejects.toMatchObject({
        kind: "unknown_success",
        code: "bff_result_unknown",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await first;
      expect(signals[0]?.aborted).toBe(true);

      const second = expect(transport.register(request)).rejects.toMatchObject({
        kind: "unknown_success",
        code: "bff_result_unknown",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await second;
      expect(signals[1]?.aborted).toBe(true);
      expect(registerChunk).toHaveBeenCalledTimes(2);
      expect(registerChunk.mock.calls[1]?.[0]).toBe(registerChunk.mock.calls[0]?.[0]);
      expect(registerChunk.mock.calls[1]?.[1]).toEqual(registerChunk.mock.calls[0]?.[1]);
      expect(registerChunk.mock.calls[1]?.[2].idempotencyKey).toBe(
        registerChunk.mock.calls[0]?.[2].idempotencyKey,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors BFF Retry-After and definite authorization expiry", async () => {
    const authorizeUpload = vi
      .fn<CaptureBff["authorizeUpload"]>()
      .mockRejectedValueOnce(new BffResponseError(503, "dependency_unavailable", 9_000))
      .mockRejectedValueOnce(new BffResponseError(409, "upload_authorization_expired", null));
    const transport = new BffCaptureQueueTransport(
      bffStub({ authorizeUpload }),
      { putCompleteEnvelope: vi.fn().mockResolvedValue(undefined) },
    );
    const invoke = () => transport.authorizeUpload(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "authorization-key-0001",
    );

    await expect(invoke()).rejects.toMatchObject({
      kind: "retryable",
      code: "bff_temporarily_unavailable",
      retryAfterMs: 9_000,
    });
    await expect(invoke()).rejects.toMatchObject({
      kind: "credential_expired",
      code: "upload_credential_expired",
    });
  });

  it("rejects a receipt for a different immutable reservation", async () => {
    const getChunkReceipt = vi.fn<CaptureBff["getChunkReceipt"]>().mockResolvedValue({
      state: "reserved",
      registration: null,
      reservation: {
        protocol_version: "1.0",
        object_id: "22222222-2222-4222-8222-222222222222",
        session_id: "11111111-1111-4111-8111-111111111111",
        channel: "microphone",
        sequence_number: 0,
        additional_authenticated_data: "different-aad",
        created_at: "2026-08-17T12:00:00Z",
      },
    });
    const transport = new BffCaptureQueueTransport(
      bffStub({ getChunkReceipt }),
      { putCompleteEnvelope: vi.fn().mockResolvedValue(undefined) },
    );

    await expect(transport.getReceipt(testReservation())).rejects.toMatchObject({
      kind: "terminal",
      code: "chunk_receipt_reservation_mismatch",
    });
  });

  it("rejects registration metadata for a different object", async () => {
    const registerChunk = vi.fn<CaptureBff["registerChunk"]>().mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      session_id: "11111111-1111-4111-8111-111111111111",
      object_id: "99999999-9999-4999-8999-999999999999",
      channel: "microphone",
      sequence_number: 0,
      sha256: "a".repeat(64),
      ciphertext_size_bytes: 128,
      registered_at: "2026-08-17T12:01:00Z",
    });
    const transport = new BffCaptureQueueTransport(
      bffStub({ registerChunk }),
      { putCompleteEnvelope: vi.fn().mockResolvedValue(undefined) },
    );

    await expect(
      transport.register({
        sessionId: "11111111-1111-4111-8111-111111111111",
        objectId: "22222222-2222-4222-8222-222222222222",
        channel: "microphone",
        sequenceNumber: 0,
        sha256: "a".repeat(64),
        byteLength: 128,
        idempotencyKey: "register-key-0001",
      }),
    ).rejects.toMatchObject({
      kind: "terminal",
      code: "registration_receipt_mismatch",
    });
  });
});

function testReservation() {
  return {
    protocolVersion: "1.0" as const,
    objectId: "22222222-2222-4222-8222-222222222222",
    sessionId: "11111111-1111-4111-8111-111111111111",
    channel: "microphone" as const,
    sequenceNumber: 0,
    additionalAuthenticatedData: "c3ludGhldGlj",
    createdAt: "2026-08-17T12:00:00Z",
  };
}

function testRegistrationRequest() {
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    objectId: "22222222-2222-4222-8222-222222222222",
    channel: "microphone" as const,
    sequenceNumber: 0,
    sha256: "a".repeat(64),
    byteLength: 128,
    idempotencyKey: "register-key-0001",
  };
}

function bffStub(overrides: Partial<CaptureBff> = {}): CaptureBff {
  return {
    getAudioEncryptionKey: vi.fn(),
    createConsent: vi.fn(),
    createSession: vi.fn(),
    bindSessionAudioKey: vi.fn(),
    getCapabilities: vi.fn(),
    issueLease: vi.fn(),
    renewLease: vi.fn(),
    reserveChunks: vi.fn(),
    authorizeUpload: vi.fn(),
    getChunkReceipt: vi.fn(),
    registerChunk: vi.fn(),
    completeCapture: vi.fn(),
    getTranscriptionStatus: vi.fn(),
    getTranscript: vi.fn(),
    ...overrides,
  };
}
