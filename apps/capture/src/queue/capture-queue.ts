import { UPLOAD_CONCURRENCY } from "@cosmaneura-scribe/capture-protocol";

import {
  QueueConcurrencyError,
  QueueInvariantError,
  QueueTransportError,
} from "./errors";
import {
  assertMatchingReceipt,
  attachEncryptedEnvelope,
  cloneCaptureRecord,
  createReservedRecord,
  markPurged,
  markRegistered,
  markTerminalFailure,
  markUploaded,
  markUploading,
  rotateUploadAuthorizationKey,
  scheduleRetry,
} from "./records";
import type {
  CaptureChunkRecord,
  CaptureChunkMetadata,
  CaptureQueueStorage,
  CaptureQueueTransport,
  ChunkIdempotencyKeys,
  ChunkReservation,
  DrainItemResult,
  DrainResult,
  EncryptedChunkRecord,
  QueueOperation,
  RegistrationReceipt,
  UploadedChunkRecord,
  UploadingChunkRecord,
} from "./types";

const DEFAULT_BASE_RETRY_MS = 500;
const DEFAULT_MAX_RETRY_MS = 30_000;
const MAX_COMPARE_AND_SWAP_ATTEMPTS = 12;
const DRAIN_LOCK_NAME = "cosmaneura-capture-queue-drain-v1";
let inProcessDrainLocked = false;

export interface CaptureQueueOptions {
  readonly crypto?: Crypto;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly idempotencyKeyFactory?: () => string;
  readonly uploadConcurrency?: number;
  readonly baseRetryMs?: number;
  readonly maxRetryMs?: number;
}

export class CaptureQueue {
  readonly #storage: CaptureQueueStorage;
  readonly #crypto: Crypto;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #idempotencyKeyFactory: () => string;
  #uploadConcurrency: number;
  readonly #baseRetryMs: number;
  readonly #maxRetryMs: number;
  #draining = false;

  constructor(storage: CaptureQueueStorage, options: CaptureQueueOptions = {}) {
    this.#storage = storage;
    this.#crypto = options.crypto ?? globalThis.crypto;
    if (this.#crypto?.subtle === undefined) {
      throw new QueueInvariantError("webcrypto_unavailable");
    }
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#idempotencyKeyFactory =
      options.idempotencyKeyFactory ?? (() => this.#crypto.randomUUID());
    this.#uploadConcurrency = options.uploadConcurrency ?? UPLOAD_CONCURRENCY;
    this.#baseRetryMs = options.baseRetryMs ?? DEFAULT_BASE_RETRY_MS;
    this.#maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    assertUploadConcurrency(this.#uploadConcurrency);
    if (
      !Number.isSafeInteger(this.#baseRetryMs) ||
      !Number.isSafeInteger(this.#maxRetryMs) ||
      this.#baseRetryMs < 1 ||
      this.#maxRetryMs < this.#baseRetryMs
    ) {
      throw new QueueInvariantError("invalid_retry_policy");
    }
  }

  /** Applies the current session capability before any queue drain begins. */
  public configureUploadConcurrency(uploadConcurrency: number): void {
    assertUploadConcurrency(uploadConcurrency);
    if (this.#draining) throw new QueueInvariantError("queue_drain_in_progress");
    this.#uploadConcurrency = uploadConcurrency;
  }

  /** Atomically stores a server reservation together with all stable keys. */
  async reserve(
    reservation: ChunkReservation,
    reservationIdempotencyKey: string,
  ): Promise<CaptureChunkRecord> {
    const idempotencyKeys: ChunkIdempotencyKeys = {
      reservation: reservationIdempotencyKey,
      uploadAuthorization: this.#idempotencyKeyFactory(),
      uploadAuthorizationGeneration: 1,
      registration: this.#idempotencyKeyFactory(),
    };
    const record = createReservedRecord(reservation, idempotencyKeys);
    if (await this.#storage.create(record)) return cloneCaptureRecord(record);

    const existing = await this.#storage.get(reservation.objectId);
    if (existing === null || !sameReservation(existing.reservation, reservation)) {
      throw new QueueInvariantError("reservation_identity_conflict");
    }
    return cloneCaptureRecord(existing);
  }

  /**
   * Commits the complete generated-protocol envelope, digest, and exact length
   * in one CAS write. The input bytes are copied before hashing.
   */
  async encrypt(objectId: string, envelope: Uint8Array): Promise<EncryptedChunkRecord> {
    const immutableEnvelope = envelope.slice();
    const digest = await this.#crypto.subtle.digest("SHA-256", immutableEnvelope);
    const sha256 = bytesToHex(new Uint8Array(digest));
    const result = await this.#mutate(objectId, (current) => {
      if (current.state === "reserved") {
        return attachEncryptedEnvelope(current, immutableEnvelope, sha256);
      }
      if (
        current.state === "encrypted" ||
        current.state === "uploading" ||
        current.state === "uploaded" ||
        current.state === "registered"
      ) {
        if (
          current.sha256 !== sha256 ||
          current.byteLength !== immutableEnvelope.byteLength ||
          !equalBytes(current.envelope, immutableEnvelope)
        ) {
          throw new QueueInvariantError("immutable_envelope_conflict");
        }
        return current;
      }
      throw new QueueInvariantError("chunk_already_purged");
    });
    if (result.state !== "encrypted") {
      throw new QueueInvariantError("chunk_already_advanced");
    }
    return cloneCaptureRecord(result) as EncryptedChunkRecord;
  }

  async get(objectId: string): Promise<CaptureChunkRecord | null> {
    const value = await this.#storage.get(objectId);
    return value === null ? null : cloneCaptureRecord(value);
  }

  async list(): Promise<readonly CaptureChunkRecord[]> {
    return (await this.#storage.list()).map(cloneCaptureRecord);
  }

  async listMetadata(): Promise<readonly CaptureChunkMetadata[]> {
    return this.#storage.listMetadata();
  }

  /** Removes envelope bytes only after a matching server registration receipt. */
  async purge(objectId: string): Promise<CaptureChunkRecord> {
    const result = await this.#mutate(objectId, (current) => {
      if (current.state === "registered") {
        return markPurged(current, new Date(this.#now()).toISOString());
      }
      if (current.state === "purged") return current;
      throw new QueueInvariantError("registration_receipt_required");
    });
    return cloneCaptureRecord(result);
  }

  /**
   * Processes every currently eligible record once, with no more than the
   * generated protocol's two simultaneous upload workers.
   */
  async drainOnce(transport: CaptureQueueTransport): Promise<DrainResult> {
    return withOriginDrainLock(async () => {
      if (this.#draining) throw new QueueInvariantError("queue_drain_in_progress");
      this.#draining = true;
      try {
        const records = (await this.#storage.listMetadata()).filter(isDrainCandidate);
        const results: DrainItemResult[] = records.map((record) =>
          skipped(record.reservation.objectId),
        );
        let nextIndex = 0;
        const worker = async (): Promise<void> => {
          while (true) {
            const index = nextIndex;
            nextIndex += 1;
            const record = records[index];
            if (record === undefined) return;
            results[index] = await this.#processOne(record.reservation.objectId, transport);
          }
        };
        const workerCount = Math.min(this.#uploadConcurrency, records.length);
        await Promise.all(Array.from({ length: workerCount }, worker));
        return { items: results };
      } finally {
        this.#draining = false;
      }
    });
  }

  async #processOne(
    objectId: string,
    transport: CaptureQueueTransport,
  ): Promise<DrainItemResult> {
    let operation: QueueOperation = "upload";
    try {
      let current = await this.#requireRecord(objectId);
      if (current.state === "encrypted") {
        if (!isOperationDue(current, "upload", this.#now())) return skipped(objectId);
        current = await this.#mutate(objectId, (latest) =>
          latest.state === "encrypted" ? markUploading(latest) : latest,
        );
      }

      if (current.state === "uploading") {
        if (!isOperationDue(current, "upload", this.#now())) return skipped(objectId);
        const remote = await transport.getReceipt(current.reservation);
        if (remote.state === "registered") {
          await this.#reconcileRegistered(objectId, remote.registration);
          return { objectId, outcome: "registered" };
        }

        const authorization = await transport.authorizeUpload(
          current.reservation.sessionId,
          current.reservation.objectId,
          current.idempotencyKeys.uploadAuthorization,
        );
        if (
          authorization.objectId !== current.reservation.objectId ||
          authorization.additionalAuthenticatedData !==
            current.reservation.additionalAuthenticatedData
        ) {
          throw new QueueTransportError("terminal", "upload_authorization_mismatch");
        }
        if (
          !Number.isFinite(authorization.expiresAtEpochMs) ||
          authorization.expiresAtEpochMs <= this.#now()
        ) {
          await this.#rotateAuthorization(objectId, current.idempotencyKeys.uploadAuthorizationGeneration);
          return { objectId, outcome: "deferred", code: "credential_expired" };
        }
        await transport.upload(authorization.uploadUrl, current.envelope.slice());
        current = await this.#mutate(objectId, (latest) =>
          latest.state === "uploading" ? markUploaded(latest) : latest,
        );
      }

      operation = "registration";
      if (current.state === "uploaded") {
        if (!isOperationDue(current, "registration", this.#now())) return skipped(objectId);
        const remote = await transport.getReceipt(current.reservation);
        const receipt =
          remote.state === "registered"
            ? remote.registration
            : await transport.register(registrationRequest(current));
        await this.#reconcileRegistered(objectId, receipt);
        return { objectId, outcome: "registered" };
      }

      if (current.state === "registered" || current.state === "purged") {
        return { objectId, outcome: "registered" };
      }
      return skipped(objectId);
    } catch (error) {
      return this.#handleFailure(objectId, operation, error);
    }
  }

  async #handleFailure(
    objectId: string,
    operation: QueueOperation,
    error: unknown,
  ): Promise<DrainItemResult> {
    if (
      error instanceof QueueTransportError &&
      error.kind === "credential_expired" &&
      operation === "upload"
    ) {
      const current = await this.#requireRecord(objectId);
      if (current.state === "uploading") {
        await this.#rotateAuthorization(
          objectId,
          current.idempotencyKeys.uploadAuthorizationGeneration,
        );
      }
      return { objectId, outcome: "deferred", code: "credential_expired" };
    }

    if (
      error instanceof QueueTransportError &&
      (error.kind === "unknown_success" || error.kind === "retryable")
    ) {
      const current = await this.#requireRecord(objectId);
      const attempt = current.retry[operation].attempts + 1;
      const delay = this.#retryDelay(attempt, error.retryAfterMs);
      await this.#recordRetry(objectId, operation, this.#now() + delay);
      return { objectId, outcome: "deferred", code: error.code };
    }

    const code =
      error instanceof QueueTransportError || error instanceof QueueInvariantError
        ? safeFixedCode(error.code)
        : "unexpected_transport_error";
    await this.#recordTerminal(objectId, operation, code);
    return { objectId, outcome: "terminal", code };
  }

  async #reconcileRegistered(objectId: string, receipt: RegistrationReceipt): Promise<void> {
    for (let index = 0; index < 4; index += 1) {
      const current = await this.#requireRecord(objectId);
      if (current.state === "registered") {
        assertMatchingReceipt(current, receipt);
        if (!sameRegistrationReceipt(current.registrationReceipt, receipt)) {
          throw new QueueInvariantError("registration_receipt_mismatch");
        }
        return;
      }
      if (current.state === "purged") {
        if (!sameRegistrationReceipt(current.registrationReceipt, receipt)) {
          throw new QueueInvariantError("registration_receipt_mismatch");
        }
        return;
      }
      let replacement: CaptureChunkRecord;
      if (current.state === "encrypted") replacement = markUploading(current);
      else if (current.state === "uploading") {
        assertMatchingReceipt(current, receipt);
        replacement = markUploaded(current);
      } else if (current.state === "uploaded") replacement = markRegistered(current, receipt);
      else throw new QueueInvariantError("registration_without_envelope");

      if (
        await this.#storage.compareAndSwap(objectId, current.revision, replacement)
      ) {
        if (replacement.state === "registered") return;
      }
    }
    throw new QueueConcurrencyError();
  }

  async #rotateAuthorization(objectId: string, expectedGeneration: number): Promise<void> {
    const nextKey = this.#idempotencyKeyFactory();
    await this.#mutate(objectId, (current) => {
      if (current.state !== "uploading") return current;
      if (current.idempotencyKeys.uploadAuthorizationGeneration !== expectedGeneration) {
        return current;
      }
      return rotateUploadAuthorizationKey(current, nextKey);
    });
  }

  async #recordRetry(
    objectId: string,
    operation: QueueOperation,
    notBeforeEpochMs: number,
  ): Promise<void> {
    await this.#mutate(objectId, (current) => {
      if (operation === "upload" && (current.state === "encrypted" || current.state === "uploading")) {
        return scheduleRetry(current, operation, notBeforeEpochMs);
      }
      if (operation === "registration" && current.state === "uploaded") {
        return scheduleRetry(current, operation, notBeforeEpochMs);
      }
      return current;
    });
  }

  async #recordTerminal(
    objectId: string,
    operation: QueueOperation,
    code: string,
  ): Promise<void> {
    await this.#mutate(objectId, (current) => {
      if (operation === "upload" && (current.state === "encrypted" || current.state === "uploading")) {
        return markTerminalFailure(current, operation, code);
      }
      if (operation === "registration" && current.state === "uploaded") {
        return markTerminalFailure(current, operation, code);
      }
      return current;
    });
  }

  #retryDelay(attempt: number, retryAfterMs: number | null): number {
    const exponential = Math.min(
      this.#maxRetryMs,
      this.#baseRetryMs * 2 ** Math.min(attempt - 1, 20),
    );
    const jittered = Math.floor(exponential / 2 + (exponential / 2) * this.#boundedRandom());
    const normalizedRetryAfter =
      retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? Math.ceil(retryAfterMs)
        : 0;
    return Math.max(jittered, normalizedRetryAfter);
  }

  #boundedRandom(): number {
    const value = this.#random();
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
  }

  async #requireRecord(objectId: string): Promise<CaptureChunkRecord> {
    const record = await this.#storage.get(objectId);
    if (record === null) throw new QueueInvariantError("chunk_not_found");
    return record;
  }

  async #mutate(
    objectId: string,
    transform: (record: CaptureChunkRecord) => CaptureChunkRecord,
  ): Promise<CaptureChunkRecord> {
    for (let attempt = 0; attempt < MAX_COMPARE_AND_SWAP_ATTEMPTS; attempt += 1) {
      const current = await this.#requireRecord(objectId);
      const replacement = transform(current);
      if (replacement.revision === current.revision) return current;
      if (await this.#storage.compareAndSwap(objectId, current.revision, replacement)) {
        return replacement;
      }
    }
    throw new QueueConcurrencyError();
  }
}

function assertUploadConcurrency(uploadConcurrency: number): void {
  if (
    !Number.isSafeInteger(uploadConcurrency) ||
    uploadConcurrency < 1 ||
    uploadConcurrency > UPLOAD_CONCURRENCY
  ) {
    throw new QueueInvariantError("invalid_upload_concurrency");
  }
}

async function withOriginDrainLock<Result>(operation: () => Promise<Result>): Promise<Result> {
  const lockManager = globalThis.navigator?.locks;
  if (lockManager !== undefined) {
    let acquired = false;
    const result = await lockManager.request(
      DRAIN_LOCK_NAME,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (lock === null) return undefined;
        acquired = true;
        return operation();
      },
    );
    if (!acquired || result === undefined) {
      throw new QueueInvariantError("queue_drain_in_progress");
    }
    return result;
  }
  if (typeof globalThis.window !== "undefined") {
    throw new QueueInvariantError("cross_context_drain_lock_unavailable");
  }
  if (inProcessDrainLocked) {
    throw new QueueInvariantError("queue_drain_in_progress");
  }
  inProcessDrainLocked = true;
  try {
    return await operation();
  } finally {
    inProcessDrainLocked = false;
  }
}

function registrationRequest(record: UploadedChunkRecord) {
  return {
    sessionId: record.reservation.sessionId,
    objectId: record.reservation.objectId,
    channel: record.reservation.channel,
    sequenceNumber: record.reservation.sequenceNumber,
    sha256: record.sha256,
    byteLength: record.byteLength,
    idempotencyKey: record.idempotencyKeys.registration,
  };
}

function isDrainCandidate(record: CaptureChunkMetadata): boolean {
  return record.state === "encrypted" || record.state === "uploading" || record.state === "uploaded";
}

function isOperationDue(
  record: EncryptedChunkRecord | UploadingChunkRecord | UploadedChunkRecord,
  operation: QueueOperation,
  now: number,
): boolean {
  const retry = record.retry[operation];
  return (
    retry.terminalCode === null &&
    (retry.notBeforeEpochMs === null || retry.notBeforeEpochMs <= now)
  );
}

function skipped(objectId: string): DrainItemResult {
  return { objectId, outcome: "skipped" };
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function sameReservation(left: ChunkReservation, right: ChunkReservation): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.objectId === right.objectId &&
    left.sessionId === right.sessionId &&
    left.channel === right.channel &&
    left.sequenceNumber === right.sequenceNumber &&
    left.additionalAuthenticatedData === right.additionalAuthenticatedData &&
    left.createdAt === right.createdAt
  );
}

function sameRegistrationReceipt(
  left: RegistrationReceipt,
  right: RegistrationReceipt,
): boolean {
  return (
    left.chunkId === right.chunkId &&
    left.sha256 === right.sha256.toLowerCase() &&
    left.byteLength === right.byteLength &&
    left.registeredAt === right.registeredAt
  );
}

function safeFixedCode(value: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : "unsafe_transport_error";
}
