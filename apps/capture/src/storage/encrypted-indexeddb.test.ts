import { webcrypto } from "node:crypto";

import {
  base64UrlEncode,
  encodeChunkAdditionalDataBase64Url,
  encodeEnvelope,
  NONCE_BYTES,
  PROTOCOL_VERSION,
} from "@cosmaneura-scribe/capture-protocol";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { CaptureQueue } from "../queue/capture-queue";
import { createReservedRecord } from "../queue/records";
import type { ChunkReservation, ReservedChunkRecord } from "../queue/types";
import { EncryptedIndexedDbQueueStorage } from "./encrypted-indexeddb";

const TEST_CRYPTO = webcrypto as unknown as Crypto;
const DATABASE_NAME = "encrypted-storage-test";

describe("EncryptedIndexedDbQueueStorage", () => {
  it("stores only sealed records and reopens them with a persisted non-extractable key", async () => {
    const indexedDB = new IDBFactory();
    const storage = await EncryptedIndexedDbQueueStorage.open({
      databaseName: DATABASE_NAME,
      indexedDB,
      crypto: TEST_CRYPTO,
    });
    const queue = new CaptureQueue(storage, {
      crypto: TEST_CRYPTO,
      idempotencyKeyFactory: sequentialKeys(),
    });
    const reservation = reservationFixture();
    const inputEnvelope = envelopeFixture();
    const expectedEnvelope = inputEnvelope.slice();
    await queue.reserve(reservation, "reservation-idempotency-0001");
    await queue.encrypt(reservation.objectId, inputEnvelope);
    inputEnvelope.fill(255);

    const raw = await readRawRecords(indexedDB, DATABASE_NAME);
    expect(raw).toHaveLength(1);
    const persistedText = JSON.stringify(raw[0]);
    expect(persistedText).not.toContain("additionalAuthenticatedData");
    expect(persistedText).not.toContain("idempotencyKeys");
    expect(persistedText).not.toContain(base64UrlEncode(expectedEnvelope));
    expect(Object.keys(raw[0] as object).sort()).toEqual([
      "ciphertext",
      "nonce",
      "objectId",
      "revision",
    ]);
    storage.close();

    const reopened = await EncryptedIndexedDbQueueStorage.open({
      databaseName: DATABASE_NAME,
      indexedDB,
      crypto: TEST_CRYPTO,
    });
    const recovered = await reopened.get(reservation.objectId);
    expect(recovered?.state).toBe("encrypted");
    if (recovered?.state !== "encrypted") throw new Error("unexpected test state");
    expect(recovered.envelope).toEqual(expectedEnvelope);
    reopened.close();
  });

  it.each(["sas", "uploadUrl", "entraToken", "rawDEK", "patientDisplayValue", "blobPath"])(
    "rejects the forbidden persisted field %s",
    async (field) => {
      const indexedDB = new IDBFactory();
      const storage = await EncryptedIndexedDbQueueStorage.open({
        databaseName: `${DATABASE_NAME}-${field}`,
        indexedDB,
        crypto: TEST_CRYPTO,
      });
      const safe = createReservedRecord(reservationFixture(), {
        reservation: "reservation-idempotency-0001",
        uploadAuthorization: "authorization-idempotency-0001",
        uploadAuthorizationGeneration: 1,
        registration: "registration-idempotency-0001",
      });
      const unsafe = {
        ...safe,
        [field]: field === "rawDEK" ? new Uint8Array(32) : "must-not-persist",
      } as unknown as ReservedChunkRecord;
      await expect(storage.create(unsafe)).rejects.toEqual(
        expect.objectContaining({ code: "forbidden_persisted_field" }),
      );
      expect(await storage.list()).toEqual([]);
      storage.close();
    },
  );

  it("fails closed when the encryption key is missing but sealed records remain", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = `${DATABASE_NAME}-missing-key`;
    const storage = await EncryptedIndexedDbQueueStorage.open({
      databaseName,
      indexedDB,
      crypto: TEST_CRYPTO,
    });
    await storage.create(
      createReservedRecord(reservationFixture(), {
        reservation: "reservation-idempotency-0001",
        uploadAuthorization: "authorization-idempotency-0001",
        uploadAuthorizationGeneration: 1,
        registration: "registration-idempotency-0001",
      }),
    );
    storage.close();
    await deleteQueueEncryptionKey(indexedDB, databaseName);

    await expect(
      EncryptedIndexedDbQueueStorage.open({
        databaseName,
        indexedDB,
        crypto: TEST_CRYPTO,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "queue_encryption_key_missing" }),
    );
    expect(await countMetadataKeys(indexedDB, databaseName)).toBe(0);
  });
});

function reservationFixture(): ChunkReservation {
  const tenantId = "50000000-0000-4000-8000-000000000005";
  const sessionId = "60000000-0000-4000-8000-000000000006";
  const objectId = "70000000-0000-4000-8000-000000000007";
  return {
    protocolVersion: PROTOCOL_VERSION,
    objectId,
    sessionId,
    channel: "microphone",
    sequenceNumber: 0,
    additionalAuthenticatedData: encodeChunkAdditionalDataBase64Url({
      tenantId,
      sessionId,
      objectId,
      sequenceNumber: 0,
      channel: "microphone",
    }),
    createdAt: "2026-08-17T12:00:00.000Z",
  };
}

function envelopeFixture(): Uint8Array {
  return encodeEnvelope(
    {
      schema_version: PROTOCOL_VERSION,
      content_encryption: "A256GCM",
      nonce: base64UrlEncode(new Uint8Array(NONCE_BYTES).fill(7)),
      media_type: "audio/wav",
    },
    new Uint8Array(48).fill(8),
  );
}

function sequentialKeys(): () => string {
  let index = 0;
  return () => `queue-idempotency-${String(++index).padStart(4, "0")}`;
}

async function readRawRecords(indexedDB: IDBFactory, name: string): Promise<unknown[]> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
  try {
    const transaction = database.transaction("encrypted-chunks", "readonly");
    const done = new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => reject(transaction.error));
      transaction.addEventListener("abort", () => reject(transaction.error));
    });
    const values = await new Promise<unknown[]>((resolve, reject) => {
      const request = transaction.objectStore("encrypted-chunks").getAll();
      request.addEventListener("success", () => resolve(request.result as unknown[]));
      request.addEventListener("error", () => reject(request.error));
    });
    await done;
    return values;
  } finally {
    database.close();
  }
}

async function deleteQueueEncryptionKey(indexedDB: IDBFactory, name: string): Promise<void> {
  const database = await openExistingDatabase(indexedDB, name);
  try {
    const transaction = database.transaction("metadata", "readwrite");
    transaction.objectStore("metadata").delete("queue-encryption-key-v1");
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

async function countMetadataKeys(indexedDB: IDBFactory, name: string): Promise<number> {
  const database = await openExistingDatabase(indexedDB, name);
  try {
    const transaction = database.transaction("metadata", "readonly");
    const request = transaction.objectStore("metadata").count();
    const result = await new Promise<number>((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    await waitForTransaction(transaction);
    return result;
  } finally {
    database.close();
  }
}

function openExistingDatabase(indexedDB: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
    transaction.addEventListener("abort", () => reject(transaction.error));
  });
}
