import { webcrypto } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import {
  base64UrlEncode,
  encodeEnvelope,
  NONCE_BYTES,
  PROTOCOL_VERSION,
} from "@cosmaneura-scribe/capture-protocol";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { HttpCaptureBff } from "../bff/http-client";
import { BffCaptureQueueTransport } from "../bff/queue-transport";
import { HttpCiphertextUploadTarget } from "../bff/upload-target";
import { CaptureQueue } from "../queue/capture-queue";
import type { ChunkReservation } from "../queue/types";
import { EncryptedIndexedDbQueueStorage } from "../storage/encrypted-indexeddb";
import { createMockBffServer } from "./server";

const TEST_CRYPTO = webcrypto as unknown as Crypto;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("synthetic capture flow over HTTP", () => {
  it("reserves, durably queues, uploads, registers, purges, and completes", async () => {
    const server = createMockBffServer({
      sessionId: SESSION_ID,
      requirePreparation: false,
    });
    const origin = await listenOnEphemeralLoopback(server);
    const indexedDB = new IDBFactory();
    const databaseName = TEST_CRYPTO.randomUUID();
    let storage: EncryptedIndexedDbQueueStorage | undefined;

    try {
      const bff = new HttpCaptureBff(createSameOriginFetch(origin));
      const capabilities = await bff.getCapabilities(SESSION_ID);
      expect(capabilities).toMatchObject({
        protocol_version: PROTOCOL_VERSION,
        upload_concurrency: 2,
      });

      const lease = await bff.issueLease(
        SESSION_ID,
        { protocol_version: PROTOCOL_VERSION },
        { idempotencyKey: "http-flow-lease-0001" },
      );
      const batch = await bff.reserveChunks(
        SESSION_ID,
        {
          protocol_version: PROTOCOL_VERSION,
          capture_lease_id: lease.lease_id,
          capture_lease_generation: lease.generation,
          channel: "microphone",
          first_sequence_number: 0,
          count: 1,
        },
        { idempotencyKey: "http-flow-reservation-0001" },
      );
      const remoteReservation = batch.reservations[0];
      if (remoteReservation === undefined) throw new Error("mock omitted reservation");
      const reservation: ChunkReservation = {
        protocolVersion: remoteReservation.protocol_version,
        objectId: remoteReservation.object_id,
        sessionId: remoteReservation.session_id,
        channel: remoteReservation.channel,
        sequenceNumber: remoteReservation.sequence_number,
        additionalAuthenticatedData: remoteReservation.additional_authenticated_data,
        createdAt: remoteReservation.created_at,
      };

      storage = await EncryptedIndexedDbQueueStorage.open({
        databaseName,
        indexedDB,
        crypto: TEST_CRYPTO,
      });
      let keyIndex = 0;
      const queueOptions = {
        crypto: TEST_CRYPTO,
        idempotencyKeyFactory: () => `http-flow-queue-${String(++keyIndex).padStart(4, "0")}`,
      };
      let queue = new CaptureQueue(storage, queueOptions);
      const envelope = syntheticEnvelope();
      await queue.reserve(reservation, "http-flow-reservation-0001");
      await queue.encrypt(reservation.objectId, envelope);

      storage.close();
      storage = await EncryptedIndexedDbQueueStorage.open({
        databaseName,
        indexedDB,
        crypto: TEST_CRYPTO,
      });
      queue = new CaptureQueue(storage, queueOptions);
      const restored = await queue.get(reservation.objectId);
      expect(restored).toMatchObject({ state: "encrypted", byteLength: envelope.byteLength });
      if (restored?.state !== "encrypted") throw new Error("queue did not restore envelope");
      expect(restored.envelope).toEqual(envelope);

      const transport = new BffCaptureQueueTransport(
        bff,
        new HttpCiphertextUploadTarget([origin]),
      );
      await expect(queue.drainOnce(transport)).resolves.toEqual({
        items: [{ objectId: reservation.objectId, outcome: "registered" }],
      });

      const receipt = await bff.getChunkReceipt(SESSION_ID, reservation.objectId);
      expect(receipt).toMatchObject({
        state: "registered",
        registration: {
          ciphertext_size_bytes: envelope.byteLength,
        },
      });
      const purged = await queue.purge(reservation.objectId);
      expect(purged.state).toBe("purged");
      expect("envelope" in purged).toBe(false);

      const completed = await bff.completeCapture(
        SESSION_ID,
        {
          protocol_version: PROTOCOL_VERSION,
          capture_lease_id: lease.lease_id,
          capture_lease_generation: lease.generation,
          channels: [{ channel: "microphone", final_sequence_number: 0 }],
        },
        { idempotencyKey: "http-flow-complete-0001" },
      );
      expect(completed).toMatchObject({ id: SESSION_ID, status: "uploaded" });
    } finally {
      storage?.close();
      await closeServer(server);
    }
  });
});

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

function createSameOriginFetch(origin: string): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === "string" ? new URL(input, origin) : input;
    return fetch(target, init);
  };
}

async function listenOnEphemeralLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error("mock BFF did not bind a port");
  return `http://127.0.0.1:${String(address.port)}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
