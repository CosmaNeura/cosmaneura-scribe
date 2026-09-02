import { webcrypto } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

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
import {
  FakeIosNativePcmBridge,
  IosNativeMicrophoneCaptureSource,
} from "../native";
import { CaptureQueue } from "../queue/capture-queue";
import { EncryptedIndexedDbQueueStorage } from "../storage/encrypted-indexeddb";
import { CaptureFlowController } from "./controller";
import { EncryptedIndexedDbFlowStore } from "./encrypted-store";

const TEST_CRYPTO = webcrypto as unknown as Crypto;
const TEST_ENCOUNTER = Object.freeze({
  appointmentId: "synthetic-appointment",
  practitionerId: "synthetic-practitioner",
  patientId: "synthetic-patient",
  participantRegions: ["US-NY"],
});

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

  it("caps capture to the exact authority window and applies server upload concurrency", async () => {
    const clock = { value: new Date("2026-08-18T12:00:00.000Z") };
    const server = createMockBffServer({ now: () => new Date(clock.value) });
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
    const bff = new HttpCaptureBff(createSameOriginFetch(origin));
    const queue = new CaptureQueue(queueStorage, { crypto: TEST_CRYPTO });
    const configureUploadConcurrency = vi.spyOn(queue, "configureUploadConcurrency");
    const source = new InspectableCaptureSource();
    const authorityTimer = new ManualTimeout();
    const controller = new CaptureFlowController({
      bff,
      flowStore,
      queue,
      queueTransport: new BffCaptureQueueTransport(
        bff,
        new HttpCiphertextUploadTarget([origin]),
      ),
      source,
      crypto: TEST_CRYPTO,
      now: () => new Date(clock.value),
      scheduleTimeout: authorityTimer.schedule,
      cancelTimeout: authorityTimer.cancel,
    });

    try {
      await controller.prepare(TEST_ENCOUNTER);
      await expect(flowStore.getActiveCaptureState()).resolves.toMatchObject({
        captureAuthorizedUntil: "2026-08-18T12:15:00.000Z",
        aggregatePlaintextBudgetBytes: 67_108_864,
      });
      expect(configureUploadConcurrency).toHaveBeenCalledWith(2);
      expect(controller.snapshot.remainingBudgetSeconds).toBe(2_040);
      expect(controller.snapshot.remainingAuthoritySeconds).toBe(900);

      await controller.startRecording();
      expect(source.capabilities).toMatchObject({
        max_chunks: 90,
        upload_concurrency: 2,
      });
      expect(authorityTimer.delayMs).toBe(900_000);

      clock.value = new Date("2026-08-18T12:15:01.000Z");
      authorityTimer.fire();
      await vi.waitFor(() => {
        expect(controller.snapshot.state).toBe("paused");
      });
      expect(source.signal?.aborted).toBe(true);
      expect(source.stopCalls).toBe(1);
      await expect(source.emit()).rejects.toThrow("capture_authority_expired");
      expect(source.lastChunk?.wavBytes.every((byte) => byte === 0)).toBe(true);
      expect(controller.snapshot).toMatchObject({
        state: "paused",
        statusCode: "capture_authority_expired",
        recordedChunks: 0,
        remainingAuthoritySeconds: 0,
      });
    } finally {
      flowStore.close();
      queueStorage.close();
      await closeServer(server);
    }
  });

  it("blocks an expired authority before the source starts", async () => {
    const clock = { value: new Date("2026-08-18T12:00:00.000Z") };
    const server = createMockBffServer({ now: () => new Date(clock.value) });
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
    const source = new InspectableCaptureSource();
    const authorityTimer = new ManualTimeout();
    const bff = new HttpCaptureBff(createSameOriginFetch(origin));
    const controller = createControllerWithSource({
      bff,
      flowStore,
      queueStorage,
      origin,
      source,
      now: () => new Date(clock.value),
      scheduleTimeout: authorityTimer.schedule,
      cancelTimeout: authorityTimer.cancel,
    });

    try {
      await controller.prepare(TEST_ENCOUNTER);
      clock.value = new Date("2026-08-18T12:15:01.000Z");
      authorityTimer.fire();
      await vi.waitFor(() => {
        expect(controller.snapshot.state).toBe("paused");
      });
      expect(source.startCalls).toBe(0);
      expect(controller.snapshot).toMatchObject({
        state: "paused",
        statusCode: "capture_authority_expired",
      });
      await expect(flowStore.getActiveCaptureState()).resolves.toMatchObject({ phase: "paused" });
    } finally {
      flowStore.close();
      queueStorage.close();
      await closeServer(server);
    }
  });

  it("does not start the source when authority expires during the recording transition", async () => {
    const clock = { value: new Date("2026-08-18T12:00:00.000Z") };
    const server = createMockBffServer({ now: () => new Date(clock.value) });
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
    const source = new InspectableCaptureSource();
    const authorityTimer = new ManualTimeout();
    const bff = new HttpCaptureBff(createSameOriginFetch(origin));
    const controller = createControllerWithSource({
      bff,
      flowStore,
      queueStorage,
      origin,
      source,
      now: () => new Date(clock.value),
      scheduleTimeout: authorityTimer.schedule,
      cancelTimeout: authorityTimer.cancel,
    });

    try {
      await controller.prepare(TEST_ENCOUNTER);
      const recordingWriteStarted = deferred();
      const releaseRecordingWrite = deferred();
      const putActiveCaptureState = flowStore.putActiveCaptureState.bind(flowStore);
      vi.spyOn(flowStore, "putActiveCaptureState").mockImplementation(async (state) => {
        if (state.phase === "recording") {
          recordingWriteStarted.resolve();
          await releaseRecordingWrite.promise;
        }
        await putActiveCaptureState(state);
      });

      const start = controller.startRecording();
      await recordingWriteStarted.promise;
      clock.value = new Date("2026-08-18T12:15:01.000Z");
      const rejected = expect(start).rejects.toThrow("capture_authority_expired");
      releaseRecordingWrite.resolve();
      await rejected;

      expect(source.startCalls).toBe(0);
      expect(controller.snapshot).toMatchObject({
        state: "paused",
        statusCode: "capture_authority_expired",
      });
      await expect(flowStore.getActiveCaptureState()).resolves.toMatchObject({ phase: "paused" });
    } finally {
      flowStore.close();
      queueStorage.close();
      await closeServer(server);
    }
  });

  it("restores expired capture authority paused without losing a durable chunk", async () => {
    const clock = { value: new Date("2026-08-18T12:00:00.000Z") };
    const server = createMockBffServer({ now: () => new Date(clock.value) });
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
    const bff = new HttpCaptureBff(createSameOriginFetch(origin));

    try {
      const first = createControllerWithSource({
        bff,
        flowStore,
        queueStorage,
        origin,
        source: new OneChunkSyntheticSource(),
        now: () => new Date(clock.value),
      });
      await first.prepare(TEST_ENCOUNTER);
      await first.startRecording();
      expect(first.snapshot.recordedChunks).toBe(1);

      flowStore.close();
      queueStorage.close();
      clock.value = new Date("2026-08-18T12:15:01.000Z");
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
      const recovered = createControllerWithSource({
        bff,
        flowStore,
        queueStorage,
        origin,
        source: new OneChunkSyntheticSource(),
        now: () => new Date(clock.value),
      });

      await expect(recovered.restore()).resolves.toBe(true);
      expect(recovered.snapshot).toMatchObject({
        state: "paused",
        statusCode: "capture_authority_expired",
        recordedChunks: 1,
        remainingAuthoritySeconds: 0,
      });
      const durable = await new CaptureQueue(queueStorage, { crypto: TEST_CRYPTO }).list();
      expect(durable.filter((record) => record.state === "encrypted")).toHaveLength(1);
      await recovered.stopRecording();
      expect(recovered.snapshot.state).toBe("processing");
    } finally {
      flowStore.close();
      queueStorage.close();
      await closeServer(server);
    }
  });

  it.each(["interruption", "error"] as const)(
    "drains durable chunks after a terminal source %s",
    async (signal) => {
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
      const bff = new HttpCaptureBff(createSameOriginFetch(origin));
      const controller = createControllerWithSource({
        bff,
        flowStore,
        queueStorage,
        origin,
        source: new TerminalStopSource(signal),
      });

      try {
        await controller.prepare(TEST_ENCOUNTER);
        await controller.startRecording();
        expect(controller.snapshot).toMatchObject({
          state: "paused",
          statusCode:
            signal === "interruption" ? "capture_backgrounded" : "capture_source_failed",
          recordedChunks: 1,
        });
        await controller.stopRecording();
        expect(controller.snapshot.state).toBe("processing");
      } finally {
        flowStore.close();
        queueStorage.close();
        await closeServer(server);
      }
    },
  );

  it("does not ignore an ordinary active-stop failure", async () => {
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
    const bff = new HttpCaptureBff(createSameOriginFetch(origin));
    const controller = createControllerWithSource({
      bff,
      flowStore,
      queueStorage,
      origin,
      source: new TerminalStopSource(null),
    });

    try {
      await controller.prepare(TEST_ENCOUNTER);
      await controller.startRecording();
      await expect(controller.stopRecording()).rejects.toThrow("synthetic active stop failed");
      expect(controller.snapshot.state).toBe("error");
      const durable = await new CaptureQueue(queueStorage, { crypto: TEST_CRYPTO }).list();
      expect(durable.filter((record) => record.state === "encrypted")).toHaveLength(1);
    } finally {
      flowStore.close();
      queueStorage.close();
      await closeServer(server);
    }
  });

  it("blocks upload when a native stop failure also pauses the source", async () => {
    const server = createMockBffServer();
    const origin = await listenOnEphemeralLoopback(server);
    const indexedDB = new IDBFactory();
    const queueStorage = await EncryptedIndexedDbQueueStorage.open({
      databaseName: TEST_CRYPTO.randomUUID(), indexedDB, crypto: TEST_CRYPTO,
    });
    const flowStore = await EncryptedIndexedDbFlowStore.open({
      databaseName: TEST_CRYPTO.randomUUID(), indexedDB, crypto: TEST_CRYPTO,
    });
    const bff = new HttpCaptureBff(createSameOriginFetch(origin));
    const completeCapture = vi.spyOn(bff, "completeCapture");
    const bridge = new FakeIosNativePcmBridge();
    const source = new IosNativeMicrophoneCaptureSource(bridge);
    const controller = createControllerWithSource({
      bff, flowStore, queueStorage, origin, source,
    });

    try {
      await controller.prepare(TEST_ENCOUNTER);
      await controller.startRecording();
      const frames = bridge.lastConfiguration?.targetFramesPerChunk;
      if (frames === undefined) throw new Error("native configuration missing");
      await bridge.emitPcmPacket({
        sequenceNumber: 0,
        pcmBytes: new Uint8Array(frames * Int16Array.BYTES_PER_ELEMENT),
      });
      bridge.failNextStops();

      await expect(controller.stopRecording()).rejects.toMatchObject({
        code: "audio_capture_native_stop_failed",
      });
      expect(controller.snapshot).toMatchObject({
        state: "paused",
        statusCode: "audio_capture_native_stop_failed",
      });
      expect(completeCapture).not.toHaveBeenCalled();
      const durable = await new CaptureQueue(queueStorage, { crypto: TEST_CRYPTO }).list();
      expect(durable.filter((record) => record.state === "encrypted")).toHaveLength(1);
      expect(bridge.stopModes).toEqual(["drain"]);

      await controller.stopRecording();
      expect(controller.snapshot.state).toBe("processing");
      expect(completeCapture).toHaveBeenCalledOnce();
      expect(bridge.stopModes).toEqual(["drain", "drain"]);
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

class InspectableCaptureSource implements CaptureSource {
  public readonly kind = "synthetic" as const;
  public capabilities: CaptureSourceStartOptions["capabilities"] | null = null;
  public lastChunk: CapturedWavChunk | null = null;
  public startCalls = 0;
  public stopCalls = 0;
  public signal: AbortSignal | undefined;
  private options: CaptureSourceStartOptions | null = null;

  public start(options: CaptureSourceStartOptions): Promise<void> {
    this.startCalls += 1;
    this.capabilities = options.capabilities;
    this.options = options;
    this.signal = options.signal;
    return Promise.resolve();
  }

  public async emit(): Promise<void> {
    if (this.options === null) throw new Error("source not started");
    this.lastChunk = makeCapturedChunk(this.options.capabilities);
    await this.options.onChunk(this.lastChunk);
  }

  public stop(): Promise<void> {
    this.stopCalls += 1;
    return Promise.resolve();
  }
}

class ManualTimeout {
  public delayMs: number | null = null;
  private callback: (() => void) | null = null;
  private handle: object | null = null;

  public readonly schedule = (callback: () => void, delayMs: number): object => {
    this.callback = callback;
    this.delayMs = delayMs;
    this.handle = {};
    return this.handle;
  };

  public readonly cancel = (handle: unknown): void => {
    if (handle === this.handle) this.callback = null;
  };

  public fire(): void {
    const callback = this.callback;
    this.callback = null;
    if (callback === null) throw new Error("authority timer was not armed");
    callback();
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

class TerminalStopSource implements CaptureSource {
  public readonly kind = "synthetic" as const;

  public constructor(private readonly signal: "interruption" | "error" | null) {}

  public async start(options: CaptureSourceStartOptions): Promise<void> {
    await options.onChunk(makeCapturedChunk(options.capabilities));
    if (this.signal === "interruption") options.onInterruption?.("capture_backgrounded");
    if (this.signal === "error") options.onError?.("capture_source_failed");
  }

  public stop(): Promise<void> {
    return Promise.reject(new Error("synthetic active stop failed"));
  }
}

function makeCapturedChunk(
  capabilities: CaptureSourceStartOptions["capabilities"],
): CapturedWavChunk {
  const profile = pcm16WavProfile(capabilities);
  const samples = new Int16Array(
    new ArrayBuffer(profile.sampleRateHz * Int16Array.BYTES_PER_ELEMENT),
  );
  return {
    sequenceNumber: 0,
    durationMs: 1_000,
    wavBytes: encodePcm16MonoWav(samples, profile),
  };
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

interface ControllerWithSourceOptions {
  readonly bff: CaptureBff;
  readonly flowStore: EncryptedIndexedDbFlowStore;
  readonly queueStorage: EncryptedIndexedDbQueueStorage;
  readonly origin: string;
  readonly source: CaptureSource;
  readonly now?: () => Date;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelTimeout?: (handle: unknown) => void;
}

function createControllerWithSource(
  options: ControllerWithSourceOptions,
): CaptureFlowController {
  const now = options.now;
  return new CaptureFlowController({
    bff: options.bff,
    flowStore: options.flowStore,
    queue: new CaptureQueue(options.queueStorage, {
      crypto: TEST_CRYPTO,
      ...(now === undefined ? {} : { now: () => now().getTime() }),
    }),
    queueTransport: new BffCaptureQueueTransport(
      options.bff,
      new HttpCiphertextUploadTarget([options.origin]),
    ),
    source: options.source,
    crypto: TEST_CRYPTO,
    ...(now === undefined ? {} : { now }),
    ...(options.scheduleTimeout === undefined
      ? {}
      : { scheduleTimeout: options.scheduleTimeout }),
    ...(options.cancelTimeout === undefined
      ? {}
      : { cancelTimeout: options.cancelTimeout }),
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
