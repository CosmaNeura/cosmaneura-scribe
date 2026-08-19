import { createHash, randomUUID } from "node:crypto";

import {
  CAPTURE_LEASE_TTL_SECONDS,
  MAX_ENVELOPE_BYTES,
  PROTOCOL_VERSION,
  RESERVATION_WINDOW_SECONDS,
  encodeChunkAdditionalDataBase64Url,
  parseEnvelope,
} from "@cosmaneura-scribe/capture-protocol";

import {
  HOSTED_MAX_CHUNKS,
  PREVIEW_ENVELOPE_TTL_SECONDS,
  PREVIEW_TTL_SECONDS,
  SYNTHETIC_APPOINTMENT_ID,
  SYNTHETIC_KEY_VERSION,
  SYNTHETIC_PATIENT_ID,
  SYNTHETIC_PRACTITIONER_ID,
  SYNTHETIC_PUBLIC_KEY,
  hostedCapabilities,
} from "./constants";
import {
  PREVIEW_SCHEMA_VERSION,
  PREVIEW_STATE_ID,
  PreviewRepositoryConflictError,
  previewEnvelopeId,
  validatePreviewEnvelope,
  validatePreviewScopeState,
  type JsonObject,
  type JsonValue,
  type PreviewEnvelope,
  type PreviewRepository,
  type PreviewScopeState,
  type StoredAuditEvent,
  type StoredReservation,
} from "./repository";
import {
  PreviewValidationError,
  parseAudioKey,
  parseCompletion,
  parseConsent,
  parseProtocolOnly,
  parseRegistration,
  parseRenewal,
  parseReservation,
  parseSession,
  requireUuid,
} from "./validation";

const MAX_CONDITIONAL_RETRIES = 8;
const MAX_IDEMPOTENCY_RECORDS = 64;
const MAX_AUDIT_RECORDS = 72;
const DEFAULT_MAX_NEW_SCOPES_PER_DAY = 250;

export interface PreviewCaptureDomainOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly ttlSeconds?: number;
  readonly maxNewScopesPerDay?: number;
}

export class PreviewDomainError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "PreviewDomainError";
  }
}

interface MutationStorageOptions {
  readonly storedResponse?: (response: JsonValue) => JsonValue;
  readonly replayResponse?: (
    state: PreviewScopeState,
    storedResponse: JsonValue,
  ) => JsonValue;
}

export class PreviewCaptureDomain {
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #ttlSeconds: number;
  readonly #maxNewScopesPerDay: number;

  public constructor(
    private readonly repository: PreviewRepository,
    options: PreviewCaptureDomainOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#ttlSeconds = options.ttlSeconds ?? PREVIEW_TTL_SECONDS;
    this.#maxNewScopesPerDay =
      options.maxNewScopesPerDay ?? DEFAULT_MAX_NEW_SCOPES_PER_DAY;
    if (!Number.isSafeInteger(this.#ttlSeconds) || this.#ttlSeconds < 900) {
      throw new Error("preview TTL is invalid");
    }
    if (
      !Number.isSafeInteger(this.#maxNewScopesPerDay) ||
      this.#maxNewScopesPerDay < 1 ||
      this.#maxNewScopesPerDay > 10_000
    ) {
      throw new Error("preview daily scope limit is invalid");
    }
  }

  public async bootstrap(scopeId: string): Promise<void> {
    let claimedCapacity = false;
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      const existing = await this.repository.readScope(scopeId);
      try {
        if (existing === null) {
          if (!claimedCapacity) {
            claimedCapacity = await this.repository.claimBootstrapSlot(
              this.#now().toISOString().slice(0, 10),
              this.#maxNewScopesPerDay,
            );
            if (!claimedCapacity) {
              throw new PreviewDomainError(429, "preview_daily_capacity_exhausted");
            }
          }
          await this.repository.createScope(
            validatePreviewScopeState(this.createInitialState(scopeId), scopeId),
          );
        } else {
          // Replacing the unchanged bounded state refreshes Cosmos item TTL in step with
          // the refreshed browser cookie without changing any domain receipt.
          await this.repository.replaceScope(
            validatePreviewScopeState(existing.state, scopeId),
            existing.etag,
          );
        }
        return;
      } catch (error) {
        if (!(error instanceof PreviewRepositoryConflictError)) throw error;
      }
    }
    throw new PreviewDomainError(409, "preview_state_conflict");
  }

  private createInitialState(scopeId: string): PreviewScopeState {
    const recordedAt = this.#now().toISOString();
    const bootstrapAuditKey = auditKey("bootstrap", scopeId);
    return {
      id: PREVIEW_STATE_ID,
      scopeId,
      kind: "capture-preview-state",
      schemaVersion: PREVIEW_SCHEMA_VERSION,
      ttl: this.#ttlSeconds,
      tenantId: this.#idFactory(),
      sessionId: this.#idFactory(),
      consent: null,
      session: null,
      audioKeyReceipt: null,
      lease: null,
      audit: {
        [bootstrapAuditKey]: { operation: "bootstrap", recordedAt },
      },
      reservations: {},
      authorizations: {},
      registrations: {},
      idempotency: {},
      completed: false,
      transcriptionPolls: 0,
    };
  }

  public async health(): Promise<void> {
    await this.repository.health();
  }

  public async audioEncryptionKey(scopeId: string): Promise<JsonValue> {
    await this.requireScope(scopeId);
    return structuredClone(SYNTHETIC_PUBLIC_KEY) as unknown as JsonValue;
  }

  public async createConsent(
    scopeId: string,
    input: JsonValue,
    idempotencyKey: string,
  ): Promise<JsonValue> {
    const request = parseConsent(input);
    return this.mutate(scopeId, "consent", "consents", idempotencyKey, request, (state) => {
      this.assertOpen(state);
      if (state.consent !== null) {
        throw new PreviewDomainError(409, "consent_already_recorded");
      }
      const response: JsonObject = {
        ...request,
        id: this.#idFactory(),
        policy_version: "synthetic-preview-v1",
        revoked_at: null,
      };
      state.consent = response;
      return response;
    });
  }

  public async createSession(
    scopeId: string,
    input: JsonValue,
    idempotencyKey: string,
  ): Promise<JsonValue> {
    return this.mutate(scopeId, "session", "sessions", idempotencyKey, input, (state) => {
      this.assertOpen(state);
      if (state.session !== null) {
        throw new PreviewDomainError(409, "session_already_created");
      }
      const consent = state.consent;
      if (consent === null || typeof consent.id !== "string") {
        throw new PreviewDomainError(409, "consent_required");
      }
      const request = parseSession(input, consent.id);
      const response: JsonObject = {
        id: state.sessionId,
        ...request,
        status: "created",
        created_at: this.#now().toISOString(),
      };
      state.session = response;
      return response;
    });
  }

  public async bindAudioKey(
    scopeId: string,
    sessionId: string,
    input: JsonValue,
    idempotencyKey: string,
  ): Promise<JsonValue> {
    const request = parseAudioKey(input);
    return this.mutate(scopeId, "bind-key", sessionId, idempotencyKey, request, (state) => {
      this.assertSession(state, sessionId);
      this.assertOpen(state);
      if (state.audioKeyReceipt !== null) {
        throw new PreviewDomainError(409, "audio_key_already_bound");
      }
      const response: JsonObject = {
        session_id: state.sessionId,
        key_version: SYNTHETIC_KEY_VERSION,
        created_at: this.#now().toISOString(),
      };
      state.audioKeyReceipt = response;
      return response;
    });
  }

  public async capabilities(scopeId: string, sessionId: string): Promise<JsonValue> {
    const state = await this.requireScope(scopeId);
    this.assertSession(state, sessionId);
    return hostedCapabilities(Object.keys(state.reservations).length);
  }

  public async issueLease(
    scopeId: string,
    sessionId: string,
    input: JsonValue,
    idempotencyKey: string,
  ): Promise<JsonValue> {
    const request = parseProtocolOnly(input);
    return this.mutate(scopeId, "issue-lease", sessionId, idempotencyKey, request, (state) => {
      this.assertSession(state, sessionId);
      this.assertOpen(state);
      if (state.audioKeyReceipt === null) {
        throw new PreviewDomainError(409, "audio_key_required");
      }
      if (state.lease !== null) {
        throw new PreviewDomainError(409, "capture_lease_already_issued");
      }
      const issuedAt = this.#now();
      const response: JsonObject = {
        protocol_version: PROTOCOL_VERSION,
        receipt_id: this.#idFactory(),
        lease_id: this.#idFactory(),
        session_id: state.sessionId,
        generation: 1,
        issued_at: issuedAt.toISOString(),
        expires_at: addSeconds(issuedAt, CAPTURE_LEASE_TTL_SECONDS).toISOString(),
      };
      state.lease = response;
      return response;
    });
  }

  public async renewLease(
    scopeId: string,
    sessionId: string,
    leaseId: string,
    input: JsonValue,
    idempotencyKey: string,
  ): Promise<JsonValue> {
    requireUuid(leaseId);
    const request = parseRenewal(input);
    return this.mutate(
      scopeId,
      "renew-lease",
      `${sessionId}:${leaseId}`,
      idempotencyKey,
      request,
      (state) => {
      this.assertSession(state, sessionId);
      this.assertOpen(state);
      const lease = this.requireLease(state);
      if (
        lease.lease_id !== leaseId ||
        lease.generation !== request.expected_generation
      ) {
        throw new PreviewDomainError(409, "capture_lease_generation_conflict");
      }
      const issuedAt = this.#now();
      const response: JsonObject = {
        ...lease,
        receipt_id: this.#idFactory(),
        generation: (lease.generation as number) + 1,
        issued_at: issuedAt.toISOString(),
        expires_at: addSeconds(issuedAt, CAPTURE_LEASE_TTL_SECONDS).toISOString(),
      };
      state.lease = response;
      return response;
      },
    );
  }

  public async reserveChunks(
    scopeId: string,
    sessionId: string,
    input: JsonValue,
    idempotencyKey: string,
  ): Promise<JsonValue> {
    const request = parseReservation(input);
    return this.mutate(scopeId, "reserve", sessionId, idempotencyKey, request, (state) => {
      this.assertSession(state, sessionId);
      this.assertOpen(state);
      const lease = this.requireActiveLease(state);
      if (
        lease.lease_id !== request.capture_lease_id ||
        lease.generation !== request.capture_lease_generation
      ) {
        throw new PreviewDomainError(409, "capture_lease_generation_conflict");
      }
      const currentCount = Object.keys(state.reservations).length;
      let additions = 0;
      for (let offset = 0; offset < request.count; offset += 1) {
        const key = positionKey(request.first_sequence_number + offset);
        if (state.reservations[key] === undefined) additions += 1;
      }
      if (currentCount + additions > HOSTED_MAX_CHUNKS) {
        throw new PreviewDomainError(409, "capture_quota_exhausted");
      }
      const reservations: JsonValue[] = [];
      for (let offset = 0; offset < request.count; offset += 1) {
        const sequenceNumber = request.first_sequence_number + offset;
        const key = positionKey(sequenceNumber);
        let reservation = state.reservations[key];
        if (reservation === undefined) {
          const objectId = this.#idFactory();
          reservation = {
            objectId,
            channel: "microphone",
            sequenceNumber,
            additionalAuthenticatedData: encodeChunkAdditionalDataBase64Url({
              tenantId: state.tenantId,
              sessionId: state.sessionId,
              objectId,
              sequenceNumber,
              channel: "microphone",
            }),
            createdAt: this.#now().toISOString(),
          };
          state.reservations[key] = reservation;
        }
        reservations.push(reservationResponse(state, reservation));
      }
      return {
        protocol_version: PROTOCOL_VERSION,
        batch_id: this.#idFactory(),
        session_id: state.sessionId,
        capture_authorized_until: addSeconds(
          this.#now(),
          RESERVATION_WINDOW_SECONDS,
        ).toISOString(),
        reservations,
      };
    });
  }

  public async authorizeUpload(
    scopeId: string,
    sessionId: string,
    objectId: string,
    input: JsonValue,
    idempotencyKey: string,
  ): Promise<JsonValue> {
    requireUuid(objectId);
    const request = parseProtocolOnly(input);
    const receiptId = deriveReceiptId(scopeId, sessionId, objectId, idempotencyKey);
    const receiptSha256 = hashUploadReceipt(receiptId);
    return this.mutate(
      scopeId,
      "authorize",
      `${sessionId}:${objectId}`,
      idempotencyKey,
      request,
      (state) => {
      this.assertSession(state, sessionId);
      this.assertOpen(state);
      const reservation = requireReservation(state, objectId);
      if (state.registrations[objectId] !== undefined) {
        throw new PreviewDomainError(409, "chunk_already_registered");
      }
      const current = state.authorizations[objectId];
      if (current !== undefined && Date.parse(current.expiresAt) > this.#now().getTime()) {
        throw new PreviewDomainError(409, "upload_authorization_active");
      }
      const expiresAt = addSeconds(this.#now(), CAPTURE_LEASE_TTL_SECONDS).toISOString();
      state.authorizations[objectId] = { receiptSha256, expiresAt };
      return uploadAuthorizationResponse(
        scopeId,
        objectId,
        receiptId,
        expiresAt,
        reservation,
      );
      },
      {
        storedResponse: () => ({ authorization_recorded: true }),
        replayResponse: (state) => {
          this.assertSession(state, sessionId);
          this.assertOpen(state);
          const reservation = requireReservation(state, objectId);
          const authorization = state.authorizations[objectId];
          if (
            authorization === undefined ||
            authorization.receiptSha256 !== receiptSha256 ||
            Date.parse(authorization.expiresAt) <= this.#now().getTime() ||
            state.registrations[objectId] !== undefined
          ) {
            throw new PreviewDomainError(409, "upload_authorization_expired");
          }
          return uploadAuthorizationResponse(
            scopeId,
            objectId,
            receiptId,
            authorization.expiresAt,
            reservation,
          );
        },
      },
    );
  }

  public async putEnvelope(
    scopeId: string,
    objectId: string,
    receiptId: string,
    bytes: Uint8Array,
  ): Promise<void> {
    requireUuid(objectId);
    requireUuid(receiptId);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ENVELOPE_BYTES) {
      throw new PreviewDomainError(413, "envelope_size_invalid");
    }
    try {
      parseEnvelope(bytes);
    } catch {
      throw new PreviewDomainError(422, "envelope_invalid");
    }
    const state = await this.requireScope(scopeId);
    if (state.completed) throw new PreviewDomainError(409, "session_closed");
    if (state.registrations[objectId] !== undefined) {
      throw new PreviewDomainError(409, "chunk_already_registered");
    }
    const authorization = state.authorizations[objectId];
    if (
      authorization === undefined ||
      authorization.receiptSha256 !== hashUploadReceipt(receiptId) ||
      Date.parse(authorization.expiresAt) <= this.#now().getTime()
    ) {
      throw new PreviewDomainError(403, "upload_authorization_invalid");
    }
    requireReservation(state, objectId);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const envelope: PreviewEnvelope = {
      id: previewEnvelopeId(objectId),
      scopeId,
      kind: "capture-preview-envelope",
      schemaVersion: PREVIEW_SCHEMA_VERSION,
      ttl: PREVIEW_ENVELOPE_TTL_SECONDS,
      objectId,
      bytesBase64: Buffer.from(bytes).toString("base64"),
      sha256,
      byteLength: bytes.byteLength,
      uploadedAt: this.#now().toISOString(),
    };
    try {
      await this.repository.createEnvelope(
        validatePreviewEnvelope(envelope, scopeId, objectId),
      );
    } catch (error) {
      if (!(error instanceof PreviewRepositoryConflictError)) throw error;
      const existing = await this.repository.readEnvelope(scopeId, objectId);
      if (
        existing === null ||
        existing.sha256 !== sha256 ||
        existing.byteLength !== bytes.byteLength ||
        existing.bytesBase64 !== envelope.bytesBase64
      ) {
        throw new PreviewDomainError(409, "immutable_envelope_conflict");
      }
    }
    const latest = await this.requireScope(scopeId);
    const latestAuthorization = latest.authorizations[objectId];
    if (
      latest.completed ||
      latest.registrations[objectId] !== undefined ||
      latestAuthorization === undefined ||
      latestAuthorization.receiptSha256 !== hashUploadReceipt(receiptId) ||
      Date.parse(latestAuthorization.expiresAt) <= this.#now().getTime()
    ) {
      await this.repository.deleteEnvelope(scopeId, objectId);
      throw new PreviewDomainError(409, "upload_authorization_stale");
    }
    try {
      await this.recordAudit(scopeId, "upload", `${objectId}:${sha256}`);
    } catch (error) {
      await this.repository.deleteEnvelope(scopeId, objectId);
      throw error;
    }
  }

  public async registerChunk(
    scopeId: string,
    sessionId: string,
    input: JsonValue,
    idempotencyKey: string,
  ): Promise<JsonValue> {
    const request = parseRegistration(input, MAX_ENVELOPE_BYTES);
    const response = await this.mutate(
      scopeId,
      "register",
      `${sessionId}:${request.object_id}`,
      idempotencyKey,
      request,
      async (state) => {
      this.assertSession(state, sessionId);
      this.assertOpen(state);
      const reservation = requireReservation(state, request.object_id);
      if (state.registrations[request.object_id] !== undefined) {
        throw new PreviewDomainError(409, "chunk_already_registered");
      }
      const envelope = await this.repository.readEnvelope(scopeId, request.object_id);
      if (envelope === null) throw new PreviewDomainError(409, "chunk_not_uploaded");
      if (
        request.sequence_number !== reservation.sequenceNumber ||
        request.channel !== reservation.channel ||
        request.ciphertext_size_bytes !== envelope.byteLength ||
        request.sha256 !== envelope.sha256
      ) {
        throw new PreviewDomainError(409, "immutable_chunk_conflict");
      }
      const registration = {
        chunkId: this.#idFactory(),
        sha256: envelope.sha256,
        byteLength: envelope.byteLength,
        registeredAt: this.#now().toISOString(),
      };
      state.registrations[request.object_id] = registration;
      return {
        ...request,
        id: registration.chunkId,
        session_id: state.sessionId,
        registered_at: registration.registeredAt,
      };
      },
    );
    // Registration is already durably committed with an ETag before deletion. If this
    // best-effort erase is interrupted, a replay retries it and Cosmos TTL removes the
    // encrypted residual within one hour.
    await this.repository.deleteEnvelope(scopeId, request.object_id);
    return response;
  }

  public async chunkReceipt(
    scopeId: string,
    sessionId: string,
    objectId: string,
  ): Promise<JsonValue> {
    requireUuid(objectId);
    const state = await this.requireScope(scopeId);
    this.assertSession(state, sessionId);
    const reservation = requireReservation(state, objectId);
    const registration = state.registrations[objectId];
    return {
      reservation: reservationResponse(state, reservation),
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

  public async completeCapture(
    scopeId: string,
    sessionId: string,
    input: JsonValue,
    idempotencyKey: string,
  ): Promise<JsonValue> {
    const request = parseCompletion(input);
    return this.mutate(scopeId, "complete", sessionId, idempotencyKey, request, (state) => {
      this.assertSession(state, sessionId);
      this.assertOpen(state);
      const lease = this.requireLease(state);
      if (
        lease.lease_id !== request.capture_lease_id ||
        lease.generation !== request.capture_lease_generation
      ) {
        throw new PreviewDomainError(409, "capture_lease_generation_conflict");
      }
      const finalSequence = request.channels[0].final_sequence_number;
      for (let sequence = 0; sequence <= finalSequence; sequence += 1) {
        const reservation = state.reservations[positionKey(sequence)];
        if (
          reservation === undefined ||
          state.registrations[reservation.objectId] === undefined
        ) {
          throw new PreviewDomainError(409, "capture_sequence_incomplete");
        }
      }
      state.completed = true;
      const response: JsonObject = {
        id: state.sessionId,
        appointment_id: SYNTHETIC_APPOINTMENT_ID,
        practitioner_id: SYNTHETIC_PRACTITIONER_ID,
        patient_id: SYNTHETIC_PATIENT_ID,
        consent_record_id: requireString(state.consent?.id),
        modality: "in_person",
        status: "uploaded",
        created_at: requireString(state.session?.created_at),
      };
      state.session = response;
      return response;
    });
  }

  public async transcriptionStatus(scopeId: string, sessionId: string): Promise<JsonValue> {
    const state = await this.requireScope(scopeId);
    this.assertSession(state, sessionId);
    return {
      session_id: state.sessionId,
      status: state.completed ? "completed" : "not_requested",
      transcript_available: state.completed,
      updated_at: this.#now().toISOString(),
    };
  }

  public async transcript(scopeId: string, sessionId: string): Promise<JsonValue> {
    const state = await this.requireScope(scopeId);
    this.assertSession(state, sessionId);
    if (!state.completed) throw new PreviewDomainError(404, "transcript_not_ready");
    return {
      id: "77777777-7777-4777-8777-777777777777",
      session_id: state.sessionId,
      language_code: "en-US",
      stt_provider: "synthetic-preview",
      created_at: this.#now().toISOString(),
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

  async mutate(
    scopeId: string,
    operation: StoredAuditEvent["operation"],
    target: string,
    idempotencyKey: string,
    request: JsonValue,
    mutation: (state: PreviewScopeState) => JsonValue | Promise<JsonValue>,
    options: MutationStorageOptions = {},
  ): Promise<JsonValue> {
    const recordKey = createHash("sha256")
      .update("capture-preview-idempotency-v1\0")
      .update(operation)
      .update("\0")
      .update(target)
      .update("\0")
      .update(idempotencyKey)
      .digest("hex");
    const fingerprint = createHash("sha256")
      .update("capture-preview-request-v1\0")
      .update(operation)
      .update("\0")
      .update(target)
      .update("\0")
      .update(canonicalJson(request))
      .digest("hex");
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      const stored = await this.repository.readScope(scopeId);
      if (stored === null) throw new PreviewDomainError(401, "preview_session_expired");
      const existing = stored.state.idempotency[recordKey];
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new PreviewDomainError(409, "idempotency_conflict");
        }
        return structuredClone(
          options.replayResponse?.(stored.state, existing.response) ?? existing.response,
        );
      }
      if (Object.keys(stored.state.idempotency).length >= MAX_IDEMPOTENCY_RECORDS) {
        throw new PreviewDomainError(409, "preview_operation_limit_reached");
      }
      const next = structuredClone(stored.state);
      const response = await mutation(next);
      if (Object.keys(next.audit).length >= MAX_AUDIT_RECORDS) {
        throw new PreviewDomainError(409, "preview_operation_limit_reached");
      }
      next.idempotency[recordKey] = {
        fingerprint,
        response: structuredClone(options.storedResponse?.(response) ?? response),
      };
      next.audit[auditKey(operation, recordKey)] = {
        operation,
        recordedAt: this.#now().toISOString(),
      };
      try {
        await this.repository.replaceScope(
          validatePreviewScopeState(next, scopeId),
          stored.etag,
        );
        return structuredClone(response);
      } catch (error) {
        if (!(error instanceof PreviewRepositoryConflictError)) throw error;
      }
    }
    throw new PreviewDomainError(409, "preview_state_conflict");
  }

  async recordAudit(
    scopeId: string,
    operation: StoredAuditEvent["operation"],
    eventMaterial: string,
  ): Promise<void> {
    const key = auditKey(operation, eventMaterial);
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      const stored = await this.repository.readScope(scopeId);
      if (stored === null) throw new PreviewDomainError(401, "preview_session_expired");
      if (stored.state.audit[key] !== undefined) return;
      if (Object.keys(stored.state.audit).length >= MAX_AUDIT_RECORDS) {
        throw new PreviewDomainError(409, "preview_operation_limit_reached");
      }
      const next = structuredClone(stored.state);
      next.audit[key] = { operation, recordedAt: this.#now().toISOString() };
      try {
        await this.repository.replaceScope(
          validatePreviewScopeState(next, scopeId),
          stored.etag,
        );
        return;
      } catch (error) {
        if (!(error instanceof PreviewRepositoryConflictError)) throw error;
      }
    }
    throw new PreviewDomainError(409, "preview_state_conflict");
  }

  async requireScope(scopeId: string): Promise<PreviewScopeState> {
    const stored = await this.repository.readScope(scopeId);
    if (stored === null) throw new PreviewDomainError(401, "preview_session_expired");
    return stored.state;
  }

  assertSession(state: PreviewScopeState, sessionId: string): void {
    requireUuid(sessionId);
    if (state.session === null || state.sessionId !== sessionId) {
      throw new PreviewDomainError(404, "session_not_found");
    }
  }

  assertOpen(state: PreviewScopeState): void {
    if (state.completed) throw new PreviewDomainError(409, "session_closed");
  }

  requireLease(state: PreviewScopeState): JsonObject {
    if (state.lease === null) throw new PreviewDomainError(409, "capture_lease_required");
    return state.lease;
  }

  requireActiveLease(state: PreviewScopeState): JsonObject {
    const lease = this.requireLease(state);
    if (Date.parse(requireString(lease.expires_at)) <= this.#now().getTime()) {
      throw new PreviewDomainError(409, "capture_lease_expired");
    }
    return lease;
  }
}

function positionKey(sequenceNumber: number): string {
  return `microphone:${String(sequenceNumber)}`;
}

function auditKey(operation: string, eventMaterial: string): string {
  return createHash("sha256")
    .update("capture-preview-audit-v1\0")
    .update(operation)
    .update("\0")
    .update(eventMaterial)
    .digest("hex");
}

function hashUploadReceipt(receiptId: string): string {
  return createHash("sha256")
    .update("capture-preview-upload-receipt-v1\0")
    .update(receiptId)
    .digest("hex");
}

function deriveReceiptId(
  scopeId: string,
  sessionId: string,
  objectId: string,
  idempotencyKey: string,
): string {
  const bytes = createHash("sha256")
    .update("capture-preview-upload-capability-v1\0")
    .update(scopeId)
    .update("\0")
    .update(sessionId)
    .update("\0")
    .update(objectId)
    .update("\0")
    .update(idempotencyKey)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] ?? 0) & 0x0f | 0x40;
  bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uploadAuthorizationResponse(
  scopeId: string,
  objectId: string,
  receiptId: string,
  expiresAt: string,
  reservation: StoredReservation,
): JsonObject {
  return {
    protocol_version: PROTOCOL_VERSION,
    authorization_receipt_id: receiptId,
    object_id: objectId,
    additional_authenticated_data: reservation.additionalAuthenticatedData,
    upload_url: `/api/capture/preview/uploads/${scopeId}/${objectId}#receipt=${receiptId}`,
    expires_at: expiresAt,
  };
}

function requireReservation(state: PreviewScopeState, objectId: string): StoredReservation {
  const reservation = Object.values(state.reservations).find(
    (candidate) => candidate.objectId === objectId,
  );
  if (reservation === undefined) throw new PreviewDomainError(404, "chunk_not_found");
  return reservation;
}

function reservationResponse(
  state: PreviewScopeState,
  reservation: StoredReservation,
): JsonObject {
  return {
    protocol_version: PROTOCOL_VERSION,
    object_id: reservation.objectId,
    session_id: state.sessionId,
    channel: reservation.channel,
    sequence_number: reservation.sequenceNumber,
    additional_authenticated_data: reservation.additionalAuthenticatedData,
    created_at: reservation.createdAt,
  };
}

function requireString(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw new PreviewDomainError(409, "preview_state_invalid");
  return value;
}

function addSeconds(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * 1_000);
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(",")}}`;
}

export { PreviewValidationError };
