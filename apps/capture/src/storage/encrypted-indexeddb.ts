import { NONCE_BYTES } from "@cosmaneura-scribe/capture-protocol";

import { QueueInvariantError } from "../queue/errors";
import { assertSafeCaptureRecord, captureChunkMetadata, cloneCaptureRecord } from "../queue/records";
import type {
  CaptureChunkRecord,
  CaptureChunkMetadata,
  CaptureQueueStorage,
  ReservedChunkRecord,
} from "../queue/types";
import { decodeCaptureRecord, encodeCaptureRecord } from "./record-codec";

const DATABASE_VERSION = 1;
const RECORD_STORE = "encrypted-chunks";
const METADATA_STORE = "metadata";
const ENCRYPTION_KEY_ID = "queue-encryption-key-v1";
const LOCAL_AAD_PREFIX = "cosmaneura-capture-local-queue:v1";

export interface EncryptedIndexedDbOptions {
  readonly databaseName?: string;
  readonly indexedDB?: IDBFactory;
  readonly crypto?: Crypto;
}

interface SealedRecord {
  readonly objectId: string;
  readonly revision: number;
  readonly nonce: Uint8Array<ArrayBuffer>;
  readonly ciphertext: ArrayBuffer;
}

/**
 * PWA queue store. Values are AES-256-GCM encrypted before entering IndexedDB;
 * the non-extractable origin-bound key is itself structured-cloned by IndexedDB.
 * Failure to persist or use that key fails closed—there is no plaintext mode.
 */
export class EncryptedIndexedDbQueueStorage implements CaptureQueueStorage {
  readonly #database: IDBDatabase;
  readonly #encryptionKey: CryptoKey;
  readonly #crypto: Crypto;

  private constructor(database: IDBDatabase, encryptionKey: CryptoKey, crypto: Crypto) {
    this.#database = database;
    this.#encryptionKey = encryptionKey;
    this.#crypto = crypto;
  }

  static async open(options: EncryptedIndexedDbOptions = {}): Promise<EncryptedIndexedDbQueueStorage> {
    const indexedDB = options.indexedDB ?? globalThis.indexedDB;
    const crypto = options.crypto ?? globalThis.crypto;
    if (indexedDB === undefined || crypto?.subtle === undefined) {
      throw new QueueInvariantError("encrypted_queue_unavailable");
    }
    const database = await openDatabase(indexedDB, options.databaseName ?? "cosmaneura-capture-queue");
    try {
      const encryptionKey = await getOrCreateEncryptionKey(database, crypto);
      assertLocalEncryptionKey(encryptionKey);
      return new EncryptedIndexedDbQueueStorage(database, encryptionKey, crypto);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async create(record: ReservedChunkRecord): Promise<boolean> {
    assertSafeCaptureRecord(record);
    const sealed = await this.#seal(record);
    const transaction = this.#database.transaction(RECORD_STORE, "readwrite");
    const store = transaction.objectStore(RECORD_STORE);
    let created = false;
    const lookup = store.get(record.reservation.objectId);
    lookup.addEventListener("success", () => {
      if (lookup.result === undefined) {
        store.add(sealed);
        created = true;
      }
    });
    await transactionDone(transaction);
    return created;
  }

  async get(objectId: string): Promise<CaptureChunkRecord | null> {
    const transaction = this.#database.transaction(RECORD_STORE, "readonly");
    const done = transactionDone(transaction);
    const request = transaction.objectStore(RECORD_STORE).get(objectId) as IDBRequest<unknown>;
    const result = await requestResult(request);
    await done;
    if (result === undefined) return null;
    assertSealedRecord(result);
    return this.#open(result);
  }

  async list(): Promise<readonly CaptureChunkRecord[]> {
    const records: CaptureChunkRecord[] = [];
    for await (const record of this.#scan()) records.push(record);
    return records.sort(compareRecords);
  }

  async listMetadata(): Promise<readonly CaptureChunkMetadata[]> {
    const records: CaptureChunkMetadata[] = [];
    for await (const record of this.#scan()) records.push(captureChunkMetadata(record));
    return records.sort(compareRecords);
  }

  async *#scan(): AsyncGenerator<CaptureChunkRecord> {
    const transaction = this.#database.transaction(RECORD_STORE, "readonly");
    const done = transactionDone(transaction);
    const request = transaction.objectStore(RECORD_STORE).getAllKeys();
    const keys = await requestResult(request);
    await done;
    for (const key of keys) {
      if (typeof key !== "string") throw new QueueInvariantError("invalid_encrypted_queue_record");
      const record = await this.get(key);
      if (record === null) throw new QueueInvariantError("invalid_encrypted_queue_record");
      yield record;
    }
  }

  async compareAndSwap(
    objectId: string,
    expectedRevision: number,
    replacement: CaptureChunkRecord,
  ): Promise<boolean> {
    assertSafeCaptureRecord(replacement);
    if (
      replacement.reservation.objectId !== objectId ||
      replacement.revision !== expectedRevision + 1
    ) {
      throw new QueueInvariantError("invalid_compare_and_swap");
    }
    const sealed = await this.#seal(replacement);
    const transaction = this.#database.transaction(RECORD_STORE, "readwrite");
    const store = transaction.objectStore(RECORD_STORE);
    let swapped = false;
    const lookup = store.get(objectId);
    lookup.addEventListener("success", () => {
      const current = lookup.result as SealedRecord | undefined;
      if (current?.revision === expectedRevision) {
        store.put(sealed);
        swapped = true;
      }
    });
    await transactionDone(transaction);
    return swapped;
  }

  close(): void {
    this.#database.close();
  }

  async #seal(record: CaptureChunkRecord): Promise<SealedRecord> {
    const safe = cloneCaptureRecord(record);
    const nonce = this.#crypto.getRandomValues(new Uint8Array(new ArrayBuffer(NONCE_BYTES)));
    const plaintext = new TextEncoder().encode(encodeCaptureRecord(safe));
    let ciphertext: ArrayBuffer;
    try {
      ciphertext = await this.#crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: localAdditionalData(
            safe.reservation.objectId,
            safe.revision,
          ),
        },
        this.#encryptionKey,
        plaintext,
      );
    } finally {
      plaintext.fill(0);
    }
    return {
      objectId: safe.reservation.objectId,
      revision: safe.revision,
      nonce,
      ciphertext,
    };
  }

  async #open(sealed: SealedRecord): Promise<CaptureChunkRecord> {
    assertSealedRecord(sealed);
    let plaintext: ArrayBuffer;
    try {
      plaintext = await this.#crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: sealed.nonce,
          additionalData: localAdditionalData(sealed.objectId, sealed.revision),
        },
        this.#encryptionKey,
        sealed.ciphertext,
      );
    } catch {
      throw new QueueInvariantError("encrypted_queue_integrity_failure");
    }
    const bytes = new Uint8Array(plaintext);
    let record: CaptureChunkRecord;
    try {
      record = decodeCaptureRecord(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new QueueInvariantError("encrypted_queue_integrity_failure");
    } finally {
      bytes.fill(0);
    }
    if (
      record.reservation.objectId !== sealed.objectId ||
      record.revision !== sealed.revision
    ) {
      throw new QueueInvariantError("encrypted_queue_integrity_failure");
    }
    return record;
  }
}

async function openDatabase(indexedDB: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(RECORD_STORE)) {
        database.createObjectStore(RECORD_STORE, { keyPath: "objectId" });
      }
      if (!database.objectStoreNames.contains(METADATA_STORE)) {
        database.createObjectStore(METADATA_STORE);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new QueueInvariantError("queue_database_error")),
    );
    request.addEventListener("blocked", () => reject(new QueueInvariantError("queue_database_blocked")));
  });
}

async function getOrCreateEncryptionKey(database: IDBDatabase, crypto: Crypto): Promise<CryptoKey> {
  const candidate = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([METADATA_STORE, RECORD_STORE], "readwrite");
    const metadataStore = transaction.objectStore(METADATA_STORE);
    const lookup = metadataStore.get(ENCRYPTION_KEY_ID);
    let selected: CryptoKey = candidate;
    let failure: QueueInvariantError | undefined;
    lookup.addEventListener("success", () => {
      if (lookup.result === undefined) {
        const recordCount = transaction.objectStore(RECORD_STORE).count();
        recordCount.addEventListener("success", () => {
          if (recordCount.result !== 0) {
            failure = new QueueInvariantError("queue_encryption_key_missing");
            transaction.abort();
            return;
          }
          metadataStore.add(candidate, ENCRYPTION_KEY_ID);
        });
      } else {
        selected = lookup.result as CryptoKey;
      }
    });
    transaction.addEventListener("complete", () => resolve(selected));
    transaction.addEventListener("abort", () =>
      reject(failure ?? transaction.error ?? new QueueInvariantError("queue_database_aborted")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new QueueInvariantError("queue_database_error")),
    );
  });
}

function assertLocalEncryptionKey(key: CryptoKey): void {
  const algorithm = key.algorithm as AesKeyAlgorithm;
  if (
    key.type !== "secret" ||
    key.extractable ||
    algorithm.name !== "AES-GCM" ||
    algorithm.length !== 256 ||
    !key.usages.includes("encrypt") ||
    !key.usages.includes("decrypt")
  ) {
    throw new QueueInvariantError("invalid_queue_encryption_key");
  }
}

function assertSealedRecord(value: unknown): asserts value is SealedRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    !("objectId" in value) ||
    typeof value.objectId !== "string" ||
    !("revision" in value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !("nonce" in value) ||
    !(value.nonce instanceof Uint8Array) ||
    value.nonce.byteLength !== NONCE_BYTES ||
    !("ciphertext" in value) ||
    !(value.ciphertext instanceof ArrayBuffer) ||
    value.ciphertext.byteLength < 16
  ) {
    throw new QueueInvariantError("invalid_encrypted_queue_record");
  }
}

function localAdditionalData(objectId: string, revision: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    new TextEncoder().encode(`${LOCAL_AAD_PREFIX}:${objectId}:${String(revision)}`),
  );
}

function compareRecords(left: CaptureChunkMetadata, right: CaptureChunkMetadata): number {
  const sessionOrder = left.reservation.sessionId.localeCompare(right.reservation.sessionId);
  if (sessionOrder !== 0) return sessionOrder;
  const channelOrder = left.reservation.channel.localeCompare(right.reservation.channel);
  if (channelOrder !== 0) return channelOrder;
  return left.reservation.sequenceNumber - right.reservation.sequenceNumber;
}

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new QueueInvariantError("queue_database_error")),
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new QueueInvariantError("queue_database_aborted")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new QueueInvariantError("queue_database_error")),
    );
  });
}
