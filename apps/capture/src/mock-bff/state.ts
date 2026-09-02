import { createHash, randomUUID } from "node:crypto";

import {
  AUDIO_CHANNELS,
  AUDIO_ENCODING,
  CAPTURE_LEASE_TTL_SECONDS,
  MAX_AGGREGATE_PLAINTEXT_BYTES,
  MAX_CHUNKS,
  MAX_ENVELOPE_BYTES,
  MAX_RESERVATIONS_PER_BATCH,
  MEDIA_TYPE,
  PROTOCOL_VERSION,
  RESERVATION_PLAINTEXT_BUDGET_BYTES,
  RESERVATION_WINDOW_SECONDS,
  SAMPLE_RATE_HZ,
  TARGET_CHUNK_DURATION_MS,
  UPLOAD_CONCURRENCY,
  encodeChunkAdditionalDataBase64Url,
} from "@cosmaneura-scribe/capture-protocol";
import type { CaptureChannel } from "@cosmaneura-scribe/capture-protocol";
import {
  SYNTHETIC_KEY_VERSION,
  SYNTHETIC_PUBLIC_KEY,
} from "@cosmaneura-scribe/capture-preview-domain";

import type {
  AudioEncryptionPublicKey,
  AudioChunk,
  AudioChunkRegister,
  CaptureCapabilities,
  CaptureCompleteRequest,
  CaptureLeaseIssueRequest,
  CaptureLeaseReceipt,
  CaptureLeaseRenewRequest,
  CaptureSession,
  CaptureTranscriptionStatus,
  ChunkReceipt,
  ChunkReservationBatchReceipt,
  ChunkReservationBatchRequest,
  ChunkUploadAuthorization,
  ChunkUploadAuthorizationRequest,
  ConsentCreate,
  ConsentRecord,
  SessionAudioKeyCreate,
  SessionAudioKeyReceipt,
  SessionCreate,
  Transcript,
} from "../bff/contracts";

export type MockOperation =
  | "consent"
  | "session"
  | "bind-key"
  | "issue-lease"
  | "renew-lease"
  | "reserve"
  | "authorize"
  | "register"
  | "complete";

export type MockFaultPhase = "before-commit" | "after-commit";

export interface MockFault {
  readonly operation: MockOperation;
  readonly phase: MockFaultPhase;
}

export interface MockCaptureServiceOptions {
  readonly sessionId?: string;
  readonly tenantId?: string;
  readonly uploadOrigin?: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly requirePreparation?: boolean;
}

interface ReservationRecord {
  readonly objectId: string;
  readonly sessionId: string;
  readonly channel: CaptureChannel;
  readonly sequenceNumber: number;
  readonly additionalAuthenticatedData: string;
  readonly createdAt: string;
}

interface AuthorizationRecord {
  readonly receiptId: string;
  readonly objectId: string;
  readonly expiresAt: string;
}

interface RegistrationRecord {
  readonly chunkId: string;
  readonly objectId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly registeredAt: string;
}

interface IdempotencyRecord {
  readonly fingerprint: string;
  readonly response: unknown;
}

export class MockBffError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "MockBffError";
  }
}

export class MockDroppedResponseError extends Error {
  public constructor(public readonly operation: MockOperation) {
    super("synthetic response dropped after commit");
    this.name = "MockDroppedResponseError";
  }
}

export class MockCaptureService {
  public readonly sessionId: string;
  private readonly tenantId: string;
  private readonly uploadOrigin: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly requirePreparation: boolean;
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly reservationsByPosition = new Map<string, ReservationRecord>();
  private readonly reservationsByObject = new Map<string, ReservationRecord>();
  private readonly authorizations = new Map<string, AuthorizationRecord>();
  private readonly uploadedEnvelopes = new Map<string, Uint8Array>();
  private readonly registrations = new Map<string, RegistrationRecord>();
  private readonly faults: MockFault[] = [];
  private lease: CaptureLeaseReceipt | undefined;
  private consent: ConsentRecord | undefined;
  private session: CaptureSession | undefined;
  private audioKeyReceipt: SessionAudioKeyReceipt | undefined;
  private completed = false;
  private transcriptionPolls = 0;

  public constructor(options: MockCaptureServiceOptions = {}) {
    this.sessionId = options.sessionId ?? "11111111-1111-4111-8111-111111111111";
    this.tenantId = options.tenantId ?? "22222222-2222-4222-8222-222222222222";
    this.uploadOrigin = (options.uploadOrigin ?? "http://127.0.0.1:4174").replace(/\/$/u, "");
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.requirePreparation = options.requirePreparation ?? true;
  }

  public audioEncryptionKey(): AudioEncryptionPublicKey {
    return {
      key_version: SYNTHETIC_PUBLIC_KEY.key_version,
      algorithm: SYNTHETIC_PUBLIC_KEY.algorithm,
      public_jwk: {
        ...SYNTHETIC_PUBLIC_KEY.public_jwk,
        key_ops: ["wrapKey"],
      },
    };
  }

  public createConsent(request: ConsentCreate, idempotencyKey: string): ConsentRecord {
    return this.mutate("consent", idempotencyKey, request, () => {
      if (!request.all_parties_consented || request.modality !== "in_person") {
        throw new MockBffError(409, "consent_required");
      }
      this.consent = {
        ...request,
        id: this.idFactory(),
        policy_version: "synthetic-preview-v1",
        revoked_at: null,
      };
      return this.consent;
    });
  }

  public createSession(request: SessionCreate, idempotencyKey: string): CaptureSession {
    return this.mutate("session", idempotencyKey, request, () => {
      if (this.consent?.id !== request.consent_record_id) {
        throw new MockBffError(409, "consent_required");
      }
      this.resetSessionArtifacts();
      this.session = {
        id: this.sessionId,
        ...request,
        status: "created",
        created_at: this.now().toISOString(),
      };
      return this.session;
    });
  }

  public bindSessionAudioKey(
    sessionId: string,
    request: SessionAudioKeyCreate,
    idempotencyKey: string,
  ): SessionAudioKeyReceipt {
    return this.mutate("bind-key", idempotencyKey, { sessionId, ...request }, () => {
      if (sessionId !== this.session?.id) throw new MockBffError(404, "session_not_found");
      if (request.key_version !== SYNTHETIC_KEY_VERSION || request.wrapped_dek.length < 64) {
        throw new MockBffError(409, "audio_key_version_conflict");
      }
      this.audioKeyReceipt = {
        session_id: sessionId,
        key_version: request.key_version,
        created_at: this.now().toISOString(),
      };
      return this.audioKeyReceipt;
    });
  }

  public enqueueFault(fault: MockFault): void {
    this.faults.push(fault);
  }

  public capabilities(): CaptureCapabilities {
    const reservedBytes =
      this.reservationsByObject.size * RESERVATION_PLAINTEXT_BUDGET_BYTES;
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
      max_chunks: MAX_CHUNKS,
      remaining_aggregate_plaintext_bytes: Math.max(
        0,
        MAX_AGGREGATE_PLAINTEXT_BYTES - reservedBytes,
      ),
      capture_lease_ttl_seconds: CAPTURE_LEASE_TTL_SECONDS,
      reservation_window_seconds: RESERVATION_WINDOW_SECONDS,
      max_reservations_per_batch: MAX_RESERVATIONS_PER_BATCH,
      upload_concurrency: UPLOAD_CONCURRENCY,
    };
  }

  public issueLease(
    request: CaptureLeaseIssueRequest,
    idempotencyKey: string,
  ): CaptureLeaseReceipt {
    return this.mutate("issue-lease", idempotencyKey, request, () => {
      this.assertOpen();
      if (this.requirePreparation && this.audioKeyReceipt === undefined) {
        throw new MockBffError(409, "audio_key_required");
      }
      const issuedAt = this.now();
      this.lease = {
        protocol_version: PROTOCOL_VERSION,
        receipt_id: this.idFactory(),
        lease_id: this.idFactory(),
        session_id: this.sessionId,
        generation: 1,
        issued_at: issuedAt.toISOString(),
        expires_at: addSeconds(issuedAt, CAPTURE_LEASE_TTL_SECONDS).toISOString(),
      };
      return this.lease;
    });
  }

  public renewLease(
    leaseId: string,
    request: CaptureLeaseRenewRequest,
    idempotencyKey: string,
  ): CaptureLeaseReceipt {
    return this.mutate("renew-lease", idempotencyKey, request, () => {
      const lease = this.requireLease();
      this.assertOpen();
      if (lease.lease_id !== leaseId || lease.generation !== request.expected_generation) {
        throw new MockBffError(409, "capture_lease_generation_conflict");
      }
      const issuedAt = this.now();
      this.lease = {
        ...lease,
        receipt_id: this.idFactory(),
        generation: lease.generation + 1,
        issued_at: issuedAt.toISOString(),
        expires_at: addSeconds(issuedAt, CAPTURE_LEASE_TTL_SECONDS).toISOString(),
      };
      return this.lease;
    });
  }

  public reserveChunks(
    request: ChunkReservationBatchRequest,
    idempotencyKey: string,
  ): ChunkReservationBatchReceipt {
    return this.mutate("reserve", idempotencyKey, request, () => {
      const lease = this.requireActiveLease();
      this.assertOpen();
      if (
        lease.lease_id !== request.capture_lease_id ||
        lease.generation !== request.capture_lease_generation
      ) {
        throw new MockBffError(409, "capture_lease_generation_conflict");
      }
      if (request.count < 1 || request.count > MAX_RESERVATIONS_PER_BATCH) {
        throw new MockBffError(422, "reservation_batch_out_of_range");
      }
      if (this.reservationsByObject.size + request.count > MAX_CHUNKS) {
        throw new MockBffError(409, "capture_quota_exhausted");
      }

      const reservations: ChunkReservationBatchReceipt["reservations"] = [];
      for (let offset = 0; offset < request.count; offset += 1) {
        const sequenceNumber = request.first_sequence_number + offset;
        const position = `${request.channel}:${sequenceNumber}`;
        let reservation = this.reservationsByPosition.get(position);
        if (reservation === undefined) {
          const objectId = this.idFactory();
          reservation = {
            objectId,
            sessionId: this.sessionId,
            channel: request.channel,
            sequenceNumber,
            additionalAuthenticatedData: encodeChunkAdditionalDataBase64Url({
              tenantId: this.tenantId,
              sessionId: this.sessionId,
              objectId,
              sequenceNumber,
              channel: request.channel,
            }),
            createdAt: this.now().toISOString(),
          };
          this.reservationsByPosition.set(position, reservation);
          this.reservationsByObject.set(objectId, reservation);
        }
        reservations.push(toReservationResponse(reservation));
      }
      return {
        protocol_version: PROTOCOL_VERSION,
        batch_id: this.idFactory(),
        session_id: this.sessionId,
        capture_authorized_until: addSeconds(
          this.now(),
          RESERVATION_WINDOW_SECONDS,
        ).toISOString(),
        reservations,
      };
    });
  }

  public authorizeUpload(
    objectId: string,
    _request: ChunkUploadAuthorizationRequest,
    idempotencyKey: string,
  ): ChunkUploadAuthorization {
    return this.mutate("authorize", idempotencyKey, { objectId }, () => {
      this.assertOpen();
      const reservation = this.requireReservation(objectId);
      if (this.registrations.has(objectId)) {
        throw new MockBffError(409, "chunk_already_registered");
      }
      const existing = this.authorizations.get(objectId);
      if (existing !== undefined && new Date(existing.expiresAt) > this.now()) {
        throw new MockBffError(409, "upload_authorization_active");
      }
      const authorization: AuthorizationRecord = {
        receiptId: this.idFactory(),
        objectId,
        expiresAt: addSeconds(this.now(), CAPTURE_LEASE_TTL_SECONDS).toISOString(),
      };
      this.authorizations.set(objectId, authorization);
      return {
        protocol_version: PROTOCOL_VERSION,
        authorization_receipt_id: authorization.receiptId,
        object_id: objectId,
        additional_authenticated_data: reservation.additionalAuthenticatedData,
        upload_url: `${this.uploadOrigin}/mock-upload/${objectId}?receipt=${authorization.receiptId}`,
        expires_at: authorization.expiresAt,
      };
    });
  }

  public putEnvelope(objectId: string, receiptId: string, envelope: Uint8Array): void {
    const authorization = this.authorizations.get(objectId);
    if (
      authorization === undefined ||
      authorization.receiptId !== receiptId ||
      new Date(authorization.expiresAt) <= this.now()
    ) {
      throw new MockBffError(403, "upload_authorization_invalid");
    }
    if (envelope.byteLength === 0 || envelope.byteLength > MAX_ENVELOPE_BYTES) {
      throw new MockBffError(413, "envelope_size_invalid");
    }
    const existing = this.uploadedEnvelopes.get(objectId);
    if (existing !== undefined && !bytesEqual(existing, envelope)) {
      throw new MockBffError(409, "immutable_envelope_conflict");
    }
    this.uploadedEnvelopes.set(objectId, envelope.slice());
  }

  public registerChunk(
    request: AudioChunkRegister,
    idempotencyKey: string,
  ): AudioChunk {
    return this.mutate("register", idempotencyKey, request, () => {
      this.assertOpen();
      const reservation = this.requireReservation(request.object_id);
      const envelope = this.uploadedEnvelopes.get(request.object_id);
      if (envelope === undefined) {
        throw new MockBffError(409, "chunk_not_uploaded");
      }
      const digest = createHash("sha256").update(envelope).digest("hex");
      if (
        request.sequence_number !== reservation.sequenceNumber ||
        request.channel !== reservation.channel ||
        request.ciphertext_size_bytes !== envelope.byteLength ||
        request.sha256.toLowerCase() !== digest
      ) {
        throw new MockBffError(409, "immutable_chunk_conflict");
      }
      const record: RegistrationRecord = {
        chunkId: this.idFactory(),
        objectId: request.object_id,
        sha256: digest,
        byteLength: envelope.byteLength,
        registeredAt: this.now().toISOString(),
      };
      this.registrations.set(request.object_id, record);
      return {
        ...request,
        id: record.chunkId,
        session_id: this.sessionId,
        registered_at: record.registeredAt,
      };
    });
  }

  public chunkReceipt(objectId: string): ChunkReceipt {
    const reservation = this.requireReservation(objectId);
    const registration = this.registrations.get(objectId);
    return {
      reservation: toReservationResponse(reservation),
      state: registration === undefined ? "reserved" : "registered",
      registration:
        registration === undefined
          ? null
          : {
              chunk_id: registration.chunkId,
              sha256: registration.sha256,
              ciphertext_size_bytes: registration.byteLength,
              registered_at: registration.registeredAt,
            },
    };
  }

  public completeCapture(
    request: CaptureCompleteRequest,
    idempotencyKey: string,
  ): CaptureSession {
    return this.mutate("complete", idempotencyKey, request, () => {
      const lease = this.requireLease();
      this.assertOpen();
      if (
        lease.lease_id !== request.capture_lease_id ||
        lease.generation !== request.capture_lease_generation
      ) {
        throw new MockBffError(409, "capture_lease_generation_conflict");
      }
      for (const channel of request.channels) {
        for (let sequence = 0; sequence <= channel.final_sequence_number; sequence += 1) {
          const reservation = this.reservationsByPosition.get(`${channel.channel}:${sequence}`);
          if (reservation === undefined || !this.registrations.has(reservation.objectId)) {
            throw new MockBffError(409, "capture_sequence_incomplete");
          }
        }
      }
      this.completed = true;
      this.session = {
        id: this.sessionId,
        appointment_id: this.session?.appointment_id ?? "synthetic-appointment",
        practitioner_id: this.session?.practitioner_id ?? "synthetic-practitioner",
        patient_id: this.session?.patient_id ?? "synthetic-patient",
        consent_record_id:
          this.session?.consent_record_id ?? "33333333-3333-4333-8333-333333333333",
        modality: this.session?.modality ?? "in_person",
        status: "uploaded",
        created_at: this.session?.created_at ?? this.now().toISOString(),
      };
      return this.session;
    });
  }

  public transcriptionStatus(): CaptureTranscriptionStatus {
    if (!this.completed) {
      return {
        session_id: this.sessionId,
        status: "not_requested",
        transcript_available: false,
        updated_at: this.now().toISOString(),
      };
    }
    this.transcriptionPolls += 1;
    const ready = this.transcriptionPolls >= 2;
    return {
      session_id: this.sessionId,
      status: ready ? "completed" : "processing",
      transcript_available: ready,
      updated_at: this.now().toISOString(),
    };
  }

  public transcript(): Transcript {
    if (!this.completed || this.transcriptionPolls < 2) {
      throw new MockBffError(404, "transcript_not_ready");
    }
    return {
      id: "77777777-7777-4777-8777-777777777777",
      session_id: this.sessionId,
      language_code: "en-US",
      stt_provider: "synthetic-preview",
      created_at: this.now().toISOString(),
      segments: [
        {
          speaker_id: "synthetic-clinician",
          speaker_role: "clinician",
          content: "Synthetic transcript content for preview only.",
          start_ms: 0,
          end_ms: 1_000,
          confidence: 1,
        },
      ],
    };
  }

  private mutate<Response, Request>(
    operation: MockOperation,
    idempotencyKey: string,
    request: Request,
    mutation: () => Response,
  ): Response {
    const key = `${operation}:${idempotencyKey}`;
    const fingerprint = JSON.stringify(request);
    const existing = this.idempotency.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new MockBffError(409, "idempotency_conflict");
      }
      return structuredClone(existing.response) as Response;
    }
    this.consumeFault(operation, "before-commit");
    const response = mutation();
    this.idempotency.set(key, { fingerprint, response: structuredClone(response) });
    this.consumeFault(operation, "after-commit");
    return structuredClone(response);
  }

  private consumeFault(operation: MockOperation, phase: MockFaultPhase): void {
    const index = this.faults.findIndex(
      (fault) => fault.operation === operation && fault.phase === phase,
    );
    if (index === -1) return;
    this.faults.splice(index, 1);
    if (phase === "after-commit") throw new MockDroppedResponseError(operation);
    throw new MockBffError(503, "synthetic_dependency_unavailable");
  }

  private resetSessionArtifacts(): void {
    // The standalone E2E server reuses one deterministic ID across browser contexts.
    this.lease = undefined;
    this.audioKeyReceipt = undefined;
    this.completed = false;
    this.transcriptionPolls = 0;
    this.reservationsByPosition.clear();
    this.reservationsByObject.clear();
    this.authorizations.clear();
    this.uploadedEnvelopes.clear();
    this.registrations.clear();
  }

  private requireLease(): CaptureLeaseReceipt {
    if (this.lease === undefined) throw new MockBffError(409, "capture_lease_required");
    return this.lease;
  }

  private requireActiveLease(): CaptureLeaseReceipt {
    const lease = this.requireLease();
    if (new Date(lease.expires_at) <= this.now()) {
      throw new MockBffError(409, "capture_lease_expired");
    }
    return lease;
  }

  private requireReservation(objectId: string): ReservationRecord {
    const reservation = this.reservationsByObject.get(objectId);
    if (reservation === undefined) throw new MockBffError(404, "chunk_not_found");
    return reservation;
  }

  private assertOpen(): void {
    if (this.completed) throw new MockBffError(409, "session_closed");
  }
}

function addSeconds(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * 1_000);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function toReservationResponse(
  reservation: ReservationRecord,
): ChunkReservationBatchReceipt["reservations"][number] {
  return {
    protocol_version: PROTOCOL_VERSION,
    object_id: reservation.objectId,
    session_id: reservation.sessionId,
    channel: reservation.channel,
    sequence_number: reservation.sequenceNumber,
    additional_authenticated_data: reservation.additionalAuthenticatedData,
    created_at: reservation.createdAt,
  };
}
