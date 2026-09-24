import { NONCE_BYTES } from "@cosmaneura-scribe/capture-protocol";

import { QueueInvariantError } from "../queue/errors";
import {
  FLOW_RECORD_SCHEMA_VERSION,
  CHANNEL_FLOW_RECORD_SCHEMA_VERSION,
  CONTINUATION_FLOW_RECORD_SCHEMA_VERSION,
  type ActiveCaptureState,
  type CaptureFlowStore,
  type CapturePreparationState,
  type ReservationIntent,
  type SessionKeyBindingState,
} from "./types";

const DATABASE_VERSION = 1;
const FLOW_RECORD_STORE = "encrypted-flow-records";
const METADATA_STORE = "metadata";
const SESSION_KEY_STORE = "session-keys";
const LOCAL_KEY_ID = "flow-state-encryption-key-v1";
const LOCAL_AAD_PREFIX = "cosmaneura-capture-flow-state:v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,255}$/u;

type StoredFlowValue =
  | ActiveCaptureState
  | CapturePreparationState
  | ReservationIntent
  | SessionKeyBindingState;

interface SealedFlowRecord {
  readonly key: string;
  readonly nonce: Uint8Array<ArrayBuffer>;
  readonly ciphertext: ArrayBuffer;
}

export interface EncryptedFlowStoreOptions {
  readonly databaseName?: string;
  readonly indexedDB?: IDBFactory;
  readonly crypto?: Crypto;
}

export class EncryptedIndexedDbFlowStore implements CaptureFlowStore {
  readonly #database: IDBDatabase;
  readonly #localKey: CryptoKey;
  readonly #crypto: Crypto;

  private constructor(database: IDBDatabase, localKey: CryptoKey, crypto: Crypto) {
    this.#database = database;
    this.#localKey = localKey;
    this.#crypto = crypto;
  }

  static async open(
    options: EncryptedFlowStoreOptions = {},
  ): Promise<EncryptedIndexedDbFlowStore> {
    const indexedDB = options.indexedDB ?? globalThis.indexedDB;
    const crypto = options.crypto ?? globalThis.crypto;
    if (indexedDB === undefined || crypto?.subtle === undefined) {
      throw new QueueInvariantError("encrypted_flow_store_unavailable");
    }
    const database = await openDatabase(
      indexedDB,
      options.databaseName ?? "cosmaneura-capture-flow",
    );
    try {
      const localKey = await getOrCreateLocalKey(database, crypto);
      assertAesKey(localKey, "invalid_flow_encryption_key");
      return new EncryptedIndexedDbFlowStore(database, localKey, crypto);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async putPreparationState(state: CapturePreparationState): Promise<void> {
    assertPreparationState(state);
    const existing = await this.getPreparationState();
    if (existing !== null) assertPreparationProgression(existing, state);
    const sealed = await this.#seal("preparation", state);
    const transaction = this.#database.transaction(FLOW_RECORD_STORE, "readwrite");
    transaction.objectStore(FLOW_RECORD_STORE).put(sealed);
    await transactionDone(transaction);
  }

  async getPreparationState(): Promise<CapturePreparationState | null> {
    const value = await this.#getRecord("preparation");
    if (value === null) return null;
    assertPreparationState(value);
    return value;
  }

  async putActiveCaptureState(state: ActiveCaptureState): Promise<void> {
    assertActiveCaptureState(state);
    const existing = await this.getActiveCaptureState();
    if (existing !== null && existing.sessionId !== state.sessionId) {
      throw new QueueInvariantError("active_capture_conflict");
    }
    if (existing !== null) assertActiveCaptureProgression(existing, state);
    const sealed = await this.#seal("active", state);
    const transaction = this.#database.transaction(FLOW_RECORD_STORE, "readwrite");
    transaction.objectStore(FLOW_RECORD_STORE).put(sealed);
    await transactionDone(transaction);
  }

  async getActiveCaptureState(): Promise<ActiveCaptureState | null> {
    const value = await this.#getRecord("active");
    if (value === null) return null;
    assertActiveCaptureState(value);
    return value;
  }

  async clearCompletedCapture(sessionId: string): Promise<void> {
    assertUuid(sessionId, "invalid_session_id");
    const existing = await this.getActiveCaptureState();
    if (existing === null) return;
    if (existing.sessionId !== sessionId) {
      throw new QueueInvariantError("active_capture_conflict");
    }
    const transaction = this.#database.transaction(
      [FLOW_RECORD_STORE, SESSION_KEY_STORE],
      "readwrite",
    );
    const records = transaction.objectStore(FLOW_RECORD_STORE);
    records.delete("active");
    records.delete("preparation");
    records.delete(`session:${sessionId}`);
    transaction.objectStore(SESSION_KEY_STORE).delete(sessionId);
    await transactionDone(transaction);
  }

  async putReservationIntent(intent: ReservationIntent): Promise<void> {
    assertReservationIntent(intent);
    await this.#putExact(`intent:${intent.intentId}`, intent);
  }

  async listReservationIntents(): Promise<readonly ReservationIntent[]> {
    const transaction = this.#database.transaction(FLOW_RECORD_STORE, "readonly");
    const done = transactionDone(transaction);
    const request = transaction.objectStore(FLOW_RECORD_STORE).getAll() as IDBRequest<unknown>;
    const values = await requestResult(request);
    await done;
    if (!Array.isArray(values)) throw new QueueInvariantError("invalid_flow_store_record");
    const intents: ReservationIntent[] = [];
    for (const value of values) {
      assertSealedRecord(value);
      if (!value.key.startsWith("intent:")) continue;
      const opened = await this.#open(value);
      assertReservationIntent(opened);
      intents.push(opened);
    }
    return intents.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async deleteReservationIntent(intentId: string): Promise<void> {
    assertIdentifier(intentId, "invalid_reservation_intent");
    const transaction = this.#database.transaction(FLOW_RECORD_STORE, "readwrite");
    transaction.objectStore(FLOW_RECORD_STORE).delete(`intent:${intentId}`);
    await transactionDone(transaction);
  }

  async putSessionKeyCandidate(
    state: SessionKeyBindingState,
    key: CryptoKey,
  ): Promise<void> {
    assertSessionKeyState(state);
    assertSessionDek(key);
    const storageKey = `session:${state.sessionId}`;
    const sealed = await this.#seal(storageKey, state);
    const transaction = this.#database.transaction(
      [FLOW_RECORD_STORE, SESSION_KEY_STORE],
      "readwrite",
    );
    const records = transaction.objectStore(FLOW_RECORD_STORE);
    const keys = transaction.objectStore(SESSION_KEY_STORE);
    let failure: QueueInvariantError | undefined;
    const existing = records.get(storageKey) as IDBRequest<unknown>;
    existing.addEventListener("success", () => {
      if (existing.result !== undefined) {
        failure = new QueueInvariantError("session_key_already_exists");
        transaction.abort();
        return;
      }
      records.add(sealed);
      keys.add(key, state.sessionId);
    });
    await transactionDone(transaction, () => failure);
  }

  async replacePendingSessionKeyCandidate(
    state: SessionKeyBindingState,
    key: CryptoKey,
  ): Promise<void> {
    assertSessionKeyState(state);
    assertSessionDek(key);
    if (state.state !== "pending") {
      throw new QueueInvariantError("invalid_session_key_state");
    }
    const existing = await this.getSessionKeyState(state.sessionId);
    if (existing?.state !== "pending") {
      throw new QueueInvariantError("session_key_replacement_refused");
    }
    const storageKey = `session:${state.sessionId}`;
    const sealed = await this.#seal(storageKey, state);
    const transaction = this.#database.transaction(
      [FLOW_RECORD_STORE, SESSION_KEY_STORE],
      "readwrite",
    );
    transaction.objectStore(FLOW_RECORD_STORE).put(sealed);
    transaction.objectStore(SESSION_KEY_STORE).put(key, state.sessionId);
    await transactionDone(transaction);
  }

  async getSessionKeyState(sessionId: string): Promise<SessionKeyBindingState | null> {
    assertUuid(sessionId, "invalid_session_id");
    const value = await this.#getRecord(`session:${sessionId}`);
    if (value === null) return null;
    assertSessionKeyState(value);
    return value;
  }

  async getSessionKey(sessionId: string): Promise<CryptoKey | null> {
    assertUuid(sessionId, "invalid_session_id");
    const transaction = this.#database.transaction(SESSION_KEY_STORE, "readonly");
    const done = transactionDone(transaction);
    const request = transaction.objectStore(SESSION_KEY_STORE).get(sessionId) as IDBRequest<unknown>;
    const value = await requestResult(request);
    await done;
    if (value === undefined) return null;
    if (!isCryptoKey(value)) throw new QueueInvariantError("invalid_session_dek");
    assertSessionDek(value);
    return value;
  }

  async markSessionKeyBound(sessionId: string): Promise<void> {
    const state = await this.getSessionKeyState(sessionId);
    if (state === null) throw new QueueInvariantError("session_key_missing");
    if (state.state === "bound") return;
    const storageKey = `session:${sessionId}`;
    const sealed = await this.#seal(storageKey, { ...state, state: "bound" });
    const transaction = this.#database.transaction(FLOW_RECORD_STORE, "readwrite");
    transaction.objectStore(FLOW_RECORD_STORE).put(sealed);
    await transactionDone(transaction);
  }

  close(): void {
    this.#database.close();
  }

  async #putExact(key: string, value: StoredFlowValue): Promise<void> {
    const sealed = await this.#seal(key, value);
    const existing = await this.#getRecord(key);
    if (existing !== null) {
      if (JSON.stringify(existing) !== JSON.stringify(value)) {
        throw new QueueInvariantError("flow_record_conflict");
      }
      return;
    }
    const transaction = this.#database.transaction(FLOW_RECORD_STORE, "readwrite");
    transaction.objectStore(FLOW_RECORD_STORE).add(sealed);
    await transactionDone(transaction);
  }

  async #getRecord(key: string): Promise<StoredFlowValue | null> {
    const transaction = this.#database.transaction(FLOW_RECORD_STORE, "readonly");
    const done = transactionDone(transaction);
    const request = transaction.objectStore(FLOW_RECORD_STORE).get(key) as IDBRequest<unknown>;
    const value = await requestResult(request);
    await done;
    if (value === undefined) return null;
    assertSealedRecord(value);
    return this.#open(value);
  }

  async #seal(key: string, value: StoredFlowValue): Promise<SealedFlowRecord> {
    const nonce = this.#crypto.getRandomValues(new Uint8Array(new ArrayBuffer(NONCE_BYTES)));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    try {
      const ciphertext = await this.#crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: localAdditionalData(key) },
        this.#localKey,
        plaintext,
      );
      return { key, nonce, ciphertext };
    } finally {
      plaintext.fill(0);
    }
  }

  async #open(sealed: SealedFlowRecord): Promise<StoredFlowValue> {
    let plaintext: ArrayBuffer;
    try {
      plaintext = await this.#crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: sealed.nonce,
          additionalData: localAdditionalData(sealed.key),
        },
        this.#localKey,
        sealed.ciphertext,
      );
    } catch {
      throw new QueueInvariantError("encrypted_flow_store_integrity_failure");
    }
    const bytes = new Uint8Array(plaintext);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as StoredFlowValue;
    } catch {
      throw new QueueInvariantError("encrypted_flow_store_integrity_failure");
    } finally {
      bytes.fill(0);
    }
  }
}

async function openDatabase(indexedDB: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(FLOW_RECORD_STORE)) {
        database.createObjectStore(FLOW_RECORD_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(METADATA_STORE)) {
        database.createObjectStore(METADATA_STORE);
      }
      if (!database.objectStoreNames.contains(SESSION_KEY_STORE)) {
        database.createObjectStore(SESSION_KEY_STORE);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(new QueueInvariantError("flow_database_error")));
    request.addEventListener("blocked", () => reject(new QueueInvariantError("flow_database_blocked")));
  });
}

async function getOrCreateLocalKey(database: IDBDatabase, crypto: Crypto): Promise<CryptoKey> {
  const candidate = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      [METADATA_STORE, FLOW_RECORD_STORE, SESSION_KEY_STORE],
      "readwrite",
    );
    const metadata = transaction.objectStore(METADATA_STORE);
    const lookup = metadata.get(LOCAL_KEY_ID) as IDBRequest<unknown>;
    let selected = candidate;
    let failure: QueueInvariantError | undefined;
    lookup.addEventListener("success", () => {
      if (lookup.result === undefined) {
        const records = transaction.objectStore(FLOW_RECORD_STORE).count();
        const sessionKeys = transaction.objectStore(SESSION_KEY_STORE).count();
        let recordCount: number | undefined;
        let sessionKeyCount: number | undefined;
        const finish = (): void => {
          if (recordCount === undefined || sessionKeyCount === undefined) return;
          if (recordCount !== 0 || sessionKeyCount !== 0) {
            failure = new QueueInvariantError("flow_encryption_key_missing");
            transaction.abort();
            return;
          }
          metadata.add(candidate, LOCAL_KEY_ID);
        };
        records.addEventListener("success", () => {
          recordCount = records.result;
          finish();
        });
        sessionKeys.addEventListener("success", () => {
          sessionKeyCount = sessionKeys.result;
          finish();
        });
      } else {
        if (!isCryptoKey(lookup.result)) {
          failure = new QueueInvariantError("invalid_flow_encryption_key");
          transaction.abort();
          return;
        }
        selected = lookup.result;
      }
    });
    transaction.addEventListener("complete", () => resolve(selected));
    transaction.addEventListener("abort", () => reject(failure ?? new QueueInvariantError("flow_database_aborted")));
    transaction.addEventListener("error", () => reject(new QueueInvariantError("flow_database_error")));
  });
}

export function assertReservationIntent(value: unknown): asserts value is ReservationIntent {
  if (
    !isRecord(value) ||
    value.schemaVersion !== FLOW_RECORD_SCHEMA_VERSION ||
    typeof value.intentId !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.idempotencyKey !== "string" ||
    typeof value.createdAt !== "string" ||
    !isRecord(value.request)
  ) {
    throw new QueueInvariantError("invalid_reservation_intent");
  }
  assertIdentifier(value.intentId, "invalid_reservation_intent");
  assertUuid(value.sessionId, "invalid_reservation_intent");
  assertIdempotencyKey(value.idempotencyKey);
  if (Number.isNaN(Date.parse(value.createdAt))) {
    throw new QueueInvariantError("invalid_reservation_intent");
  }
}

function validCaptureChannelVersion(value: Record<string, unknown>): boolean {
  return value.schemaVersion === FLOW_RECORD_SCHEMA_VERSION && value.channel === undefined
    || value.schemaVersion === CHANNEL_FLOW_RECORD_SCHEMA_VERSION
      && (value.channel === "mixed" || value.channel === "system_audio");
}

function validActiveChannelVersion(value: Record<string, unknown>): boolean {
  return validCaptureChannelVersion(value) && value.continuation === undefined
    || value.schemaVersion === CONTINUATION_FLOW_RECORD_SCHEMA_VERSION && value.reviewAfterUpload === true
      && (value.channel === undefined || value.channel === "mixed" || value.channel === "system_audio");
}

export function assertPreparationState(value: unknown): asserts value is CapturePreparationState {
  if (isRecord(value) && value.mode === "configured_core") {
    if (Object.keys(value).filter(key => key !== "channel").sort().join(",") !==
        "completeIdempotencyKey,leaseIdempotencyKey,leaseRequest,mode,schemaVersion,sessionId,startedAt"
      || !validCaptureChannelVersion(value)
      || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))
      || typeof value.sessionId !== "string" || typeof value.completeIdempotencyKey !== "string"
      || (value.leaseIdempotencyKey !== null && typeof value.leaseIdempotencyKey !== "string")
      || (value.leaseRequest !== null && (!isRecord(value.leaseRequest)
        || Object.keys(value.leaseRequest).join(",") !== "protocol_version"
        || value.leaseRequest.protocol_version !== "1.0"))
      || (value.leaseIdempotencyKey === null) !== (value.leaseRequest === null)) {
      throw new QueueInvariantError("invalid_preparation_state");
    }
    assertUuid(value.sessionId, "invalid_preparation_state");
    assertIdempotencyKey(value.completeIdempotencyKey);
    if (value.leaseIdempotencyKey !== null) assertIdempotencyKey(value.leaseIdempotencyKey);
    return;
  }
  if (
    !isRecord(value) ||
    (value.mode !== undefined && value.mode !== "direct") ||
    value.channel !== undefined ||
    value.schemaVersion !== FLOW_RECORD_SCHEMA_VERSION ||
    typeof value.startedAt !== "string" ||
    typeof value.consentIdempotencyKey !== "string" ||
    typeof value.completeIdempotencyKey !== "string" ||
    !isRecord(value.consentRequest) ||
    (value.consentId !== null && typeof value.consentId !== "string") ||
    (value.sessionIdempotencyKey !== null && typeof value.sessionIdempotencyKey !== "string") ||
    (value.sessionRequest !== null && !isRecord(value.sessionRequest)) ||
    (value.sessionId !== null && typeof value.sessionId !== "string") ||
    (value.leaseIdempotencyKey !== null && typeof value.leaseIdempotencyKey !== "string") ||
    (value.leaseRequest !== null && !isRecord(value.leaseRequest))
  ) {
    throw new QueueInvariantError("invalid_preparation_state");
  }
  if (Number.isNaN(Date.parse(value.startedAt))) {
    throw new QueueInvariantError("invalid_preparation_state");
  }
  assertIdempotencyKey(value.consentIdempotencyKey);
  assertIdempotencyKey(value.completeIdempotencyKey);
  if (value.consentId !== null) assertUuid(value.consentId, "invalid_preparation_state");
  if (value.sessionIdempotencyKey !== null) assertIdempotencyKey(value.sessionIdempotencyKey);
  if (value.sessionId !== null) assertUuid(value.sessionId, "invalid_preparation_state");
  if (value.leaseIdempotencyKey !== null) assertIdempotencyKey(value.leaseIdempotencyKey);
  if (
    (value.sessionIdempotencyKey === null) !== (value.sessionRequest === null) ||
    (value.leaseIdempotencyKey === null) !== (value.leaseRequest === null)
  ) {
    throw new QueueInvariantError("invalid_preparation_state");
  }
}

export function assertPreparationProgression(
  existing: CapturePreparationState,
  replacement: CapturePreparationState,
): void {
  if (existing.mode === "configured_core" || replacement.mode === "configured_core") {
    if (existing.mode !== "configured_core" || replacement.mode !== "configured_core"
      || existing.sessionId !== replacement.sessionId || existing.startedAt !== replacement.startedAt
      || existing.completeIdempotencyKey !== replacement.completeIdempotencyKey
      || existing.schemaVersion !== replacement.schemaVersion || existing.channel !== replacement.channel
      || !nullableStable(existing.leaseIdempotencyKey, replacement.leaseIdempotencyKey)
      || !nullableStableJson(existing.leaseRequest, replacement.leaseRequest)) {
      throw new QueueInvariantError("preparation_state_conflict");
    }
    return;
  }
  if (
    existing.startedAt !== replacement.startedAt ||
    existing.consentIdempotencyKey !== replacement.consentIdempotencyKey ||
    existing.completeIdempotencyKey !== replacement.completeIdempotencyKey ||
    JSON.stringify(existing.consentRequest) !== JSON.stringify(replacement.consentRequest) ||
    !nullableStable(existing.consentId, replacement.consentId) ||
    !nullableStable(existing.sessionIdempotencyKey, replacement.sessionIdempotencyKey) ||
    !nullableStableJson(existing.sessionRequest, replacement.sessionRequest) ||
    !nullableStable(existing.sessionId, replacement.sessionId) ||
    !nullableStable(existing.leaseIdempotencyKey, replacement.leaseIdempotencyKey) ||
    !nullableStableJson(existing.leaseRequest, replacement.leaseRequest)
  ) {
    throw new QueueInvariantError("preparation_state_conflict");
  }
}

function nullableStable(existing: string | null, replacement: string | null): boolean {
  return existing === null || existing === replacement;
}

function nullableStableJson(
  existing: Record<string, unknown> | null,
  replacement: Record<string, unknown> | null,
): boolean {
  return existing === null || JSON.stringify(existing) === JSON.stringify(replacement);
}

export function assertActiveCaptureState(value: unknown): asserts value is ActiveCaptureState {
  if (
    !isRecord(value) ||
    (value.reviewAfterUpload !== undefined && value.reviewAfterUpload !== true) ||
    !validActiveChannelVersion(value) ||
    (value.schemaVersion === CHANNEL_FLOW_RECORD_SCHEMA_VERSION && value.reviewAfterUpload !== true) ||
    typeof value.sessionId !== "string" ||
    !isRecord(value.lease) ||
    (value.captureAuthorizedUntil !== null &&
      typeof value.captureAuthorizedUntil !== "string") ||
    !Number.isSafeInteger(value.aggregatePlaintextBudgetBytes) ||
    (value.aggregatePlaintextBudgetBytes as number) < 1 ||
    !isActiveCapturePhase(value.phase) ||
    typeof value.completeIdempotencyKey !== "string" ||
    !Number.isSafeInteger(value.recordedChunks) ||
    (value.recordedChunks as number) < 0 ||
    !Number.isSafeInteger(value.recordedPlaintextBytes) ||
    (value.recordedPlaintextBytes as number) < 0 ||
    typeof value.startedAt !== "string"
  ) {
    throw new QueueInvariantError("invalid_active_capture_state");
  }
  assertUuid(value.sessionId, "invalid_active_capture_state");
  assertIdempotencyKey(value.completeIdempotencyKey);
  if (Number.isNaN(Date.parse(value.startedAt))) {
    throw new QueueInvariantError("invalid_active_capture_state");
  }
  if (
    value.captureAuthorizedUntil !== null &&
    Number.isNaN(Date.parse(value.captureAuthorizedUntil))
  ) {
    throw new QueueInvariantError("invalid_active_capture_state");
  }
  assertLease(value.lease, value.sessionId);
  if (value.schemaVersion === CONTINUATION_FLOW_RECORD_SCHEMA_VERSION) {
    const next = value.continuation;
    if (!isRecord(next) || Object.keys(next).sort().join(",") !==
        "firstSequenceNumber,prepared,previousLease,renewIdempotencyKey,reservationCount"
      || typeof next.prepared !== "boolean"
      || !Number.isSafeInteger(next.firstSequenceNumber) || (next.firstSequenceNumber as number) < 0
      || (next.firstSequenceNumber as number) > (value.recordedChunks as number)
      || !Number.isSafeInteger(next.reservationCount) || (next.reservationCount as number) < 1
      || (next.reservationCount as number) > 90
      || (next.firstSequenceNumber as number) + (next.reservationCount as number) > 1000
      || typeof next.renewIdempotencyKey !== "string" || !isRecord(next.previousLease)) {
      throw new QueueInvariantError("invalid_active_capture_state");
    }
    assertIdempotencyKey(next.renewIdempotencyKey); assertLease(next.previousLease, value.sessionId);
    if (next.previousLease.lease_id !== value.lease.lease_id
      || ![next.previousLease.generation, (next.previousLease.generation as number) + 1].includes(value.lease.generation)
      || value.lease.generation === next.previousLease.generation && value.phase !== "paused"
      || next.prepared === false && value.phase !== "paused"
      || next.prepared === true && value.lease.generation !== (next.previousLease.generation as number) + 1
      || value.phase !== "paused" && value.captureAuthorizedUntil !== value.lease.expires_at) {
      throw new QueueInvariantError("invalid_active_capture_state");
    }
  }
}

export function assertActiveCaptureProgression(
  existing: ActiveCaptureState,
  replacement: ActiveCaptureState,
): void {
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const begins = replacement.continuation !== undefined
    && replacement.continuation.renewIdempotencyKey !== existing.continuation?.renewIdempotencyKey;
  const prepared = existing.continuation?.prepared === false && replacement.continuation?.prepared === true
    && same({ ...existing.continuation, prepared: true }, replacement.continuation)
    && existing.phase === "paused" && replacement.phase === "ready"
    && replacement.lease.generation === existing.continuation.previousLease.generation + 1
    && replacement.captureAuthorizedUntil === replacement.lease.expires_at;
  const renewed = existing.continuation !== undefined && same(existing.continuation, replacement.continuation)
    && same(existing.lease, existing.continuation.previousLease)
    && replacement.lease.lease_id === existing.lease.lease_id
    && replacement.lease.session_id === existing.sessionId
    && replacement.lease.generation === existing.lease.generation + 1
    && replacement.lease.receipt_id !== existing.lease.receipt_id
    && Date.parse(replacement.lease.expires_at) > Date.parse(replacement.lease.issued_at)
    && replacement.captureAuthorizedUntil === null && existing.phase === "paused" && replacement.phase === "paused";
  if (begins && (existing.reviewAfterUpload !== true || existing.phase !== "paused" || replacement.phase !== "paused"
    || !same(existing.lease, replacement.continuation.previousLease)
    || replacement.continuation.firstSequenceNumber !== existing.recordedChunks
    || replacement.continuation.prepared !== false || existing.continuation?.prepared === false
      && !(existing.lease.generation === existing.continuation.previousLease.generation + 1
        && Date.parse(replacement.continuation.previousLease.issued_at) >= Date.parse(existing.lease.issued_at)))) {
    throw new QueueInvariantError("active_capture_conflict");
  }
  if (
    (!same(existing.lease, replacement.lease) && !renewed) ||
    (!same(existing.continuation, replacement.continuation) && !begins && !prepared) ||
    (existing.schemaVersion !== replacement.schemaVersion && !(begins && replacement.schemaVersion === CONTINUATION_FLOW_RECORD_SCHEMA_VERSION)) || existing.channel !== replacement.channel ||
    existing.reviewAfterUpload !== replacement.reviewAfterUpload ||
    existing.completeIdempotencyKey !== replacement.completeIdempotencyKey ||
    existing.startedAt !== replacement.startedAt ||
    existing.aggregatePlaintextBudgetBytes !== replacement.aggregatePlaintextBudgetBytes ||
    (!nullableStable(existing.captureAuthorizedUntil, replacement.captureAuthorizedUntil) && !renewed) ||
    replacement.recordedChunks < existing.recordedChunks ||
    replacement.recordedPlaintextBytes < existing.recordedPlaintextBytes
  ) {
    throw new QueueInvariantError("active_capture_conflict");
  }
}

function assertLease(value: Record<string, unknown>, sessionId: string): void {
  if (
    value.protocol_version !== "1.0" ||
    typeof value.receipt_id !== "string" ||
    typeof value.lease_id !== "string" ||
    value.session_id !== sessionId ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    typeof value.issued_at !== "string" ||
    typeof value.expires_at !== "string"
  ) {
    throw new QueueInvariantError("invalid_active_capture_state");
  }
  assertUuid(value.receipt_id, "invalid_active_capture_state");
  assertUuid(value.lease_id, "invalid_active_capture_state");
  if (Number.isNaN(Date.parse(value.issued_at)) || Number.isNaN(Date.parse(value.expires_at))) {
    throw new QueueInvariantError("invalid_active_capture_state");
  }
}

function isActiveCapturePhase(value: unknown): value is ActiveCaptureState["phase"] {
  return (
    value === "ready" ||
    value === "recording" ||
    value === "paused" ||
    value === "uploading" ||
    value === "completing" ||
    value === "processing"
  );
}

export function assertSessionKeyState(value: unknown): asserts value is SessionKeyBindingState {
  if (
    !isRecord(value) ||
    value.schemaVersion !== FLOW_RECORD_SCHEMA_VERSION ||
    typeof value.sessionId !== "string" ||
    typeof value.keyVersion !== "string" ||
    typeof value.wrappedDek !== "string" ||
    typeof value.idempotencyKey !== "string" ||
    (value.state !== "pending" && value.state !== "bound")
  ) {
    throw new QueueInvariantError("invalid_session_key_state");
  }
  assertUuid(value.sessionId, "invalid_session_key_state");
  assertIdempotencyKey(value.idempotencyKey);
  if (!/^[A-Za-z0-9_-]{64,1024}$/u.test(value.wrappedDek)) {
    throw new QueueInvariantError("invalid_session_key_state");
  }
}

function assertAesKey(key: CryptoKey, code: string): void {
  const algorithm = key.algorithm as AesKeyAlgorithm;
  if (
    key.type !== "secret" ||
    key.extractable ||
    algorithm.name !== "AES-GCM" ||
    algorithm.length !== 256 ||
    !key.usages.includes("encrypt") ||
    !key.usages.includes("decrypt")
  ) {
    throw new QueueInvariantError(code);
  }
}

export function assertSessionDek(key: CryptoKey): void {
  const algorithm = key.algorithm as AesKeyAlgorithm;
  if (
    key.type !== "secret" ||
    key.extractable ||
    algorithm.name !== "AES-GCM" ||
    algorithm.length !== 256 ||
    key.usages.length !== 1 ||
    key.usages[0] !== "encrypt"
  ) {
    throw new QueueInvariantError("invalid_session_dek");
  }
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "extractable" in value &&
    "algorithm" in value &&
    "usages" in value &&
    Array.isArray(value.usages)
  );
}

function assertSealedRecord(value: unknown): asserts value is SealedFlowRecord {
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    !(value.nonce instanceof Uint8Array) ||
    value.nonce.byteLength !== NONCE_BYTES ||
    !(value.ciphertext instanceof ArrayBuffer) ||
    value.ciphertext.byteLength < 16
  ) {
    throw new QueueInvariantError("invalid_flow_store_record");
  }
}

function assertIdentifier(value: string, code: string): void {
  if (!/^[A-Za-z0-9._:-]{1,255}$/u.test(value)) throw new QueueInvariantError(code);
}

function assertUuid(value: string, code: string): void {
  if (!UUID_PATTERN.test(value)) throw new QueueInvariantError(code);
}

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_PATTERN.test(value)) {
    throw new QueueInvariantError("invalid_idempotency_key");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localAdditionalData(key: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${LOCAL_AAD_PREFIX}:${key}`);
}

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(new QueueInvariantError("flow_database_error")));
  });
}

function transactionDone(
  transaction: IDBTransaction,
  failure?: () => Error | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(failure?.() ?? new QueueInvariantError("flow_database_aborted")));
    transaction.addEventListener("error", () => reject(new QueueInvariantError("flow_database_error")));
  });
}
