import { webcrypto } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { HttpCaptureBff } from "../bff/http-client";
import type { CaptureBff } from "../bff/contracts";
import { BffCaptureQueueTransport } from "../bff/queue-transport";
import { HttpCiphertextUploadTarget } from "../bff/upload-target";
import type {
  CapturedWavChunk,
  CaptureSource,
  CaptureSourceStartOptions,
} from "../capture";
import { encodePcm16MonoWav, pcm16WavProfile } from "../capture";
import { createMockBffServer } from "../mock-bff/server";
import { CaptureQueue } from "../queue/capture-queue";
import { EncryptedIndexedDbQueueStorage } from "../storage/encrypted-indexeddb";
import { CaptureFlowController } from "./controller";
import { EncryptedIndexedDbFlowStore } from "./encrypted-store";

const TEST_CRYPTO = webcrypto as unknown as Crypto;

describe("CaptureFlowController", () => {
  it("runs the synthetic consent-to-read-only-transcript flow", async () => {
    const server = createMockBffServer();
    const origin = await listenOnEphemeralLoopback(server);
    const indexedDB = new IDBFactory();
    const queueStorage = await EncryptedIndexedDbQueueStorage.open({
      databaseName: TEST_CRYPTO.randomUUID(),
      indexedDB,
      crypto: TEST_CRYPTO,
    });
    const flowStore = await EncryptedIndexedDbFlowStore.open({
      databaseName: TEST_CRYPTO.randomUUID(),
      indexedDB,
      crypto: TEST_CRYPTO,
    });

    try {
      const bff = new HttpCaptureBff(createSameOriginFetch(origin));
      const queue = new CaptureQueue(queueStorage, { crypto: TEST_CRYPTO });
      const controller = new CaptureFlowController({
        bff,
        flowStore,
        queue,
        queueTransport: new BffCaptureQueueTransport(
          bff,
          new HttpCiphertextUploadTarget([origin]),
        ),
        source: new OneChunkSyntheticSource(),
        crypto: TEST_CRYPTO,
      });

      await controller.prepare({
        appointmentId: "synthetic-appointment",
        practitionerId: "synthetic-practitioner",
        patientId: "synthetic-patient",
        participantRegions: ["US-NY"],
      });
      expect(controller.snapshot).toMatchObject({ state: "ready", queuedChunks: 90 });

      await controller.startRecording();
      expect(controller.snapshot).toMatchObject({ state: "recording", recordedChunks: 1 });
      await controller.stopRecording();
      expect(controller.snapshot).toMatchObject({
        state: "processing",
        transcriptionStatus: { status: "processing", transcript_available: false },
      });
      await controller.refreshTranscriptionStatus();
      expect(controller.snapshot).toMatchObject({
        state: "complete",
        transcriptionStatus: { status: "completed", transcript_available: true },
        transcript: { stt_provider: "synthetic-preview" },
      });
      expect(JSON.stringify(controller.snapshot)).not.toContain("22222222-2222-4222-8222-222222222222");
    } finally {
      flowStore.close();
      queueStorage.close();
      await closeServer(server);
    }
  });

  it("recovers a durable encrypted chunk after relaunch and completes with the same queue", async () => {
    const server = createMockBffServer();
    const origin = await listenOnEphemeralLoopback(server);
    const indexedDB = new IDBFactory();
    const queueDatabaseName = TEST_CRYPTO.randomUUID();
    const flowDatabaseName = TEST_CRYPTO.randomUUID();
    let queueStorage = await EncryptedIndexedDbQueueStorage.open({
      databaseName: queueDatabaseName,
      indexedDB,
      crypto: TEST_CRYPTO,
    });
    let flowStore = await EncryptedIndexedDbFlowStore.open({
      databaseName: flowDatabaseName,
      indexedDB,
      crypto: TEST_CRYPTO,
    });

    try {
      const bff = new HttpCaptureBff(createSameOriginFetch(origin));
      const first = new CaptureFlowController({
        bff,
        flowStore,
        queue: new CaptureQueue(queueStorage, { crypto: TEST_CRYPTO }),
        queueTransport: new BffCaptureQueueTransport(
          bff,
          new HttpCiphertextUploadTarget([origin]),
        ),
        source: new OneChunkSyntheticSource(),
        crypto: TEST_CRYPTO,
      });
      await first.prepare({
        appointmentId: "synthetic-appointment",
        practitionerId: "synthetic-practitioner",
        patientId: "synthetic-patient",
        participantRegions: ["US-NY"],
      });
      await first.startRecording();
      expect(first.snapshot).toMatchObject({ state: "recording", recordedChunks: 1 });

      flowStore.close();
      queueStorage.close();
      flowStore = await EncryptedIndexedDbFlowStore.open({
        databaseName: flowDatabaseName,
        indexedDB,
        crypto: TEST_CRYPTO,
      });
      queueStorage = await EncryptedIndexedDbQueueStorage.open({
        databaseName: queueDatabaseName,
        indexedDB,
        crypto: TEST_CRYPTO,
      });
      const recovered = new CaptureFlowController({
        bff,
        flowStore,
        queue: new CaptureQueue(queueStorage, { crypto: TEST_CRYPTO }),
        queueTransport: new BffCaptureQueueTransport(
          bff,
          new HttpCiphertextUploadTarget([origin]),
        ),
        source: new OneChunkSyntheticSource(),
        crypto: TEST_CRYPTO,
      });
      await expect(recovered.restore()).resolves.toBe(true);
      expect(recovered.snapshot).toMatchObject({
        state: "paused",
        statusCode: "capture_recovered_paused",
        recordedChunks: 1,
      });
      await recovered.stopRecording();
      expect(recovered.snapshot).toMatchObject({ state: "processing" });
      await recovered.refreshTranscriptionStatus();
      expect(recovered.snapshot).toMatchObject({ state: "complete" });
      await expect(flowStore.getActiveCaptureState()).resolves.toBeNull();
      await expect(flowStore.getPreparationState()).resolves.toBeNull();
      await expect(flowStore.getSessionKeyState(recovered.snapshot.sessionId!)).resolves.toBeNull();
    } finally {
      flowStore.close();
      queueStorage.close();
      await closeServer(server);
    }
  });

  it("replays the exact persisted consent mutation after a committed response is lost", async () => {
    const server = createMockBffServer();
    const origin = await listenOnEphemeralLoopback(server);
    const indexedDB = new IDBFactory();
    const queueDatabaseName = TEST_CRYPTO.randomUUID();
    const flowDatabaseName = TEST_CRYPTO.randomUUID();
    const baseBff = new HttpCaptureBff(createSameOriginFetch(origin));
    const bff = dropFirstConsentResponse(baseBff);
    let queueStorage = await EncryptedIndexedDbQueueStorage.open({
      databaseName: queueDatabaseName,
      indexedDB,
      crypto: TEST_CRYPTO,
    });
    let flowStore = await EncryptedIndexedDbFlowStore.open({
      databaseName: flowDatabaseName,
      indexedDB,
      crypto: TEST_CRYPTO,
    });
    try {
      const first = createController(bff, flowStore, queueStorage, origin);
      await expect(first.prepare({
        appointmentId: "synthetic-appointment",
        practitionerId: "synthetic-practitioner",
        patientId: "synthetic-patient",
        participantRegions: ["US-NY"],
      })).rejects.toThrow("synthetic response lost after commit");
      await expect(flowStore.getPreparationState()).resolves.toMatchObject({
        consentId: null,
        consentIdempotencyKey: expect.stringMatching(/^consent:/u),
        consentRequest: { patient_id: "synthetic-patient" },
      });

      flowStore.close();
      queueStorage.close();
      flowStore = await EncryptedIndexedDbFlowStore.open({
        databaseName: flowDatabaseName,
        indexedDB,
        crypto: TEST_CRYPTO,
      });
      queueStorage = await EncryptedIndexedDbQueueStorage.open({
        databaseName: queueDatabaseName,
        indexedDB,
        crypto: TEST_CRYPTO,
      });
      const recovered = createController(bff, flowStore, queueStorage, origin);
      await expect(recovered.restore()).resolves.toBe(true);
      expect(recovered.snapshot).toMatchObject({ state: "ready", queuedChunks: 90 });
    } finally {
      flowStore.close();
      queueStorage.close();
      await closeServer(server);
    }
  });
});

class OneChunkSyntheticSource implements CaptureSource {
  public readonly kind = "synthetic" as const;

  public async start(options: CaptureSourceStartOptions): Promise<void> {
    const profile = pcm16WavProfile(options.capabilities);
    const samples = new Int16Array(
      new ArrayBuffer(profile.sampleRateHz * Int16Array.BYTES_PER_ELEMENT),
    );
    const chunk: CapturedWavChunk = {
      sequenceNumber: 0,
      durationMs: 1_000,
      wavBytes: encodePcm16MonoWav(samples, profile),
    };
    await options.onChunk(chunk);
  }

  public stop(): Promise<void> {
    return Promise.resolve();
  }
}

function createSameOriginFetch(origin: string): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === "string" ? new URL(input, origin) : input;
    return fetch(target, init);
  };
}

function createController(
  bff: CaptureBff,
  flowStore: EncryptedIndexedDbFlowStore,
  queueStorage: EncryptedIndexedDbQueueStorage,
  origin: string,
): CaptureFlowController {
  return new CaptureFlowController({
    bff,
    flowStore,
    queue: new CaptureQueue(queueStorage, { crypto: TEST_CRYPTO }),
    queueTransport: new BffCaptureQueueTransport(
      bff,
      new HttpCiphertextUploadTarget([origin]),
    ),
    source: new OneChunkSyntheticSource(),
    crypto: TEST_CRYPTO,
  });
}

function dropFirstConsentResponse(bff: CaptureBff): CaptureBff {
  let drop = true;
  const createConsent = bff.createConsent.bind(bff);
  bff.createConsent = async (...args: Parameters<CaptureBff["createConsent"]>) => {
    const response = await createConsent(...args);
    if (drop) {
      drop = false;
      throw new TypeError("synthetic response lost after commit");
    }
    return response;
  };
  return bff;
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
