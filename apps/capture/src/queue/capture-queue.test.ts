import { webcrypto } from "node:crypto";

import {
  base64UrlEncode,
  encodeChunkAdditionalDataBase64Url,
  encodeEnvelope,
  NONCE_BYTES,
  PROTOCOL_VERSION,
} from "@cosmaneura-scribe/capture-protocol";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

import { EncryptedIndexedDbQueueStorage } from "../storage/encrypted-indexeddb";
import { CaptureQueue } from "./capture-queue";
import { QueueTransportError } from "./errors";
import type { QueueInvariantError } from "./errors";
import type {
  CaptureQueueTransport,
  ChunkReservation,
  RegisterChunkRequest,
  RegistrationReceipt,
  UploadAuthorization,
} from "./types";

const TEST_CRYPTO = webcrypto as unknown as Crypto;
const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const TENANT_ID = "20000000-0000-4000-8000-000000000002";
const REGISTERED_AT = "2026-08-17T12:00:00.000Z";

describe("CaptureQueue", () => {
  it("persists every ordered state and removes bytes only after a registration receipt", async () => {
    const harness = await createHarness();
    const states: string[] = [];
    const storage = {
      create: async (record: Parameters<typeof harness.storage.create>[0]) => {
        states.push(record.state);
        return harness.storage.create(record);
      },
      get: (objectId: string) => harness.storage.get(objectId),
      list: () => harness.storage.list(),
      compareAndSwap: async (
        objectId: string,
        revision: number,
        replacement: Parameters<typeof harness.storage.compareAndSwap>[2],
      ) => {
        const swapped = await harness.storage.compareAndSwap(objectId, revision, replacement);
        if (swapped) states.push(replacement.state);
        return swapped;
      },
    };
    const queue = harness.queueWithStorage(storage);
    const reservation = makeReservation(0);
    await queue.reserve(reservation, "reservation-batch-0001");
    await queue.encrypt(reservation.objectId, makeEnvelope(1));
    await queue.drainOnce(successfulTransport(() => harness.now.value));
    const purged = await queue.purge(reservation.objectId);

    expect(states).toEqual([
      "reserved",
      "encrypted",
      "uploading",
      "uploaded",
      "registered",
      "purged",
    ]);
    expect(purged.state).toBe("purged");
    expect("envelope" in purged).toBe(false);
    harness.storage.close();
  });

  it("replays an unknown registration success with the identical key and body", async () => {
    const harness = await createHarness({ baseRetryMs: 100, random: () => 0 });
    const reservation = makeReservation(0);
    await harness.queue.reserve(reservation, "reservation-batch-0001");
    await harness.queue.encrypt(reservation.objectId, makeEnvelope(2));

    const requests: RegisterChunkRequest[] = [];
    let registrationAttempt = 0;
    const transport = successfulTransport(() => harness.now.value, {
      register: async (request) => {
        requests.push({ ...request });
        registrationAttempt += 1;
        if (registrationAttempt === 1) {
          throw new QueueTransportError("unknown_success", "registration_timeout");
        }
        return receiptFor(request);
      },
      receiptAlwaysReserved: true,
    });

    const first = await harness.queue.drainOnce(transport);
    expect(first.items[0]).toMatchObject({ outcome: "deferred", code: "registration_timeout" });
    expect((await harness.queue.get(reservation.objectId))?.state).toBe("uploaded");

    harness.now.value = 1_000;
    const second = await harness.queue.drainOnce(transport);
    expect(second.items[0]).toMatchObject({ outcome: "registered" });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[1]?.idempotencyKey).toBe(requests[0]?.idempotencyKey);
    harness.storage.close();
  });

  it("retries a transient receipt failure without terminalizing the chunk", async () => {
    const harness = await createHarness({ baseRetryMs: 100, random: () => 0 });
    const reservation = makeReservation(0);
    await harness.queue.reserve(reservation, "reservation-batch-0001");
    await harness.queue.encrypt(reservation.objectId, makeEnvelope(2));

    let receiptAttempt = 0;
    const transport = successfulTransport(() => harness.now.value, {
      receipt: async () => {
        receiptAttempt += 1;
        if (receiptAttempt === 1) {
          throw new QueueTransportError("retryable", "bff_temporarily_unavailable");
        }
        return { state: "reserved" };
      },
    });

    const first = await harness.queue.drainOnce(transport);
    expect(first.items[0]).toMatchObject({
      outcome: "deferred",
      code: "bff_temporarily_unavailable",
    });
    const deferred = await harness.queue.get(reservation.objectId);
    expect(deferred?.state).toBe("uploading");
    expect(deferred?.retry.upload).toMatchObject({
      attempts: 1,
      notBeforeEpochMs: 50,
      terminalCode: null,
    });

    harness.now.value = 50;
    const second = await harness.queue.drainOnce(transport);
    expect(second.items[0]).toMatchObject({ outcome: "registered" });
    expect(receiptAttempt).toBe(3);
    expect((await harness.queue.get(reservation.objectId))?.state).toBe("registered");
    harness.storage.close();
  });

  it("rotates only the expired authorization key while retaining object, AAD, and bytes", async () => {
    const harness = await createHarness();
    const reservation = makeReservation(0);
    await harness.queue.reserve(reservation, "reservation-batch-0001");
    await harness.queue.encrypt(reservation.objectId, makeEnvelope(3));
    const before = await harness.queue.get(reservation.objectId);
    expect(before?.state).toBe("encrypted");

    const authorizationKeys: string[] = [];
    let authorizationAttempt = 0;
    const transport = successfulTransport(() => harness.now.value, {
      authorize: async (sessionId, objectId, idempotencyKey) => {
        expect(sessionId).toBe(reservation.sessionId);
        authorizationKeys.push(idempotencyKey);
        authorizationAttempt += 1;
        return {
          objectId,
          additionalAuthenticatedData: reservation.additionalAuthenticatedData,
          uploadUrl: `https://upload.invalid/${String(authorizationAttempt)}`,
          expiresAtEpochMs: authorizationAttempt === 1 ? harness.now.value : harness.now.value + 60_000,
        };
      },
    });

    await harness.queue.drainOnce(transport);
    const refreshed = await harness.queue.get(reservation.objectId);
    expect(refreshed?.state).toBe("uploading");
    expect(refreshed?.reservation).toEqual(reservation);
    if (before?.state !== "encrypted" || refreshed?.state !== "uploading") {
      throw new Error("unexpected test state");
    }
    expect(refreshed.envelope).toEqual(before.envelope);
    expect(refreshed.sha256).toBe(before.sha256);
    expect(refreshed.byteLength).toBe(before.byteLength);
    expect(refreshed.idempotencyKeys.uploadAuthorizationGeneration).toBe(2);

    await harness.queue.drainOnce(transport);
    expect(authorizationKeys).toHaveLength(2);
    expect(authorizationKeys[1]).not.toBe(authorizationKeys[0]);
    expect((await harness.queue.get(reservation.objectId))?.state).toBe("registered");
    harness.storage.close();
  });

  it("never exceeds two simultaneous uploads", async () => {
    const harness = await createHarness();
    for (let sequence = 0; sequence < 5; sequence += 1) {
      const reservation = makeReservation(sequence);
      await harness.queue.reserve(reservation, "reservation-batch-0001");
      await harness.queue.encrypt(reservation.objectId, makeEnvelope(sequence + 10));
    }

    let active = 0;
    let maximumActive = 0;
    let started = 0;
    let releaseUploads: (() => void) | undefined;
    let confirmTwoStarted: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseUploads = resolve;
    });
    const twoStarted = new Promise<void>((resolve) => {
      confirmTwoStarted = resolve;
    });
    const transport = successfulTransport(() => harness.now.value, {
      upload: async () => {
        active += 1;
        started += 1;
        maximumActive = Math.max(maximumActive, active);
        if (started === 2) confirmTwoStarted?.();
        await release;
        active -= 1;
      },
    });

    const draining = harness.queue.drainOnce(transport);
    await twoStarted;
    expect(active).toBe(2);
    expect(started).toBe(2);
    releaseUploads?.();
    await draining;
    expect(maximumActive).toBe(2);
    expect((await harness.queue.list()).every((record) => record.state === "registered")).toBe(true);
    harness.storage.close();
  });

  it("honors a lower server-configured upload concurrency", async () => {
    const harness = await createHarness();
    harness.queue.configureUploadConcurrency(1);
    for (let sequence = 0; sequence < 3; sequence += 1) {
      const reservation = makeReservation(sequence);
      await harness.queue.reserve(reservation, "reservation-batch-0001");
      await harness.queue.encrypt(reservation.objectId, makeEnvelope(sequence + 50));
    }

    let active = 0;
    let maximumActive = 0;
    let uploadCalls = 0;
    const transport = successfulTransport(() => harness.now.value, {
      upload: async () => {
        uploadCalls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
      },
    });

    await harness.queue.drainOnce(transport);
    expect(maximumActive).toBe(1);
    expect(uploadCalls).toBe(3);
    harness.storage.close();
  });

  it("rejects invalid runtime upload concurrency", async () => {
    const harness = await createHarness();
    expect(() => harness.queue.configureUploadConcurrency(0)).toThrow(
      "invalid_upload_concurrency",
    );
    expect(() => harness.queue.configureUploadConcurrency(3)).toThrow(
      "invalid_upload_concurrency",
    );
    harness.storage.close();
  });

  it("serializes drains across queue instances sharing one origin", async () => {
    const previousLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, "locks");
    let lockHeld = false;
    const request = vi.fn(async (
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => Promise<unknown>,
    ) => {
      if (lockHeld) return callback(null);
      lockHeld = true;
      try {
        return await callback({ mode: "exclusive", name: "synthetic-drain-lock" });
      } finally {
        lockHeld = false;
      }
    });
    Object.defineProperty(globalThis.navigator, "locks", {
      configurable: true,
      value: { request },
    });
    const harness = await createHarness();
    const reservation = makeReservation(0);
    await harness.queue.reserve(reservation, "reservation-batch-0001");
    await harness.queue.encrypt(reservation.objectId, makeEnvelope(19));
    const secondQueue = harness.queueWithStorage(harness.storage);
    let releaseUpload: (() => void) | undefined;
    let confirmUploadStarted: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const started = new Promise<void>((resolve) => {
      confirmUploadStarted = resolve;
    });
    const transport = successfulTransport(() => harness.now.value, {
      upload: async () => {
        confirmUploadStarted?.();
        await release;
      },
    });

    try {
      const firstDrain = harness.queue.drainOnce(transport);
      await started;
      await expect(secondQueue.drainOnce(transport)).rejects.toMatchObject({
        code: "queue_drain_in_progress",
      });
      releaseUpload?.();
      await firstDrain;
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      releaseUpload?.();
      harness.storage.close();
      if (previousLocks === undefined) delete (globalThis.navigator as { locks?: LockManager }).locks;
      else Object.defineProperty(globalThis.navigator, "locks", previousLocks);
    }
  });

  it("uses exponential jitter and honors Retry-After", async () => {
    const harness = await createHarness({ baseRetryMs: 100, random: () => 0.5 });
    const reservation = makeReservation(0);
    await harness.queue.reserve(reservation, "reservation-batch-0001");
    await harness.queue.encrypt(reservation.objectId, makeEnvelope(20));
    let uploadAttempt = 0;
    const transport = successfulTransport(() => harness.now.value, {
      upload: async () => {
        uploadAttempt += 1;
        if (uploadAttempt === 1) {
          throw new QueueTransportError("retryable", "edge_busy");
        }
        if (uploadAttempt === 2) {
          throw new QueueTransportError("retryable", "edge_throttled", { retryAfterMs: 5_000 });
        }
      },
    });

    await harness.queue.drainOnce(transport);
    let current = await harness.queue.get(reservation.objectId);
    expect(current?.retry.upload.notBeforeEpochMs).toBe(75);

    await harness.queue.drainOnce(transport);
    expect(uploadAttempt).toBe(1);
    harness.now.value = 75;
    await harness.queue.drainOnce(transport);
    current = await harness.queue.get(reservation.objectId);
    expect(current?.retry.upload.attempts).toBe(2);
    expect(current?.retry.upload.notBeforeEpochMs).toBe(5_075);

    harness.now.value = 5_074;
    await harness.queue.drainOnce(transport);
    expect(uploadAttempt).toBe(2);
    harness.now.value = 5_075;
    await harness.queue.drainOnce(transport);
    expect(uploadAttempt).toBe(3);
    expect((await harness.queue.get(reservation.objectId))?.state).toBe("registered");
    harness.storage.close();
  });

  it("recovers an uploading record after a restart and replays identical bytes", async () => {
    const factory = new IDBFactory();
    const databaseName = "crash-recovery";
    const now = { value: 1_000 };
    const firstStorage = await EncryptedIndexedDbQueueStorage.open({
      databaseName,
      indexedDB: factory,
      crypto: TEST_CRYPTO,
    });
    const firstQueue = new CaptureQueue(firstStorage, queueOptions(now));
    const reservation = makeReservation(0);
    const envelope = makeEnvelope(30);
    await firstQueue.reserve(reservation, "reservation-batch-0001");
    await firstQueue.encrypt(reservation.objectId, envelope);
    const uploads: Uint8Array[] = [];
    const failingTransport = successfulTransport(() => now.value, {
      upload: async (_url, bytes) => {
        uploads.push(bytes.slice());
        throw new QueueTransportError("unknown_success", "upload_timeout");
      },
    });
    await firstQueue.drainOnce(failingTransport);
    expect((await firstQueue.get(reservation.objectId))?.state).toBe("uploading");
    firstStorage.close();

    now.value += 10_000;
    const recoveredStorage = await EncryptedIndexedDbQueueStorage.open({
      databaseName,
      indexedDB: factory,
      crypto: TEST_CRYPTO,
    });
    const recoveredQueue = new CaptureQueue(recoveredStorage, queueOptions(now));
    const recoveredTransport = successfulTransport(() => now.value, {
      upload: async (_url, bytes) => {
        uploads.push(bytes.slice());
      },
    });
    await recoveredQueue.drainOnce(recoveredTransport);

    expect(uploads).toHaveLength(2);
    expect(uploads[0]).toEqual(envelope);
    expect(uploads[1]).toEqual(uploads[0]);
    expect((await recoveredQueue.get(reservation.objectId))?.state).toBe("registered");
    recoveredStorage.close();
  });

  it("rejects purge before the registration receipt exists", async () => {
    const harness = await createHarness();
    const reservation = makeReservation(0);
    await harness.queue.reserve(reservation, "reservation-batch-0001");
    await harness.queue.encrypt(reservation.objectId, makeEnvelope(40));

    await expect(harness.queue.purge(reservation.objectId)).rejects.toEqual(
      expect.objectContaining<Partial<QueueInvariantError>>({ code: "registration_receipt_required" }),
    );
    expect((await harness.queue.get(reservation.objectId))?.state).toBe("encrypted");
    harness.storage.close();
  });
});

interface HarnessOptions {
  readonly baseRetryMs?: number;
  readonly random?: () => number;
}

async function createHarness(options: HarnessOptions = {}) {
  const factory = new IDBFactory();
  const storage = await EncryptedIndexedDbQueueStorage.open({
    databaseName: TEST_CRYPTO.randomUUID(),
    indexedDB: factory,
    crypto: TEST_CRYPTO,
  });
  const now = { value: 0 };
  let keyIndex = 0;
  const makeOptions = () => ({
    crypto: TEST_CRYPTO,
    now: () => now.value,
    random: options.random ?? (() => 0.25),
    idempotencyKeyFactory: () => `queue-idempotency-${String(++keyIndex).padStart(4, "0")}`,
    baseRetryMs: options.baseRetryMs ?? 500,
    maxRetryMs: 30_000,
  });
  const queue = new CaptureQueue(storage, makeOptions());
  return {
    storage,
    queue,
    now,
    queueWithStorage: (replacementStorage: ConstructorParameters<typeof CaptureQueue>[0]) =>
      new CaptureQueue(replacementStorage, makeOptions()),
  };
}

function queueOptions(now: { value: number }) {
  let keyIndex = 0;
  return {
    crypto: TEST_CRYPTO,
    now: () => now.value,
    random: () => 0,
    idempotencyKeyFactory: () => `restart-idempotency-${String(++keyIndex).padStart(4, "0")}`,
    baseRetryMs: 100,
    maxRetryMs: 30_000,
  };
}

interface TransportOverrides {
  readonly receipt?: CaptureQueueTransport["getReceipt"];
  readonly authorize?: CaptureQueueTransport["authorizeUpload"];
  readonly upload?: CaptureQueueTransport["upload"];
  readonly register?: CaptureQueueTransport["register"];
  readonly receiptAlwaysReserved?: boolean;
}

function successfulTransport(
  now: () => number,
  overrides: TransportOverrides = {},
): CaptureQueueTransport {
  const registered = new Map<string, RegistrationReceipt>();
  return {
    getReceipt: vi.fn(
      overrides.receipt ??
        (async (reservation) => {
          const receipt = registered.get(reservation.objectId);
          return receipt === undefined || overrides.receiptAlwaysReserved === true
            ? { state: "reserved" as const }
            : { state: "registered" as const, registration: receipt };
        }),
    ),
    authorizeUpload: vi.fn(
      overrides.authorize ??
        (async (_sessionId, objectId): Promise<UploadAuthorization> => ({
          objectId,
          additionalAuthenticatedData: makeReservation(objectSequence(objectId))
            .additionalAuthenticatedData,
          uploadUrl: `https://upload.invalid/${objectId}`,
          expiresAtEpochMs: now() + 60_000,
        })),
    ),
    upload: vi.fn(overrides.upload ?? (async () => undefined)),
    register: vi.fn(async (request) => {
      const receipt =
        overrides.register === undefined
          ? receiptFor(request)
          : await overrides.register(request);
      registered.set(request.objectId, receipt);
      return receipt;
    }),
  };
}

function makeReservation(sequenceNumber: number): ChunkReservation {
  const objectId = objectIdFor(sequenceNumber);
  return {
    protocolVersion: PROTOCOL_VERSION,
    objectId,
    sessionId: SESSION_ID,
    channel: "microphone",
    sequenceNumber,
    additionalAuthenticatedData: encodeChunkAdditionalDataBase64Url({
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      objectId,
      sequenceNumber,
      channel: "microphone",
    }),
    createdAt: REGISTERED_AT,
  };
}

function makeEnvelope(seed: number): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce.fill(seed % 256);
  const ciphertext = new Uint8Array(48);
  ciphertext.fill((seed + 1) % 256);
  return encodeEnvelope(
    {
      schema_version: PROTOCOL_VERSION,
      content_encryption: "A256GCM",
      nonce: base64UrlEncode(nonce),
      media_type: "audio/wav",
    },
    ciphertext,
  );
}

function receiptFor(request: RegisterChunkRequest): RegistrationReceipt {
  return {
    chunkId: `30000000-0000-4000-8000-${String(request.sequenceNumber + 1).padStart(12, "0")}`,
    sha256: request.sha256,
    byteLength: request.byteLength,
    registeredAt: REGISTERED_AT,
  };
}

function objectIdFor(sequenceNumber: number): string {
  return `40000000-0000-4000-8000-${String(sequenceNumber + 1).padStart(12, "0")}`;
}

function objectSequence(objectId: string): number {
  return Number(objectId.slice(-12)) - 1;
}
