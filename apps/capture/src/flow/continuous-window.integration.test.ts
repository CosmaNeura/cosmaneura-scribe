import { webcrypto } from "node:crypto";
import type { AddressInfo } from "node:net";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { BffResponseError, HttpCaptureBff } from "../bff/http-client";
import { BffCaptureQueueTransport } from "../bff/queue-transport";
import { HttpCiphertextUploadTarget } from "../bff/upload-target";
import type { CaptureSource, CaptureSourceStartOptions, CaptureSourceWindow } from "../capture";
import { encodePcm16MonoWav, pcm16WavProfile } from "../capture";
import { createMockBffServer } from "../mock-bff/server";
import { CaptureQueue } from "../queue/capture-queue";
import { EncryptedIndexedDbQueueStorage } from "../storage/encrypted-indexeddb";
import { CaptureFlowController } from "./controller";
import { EncryptedIndexedDbFlowStore } from "./encrypted-store";

const crypto = webcrypto as unknown as Crypto;

// No physical audio or elapsed three-hour claim: the real flow, Core protocol,
// AES-GCM and encrypted IndexedDB process 1,080 full-sized ten-second WAV chunks.
describe("continuous configured desktop windows", () => {
  it.each(["pause", "deactivate"] as const)("leaves a backlog encrypted on %s after joining only the two claimed uploads", async action => {
    const f = await fixture(true), listGate = deferred(), uploadGate = deferred();
    let closing: Promise<void> | undefined;
    try {
      await f.prepare(); await f.controller.startRecording();
      const metadata = f.storage.listMetadata.bind(f.storage);
      vi.spyOn(f.storage, "listMetadata").mockImplementationOnce(async () => { await listGate.promise; return metadata(); });
      const authorize = f.bff.authorizeUpload.bind(f.bff);
      const authorizations = vi.spyOn(f.bff, "authorizeUpload").mockImplementation(async (...args) => {
        await uploadGate.promise; return authorize(...args);
      });
      const complete = vi.spyOn(f.bff, "completeCapture");
      for (let index = 0; index < 12; index++) await f.source.emit();
      listGate.resolve(); await vi.waitFor(() => expect(authorizations).toHaveBeenCalledTimes(2));
      closing = action === "pause" ? f.controller.pauseRecording() : f.controller.deactivate();
      await vi.waitFor(() => expect(f.source.stops).toBe(1));
      uploadGate.resolve(); await closing;
      expect(authorizations).toHaveBeenCalledTimes(2); expect(complete).not.toHaveBeenCalled();
      const records = await metadata();
      expect(records.filter(record => record.state === "purged")).toHaveLength(2);
      expect(records.filter(record => record.state === "encrypted")).toHaveLength(10);
      expect(f.controller.snapshot).toMatchObject({ state: "paused", recordedChunks: 12,
        uploadProgress: { total: 12, registered: 2 } });
      await f.reopen(); expect(f.source.starts).toBe(1);
      await f.controller.stopRecording();
      expect(f.controller.snapshot).toMatchObject({ state: "processing", uploadProgress: { total: 12, registered: 12 } });
      expect(complete).toHaveBeenCalledTimes(1); expect(authorizations).toHaveBeenCalledTimes(12);
      expect((await f.storage.listMetadata()).filter(record => record.state === "purged")).toHaveLength(12);
    } finally { listGate.resolve(); uploadGate.resolve(); await closing?.catch(() => undefined); await f.close(); }
  });
  it("keeps progress bounded when queue receipts precede the flow's next saved-count commit", async () => {
    const f = await fixture(true), listGate = deferred(), saveGate = deferred(), saving = deferred();
    let nextChunk: Promise<void> | undefined;
    try {
      await f.prepare(); await f.controller.startRecording();
      const metadata = f.storage.listMetadata.bind(f.storage);
      vi.spyOn(f.storage, "listMetadata").mockImplementationOnce(async () => { await listGate.promise; return metadata(); });
      await f.source.emit();
      const save = f.store.putActiveCaptureState.bind(f.store);
      vi.spyOn(f.store, "putActiveCaptureState").mockImplementationOnce(async state => {
        saving.resolve(); await saveGate.promise; return save(state);
      });
      nextChunk = f.source.emit(); await saving.promise; listGate.resolve();
      await vi.waitFor(async () => expect((await metadata()).filter(record => record.state === "purged")).toHaveLength(2));
      expect(f.controller.snapshot).toMatchObject({ recordedChunks: 1, uploadProgress: { total: 1, registered: 1 } });
      saveGate.resolve(); await nextChunk;
      await f.controller.stopRecording();
      expect(f.controller.snapshot).toMatchObject({ state: "processing", uploadProgress: { total: 2, registered: 2 } });
    } finally { listGate.resolve(); saveGate.resolve(); await nextChunk; await f.close(); }
  });
  it.each(["stop", "deactivate"] as const)("keeps acquisition independent of uploads and joins them before %s completes", async action => {
    const f = await fixture(true), gate = deferred();
    const authorize = f.bff.authorizeUpload.bind(f.bff);
    const authorizations = vi.spyOn(f.bff, "authorizeUpload").mockImplementationOnce(async (...args) => {
      await gate.promise; return authorize(...args);
    });
    const complete = vi.spyOn(f.bff, "completeCapture");
    try {
      await f.prepare(); await f.controller.startRecording();
      await f.source.emit(); await vi.waitFor(() => expect(authorizations).toHaveBeenCalledTimes(1));
      await f.source.emit(); // This must finish while the first upload is held.
      expect(f.controller.snapshot).toMatchObject({ state: "recording", recordedChunks: 2,
        uploadProgress: { total: 2, registered: 0 } });
      expect(complete).not.toHaveBeenCalled();
      let settled = false;
      const closing = (action === "stop" ? f.controller.stopRecording() : f.controller.deactivate()).then(() => { settled = true; });
      await vi.waitFor(() => expect(f.source.stops).toBe(1));
      expect(settled).toBe(false); expect(complete).not.toHaveBeenCalled();
      gate.resolve(); await closing;
      expect(f.controller.snapshot.state).toBe(action === "stop" ? "processing" : "paused");
      expect(complete).toHaveBeenCalledTimes(action === "stop" ? 1 : 0);
      const metadata = (await f.storage.listMetadata()).filter(record => record.state !== "reserved");
      expect(metadata).toHaveLength(2);
      expect(metadata.every(record => ["encrypted", "purged"].includes(record.state))).toBe(true);
      if (action === "deactivate") {
        await f.reopen(); expect(f.source.starts).toBe(1);
        expect(f.controller.snapshot).toMatchObject({ state: "paused", recordedChunks: 2 });
        await f.controller.stopRecording();
      }
      expect((await f.storage.listMetadata()).filter(record => record.state === "purged")).toHaveLength(2);
      expect(f.controller.snapshot.uploadProgress).toEqual({ total: 2, registered: 2 });
    } finally { gate.resolve(); await f.close(); }
  });

  it("retains offline chunks, retries without stopping capture, and finalizes only on explicit Stop", async () => {
    const f = await fixture(true);
    const authorizations = vi.spyOn(f.bff, "authorizeUpload").mockRejectedValueOnce(new BffResponseError(503, "synthetic_offline", null));
    const complete = vi.spyOn(f.bff, "completeCapture");
    try {
      await f.prepare(); await f.controller.startRecording(); await f.source.emit();
      await vi.waitFor(async () => expect((await f.storage.listMetadata()).some(record => record.retry.upload.attempts === 1)).toBe(true));
      expect(f.controller.snapshot.state).toBe("recording");
      expect(f.controller.snapshot.uploadProgress).toEqual({ total: 1, registered: 0 });
      expect((await f.storage.list()).filter(record => record.state === "uploading")).toHaveLength(1);
      f.clock.advance(1000); await f.source.emit();
      await vi.waitFor(async () => expect((await f.storage.listMetadata()).filter(record => record.state === "purged")).toHaveLength(2));
      expect(authorizations).toHaveBeenCalledTimes(3); expect(complete).not.toHaveBeenCalled();
      expect(f.controller.snapshot.uploadProgress).toEqual({ total: 2, registered: 2 });
      expect(f.source.starts).toBe(1); expect(f.source.stops).toBe(0);
      await f.controller.stopRecording(); expect(complete).toHaveBeenCalledTimes(1);
      expect(f.controller.snapshot.state).toBe("processing");
    } finally { await f.close(); }
  });

  it("renews the same native recording window while an encrypted upload is pending", async () => {
    const f = await fixture(true), gate = deferred();
    const authorize = f.bff.authorizeUpload.bind(f.bff);
    const authorizations = vi.spyOn(f.bff, "authorizeUpload").mockImplementationOnce(async (...args) => { await gate.promise; return authorize(...args); });
    try {
      await f.prepare(); await f.controller.startRecording(); await f.source.emit();
      await vi.waitFor(() => expect(authorizations).toHaveBeenCalledTimes(1));
      expect(f.clock.advance(780000)).toBe(true);
      await vi.waitFor(() => expect(f.source.extensions).toHaveLength(1));
      expect(f.controller.snapshot.state).toBe("recording"); expect(f.source.starts).toBe(1);
      gate.resolve(); await f.controller.stopRecording();
      expect(f.controller.snapshot.state).toBe("processing");
    } finally { gate.resolve(); await f.close(); }
  });

  it("retains three hours of encrypted audio across 13 renewals without restarting the source", async () => {
    const f = await fixture();
    try {
      await f.prepare(); await f.controller.startRecording();
      const key = await f.store.getSessionKeyState(f.sessionId);
      const hard = f.source.window!.hardMaximumChunks, runId = f.source.window!.runId;
      for (let index = 0; index < 1080; index++) {
        await f.source.emit(true);
        const extensions = f.source.extensions.length;
        if (f.clock.advance(10_000)) await vi.waitFor(() => expect(f.source.extensions.length).toBe(extensions + 1));
      }
      await f.controller.pauseRecording();
      expect(f.source.starts).toBe(1); expect(f.source.extensions).toHaveLength(13);
      expect(f.source.extensions.every(window => window.runId === runId && window.hardMaximumChunks === hard)).toBe(true);
      expect(f.source.extensions.map(window => window.generation)).toEqual(Array.from({ length: 13 }, (_, index) => index + 2));
      expect(f.controller.snapshot).toMatchObject({ state: "paused", recordedChunks: 1080, elapsedSeconds: 10800 });
      const active = await f.store.getActiveCaptureState();
      expect(active).toMatchObject({ schemaVersion: 5, phase: "paused", recordedChunks: 1080,
        recordedPlaintextBytes: 1080 * 320044, lease: { generation: 14 }, continuation: { continuous: true, prepared: true } });
      const records = (await f.storage.listMetadata()).filter(record => record.state === "encrypted");
      expect(records).toHaveLength(1080);
      expect(records.map(record => record.reservation.sequenceNumber).sort((a, b) => a - b))
        .toEqual(Array.from({ length: 1080 }, (_, index) => index));
      expect(new Set(records.map(record => record.reservation.objectId)).size).toBe(1080);
      expect(records.every(record => record.reservation.channel === "mixed" && record.byteLength > 320044)).toBe(true);
      expect(await f.store.getSessionKeyState(f.sessionId)).toEqual(key);
      await f.reopen();
      expect(f.controller.snapshot).toMatchObject({ state: "paused", recordedChunks: 1080 });
      expect(f.source.starts).toBe(1);
      // Existing crash recovery conservatively counts the complete encrypted
      // envelope when original plaintext length cannot be recovered from metadata.
      expect(await f.store.getActiveCaptureState()).toEqual({ ...active,
        recordedPlaintextBytes: records.reduce((bytes, record) => bytes + record.byteLength, 0) });
      expect(await f.store.getSessionKeyState(f.sessionId)).toEqual(key);
    } finally { await f.close(); }
  }, 120_000);

  it.each(["renew", "reserve"] as const)("recovers a lost %s response after reopening, without starting capture automatically", async operation => {
    const f = await fixture();
    try {
      await f.prepare(); await f.controller.startRecording(); await f.source.emit();
      const original = await f.storage.list(), key = await f.store.getSessionKeyState(f.sessionId);
      const renew = f.bff.renewLease.bind(f.bff), reserve = f.bff.reserveChunks.bind(f.bff);
      const renewal = vi.spyOn(f.bff, "renewLease");
      if (operation === "renew") renewal.mockImplementationOnce(async (...args) => { await renew(...args); throw new Error("lost renewal"); });
      else vi.spyOn(f.bff, "reserveChunks").mockImplementationOnce(async (...args) => { await reserve(...args); throw new Error("lost reservation"); });
      expect(f.clock.advance(780_000)).toBe(true);
      await vi.waitFor(() => expect(f.controller.snapshot).toMatchObject({ state: "paused", statusCode: "capture_resume_pending" }));
      const pending = (await f.store.getActiveCaptureState())!;
      expect(pending.continuation).toMatchObject({ continuous: true, prepared: false });
      expect(f.source.extensions).toEqual([]); expect(f.source.starts).toBe(1);
      await f.reopen(); expect(f.source.starts).toBe(1);
      expect(await f.storage.list()).toEqual(expect.arrayContaining([...original]));
      expect((await f.storage.listMetadata()).filter(record => record.state === "encrypted")).toHaveLength(1);
      await f.controller.resumeRecording();
      expect(f.source.starts).toBe(2);
      if (operation === "renew") expect(renewal.mock.calls[1]).toEqual(renewal.mock.calls[0]);
      expect(await f.store.getSessionKeyState(f.sessionId)).toEqual(key);
      expect(await f.store.getActiveCaptureState()).toMatchObject({ schemaVersion: 5, phase: "recording",
        recordedChunks: 1, lease: { generation: 3 }, continuation: { firstSequenceNumber: 1, prepared: true } });
      await f.source.emit(); await f.controller.stopRecording();
      expect(f.controller.snapshot.state).toBe("processing");
      expect((await f.storage.listMetadata()).filter(record => record.state === "purged")).toHaveLength(2);
    } finally { await f.close(); }
  });

  it.each(["stop", "deactivate"] as const)("waits for an in-flight renewal on %s while retaining concurrently saved chunks", async action => {
    const f = await fixture(), gate = deferred();
    try {
      await f.prepare(); await f.controller.startRecording(); await f.source.emit();
      const original = f.bff.renewLease.bind(f.bff);
      const renewal = vi.spyOn(f.bff, "renewLease").mockImplementationOnce(async (...args) => {
        const receipt = await original(...args); await gate.promise; return receipt;
      });
      f.clock.advance(780_000); await vi.waitFor(() => expect(renewal).toHaveBeenCalledTimes(1));
      await f.source.emit();
      let settled = false;
      const closing = (action === "stop" ? f.controller.stopRecording() : f.controller.deactivate()).then(() => { settled = true; });
      await vi.waitFor(() => expect(f.source.stops).toBe(1));
      expect(settled).toBe(false);
      gate.resolve(); await closing;
      expect(f.source.extensions).toEqual([]);
      expect(f.source.starts).toBe(1);
      expect(await f.store.getActiveCaptureState()).toMatchObject({ recordedChunks: 2, lease: { generation: 2 },
        phase: action === "stop" ? "processing" : "paused", continuation: { continuous: true, prepared: false } });
      expect(f.controller.snapshot.state).toBe(action === "stop" ? "processing" : "paused");
    } finally { gate.resolve(); await f.close(); }
  });

  it("keeps a confirmed Stop recoverable when renewal retry also fails", async () => {
    const f = await fixture();
    try {
      await f.prepare(); await f.controller.startRecording(); await f.source.emit();
      const original = f.bff.renewLease.bind(f.bff), renewal = vi.spyOn(f.bff, "renewLease");
      renewal.mockImplementationOnce(async (...args) => { await original(...args); throw new Error("lost reply"); });
      f.clock.advance(780_000);
      await vi.waitFor(() => expect(f.controller.snapshot.statusCode).toBe("capture_resume_pending"));
      renewal.mockRejectedValueOnce(new Error("offline"));
      await expect(f.controller.stopRecording()).rejects.toThrow("offline");
      expect(f.controller.snapshot).toMatchObject({ state: "paused", statusCode: "capture_resume_pending", recordedChunks: 1 });
      await f.controller.stopRecording();
      expect(f.controller.snapshot.state).toBe("processing");
      expect(renewal.mock.calls[2]).toEqual(renewal.mock.calls[0]);
      expect(f.source.starts).toBe(1);
    } finally { await f.close(); }
  });
});

class SyntheticWindowSource implements CaptureSource {
  readonly kind = "synthetic" as const;
  readonly channel = "mixed" as const;
  readonly supportsRenewal = true as const;
  starts = 0; stops = 0; sequence = 0;
  window: CaptureSourceWindow | undefined;
  extensions: CaptureSourceWindow[] = [];
  options: CaptureSourceStartOptions | undefined;
  async start(options: CaptureSourceStartOptions): Promise<void> {
    this.starts++; this.sequence = 0; this.options = options; this.window = options.window;
    expect(this.window).toBeDefined();
  }
  async extend(window: CaptureSourceWindow): Promise<void> {
    expect(window.generation).toBe(this.window!.generation + 1);
    expect(window.expiresAtMilliseconds).toBeGreaterThan(this.window!.expiresAtMilliseconds);
    this.window = window; this.extensions.push(window);
  }
  async emit(full = false): Promise<void> {
    const options = this.options!;
    expect(this.sequence).toBeLessThan(this.window!.maximumChunks);
    const profile = pcm16WavProfile(options.capabilities);
    const samples = new Int16Array(new ArrayBuffer((full ? 160000 : 1600) * 2));
    samples.fill(12288); // Same synthetic mixed sample as the real Swift pipe fixture.
    const wavBytes = encodePcm16MonoWav(samples, profile);
    await options.onChunk({ sequenceNumber: this.sequence++, durationMs: full ? 10000 : 100, wavBytes });
    expect(wavBytes.every(value => value === 0)).toBe(true);
  }
  async stop(): Promise<void> { this.stops++; }
}

class Clock {
  time = Date.now();
  timers = new Map<object, { due: number; callback: () => void }>();
  now = () => new Date(this.time);
  schedule = (callback: () => void, delay: number) => {
    const handle = {}; this.timers.set(handle, { due: this.time + delay, callback }); return handle;
  };
  cancel = (handle: unknown) => { this.timers.delete(handle as object); };
  advance(ms: number): boolean {
    this.time += ms;
    const due = [...this.timers].filter(([, timer]) => timer.due <= this.time);
    for (const [handle, timer] of due) { this.timers.delete(handle); timer.callback(); }
    return due.length > 0;
  }
}

async function fixture(uploadWhileRecording = false) {
  const clock = new Clock(), server = createMockBffServer({ now: clock.now });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bff = new HttpCaptureBff((input, init) => fetch(typeof input === "string" ? new URL(input, origin) : input, init));
  const indexedDB = new IDBFactory(), flowName = crypto.randomUUID(), queueName = crypto.randomUUID();
  let store = await EncryptedIndexedDbFlowStore.open({ databaseName: flowName, indexedDB, crypto });
  let storage = await EncryptedIndexedDbQueueStorage.open({ databaseName: queueName, indexedDB, crypto });
  const source = new SyntheticWindowSource();
  const build = () => new CaptureFlowController({ bff, flowStore: store, queue: new CaptureQueue(storage, { crypto, now: () => clock.time }),
    queueTransport: new BffCaptureQueueTransport(bff, new HttpCiphertextUploadTarget([origin])),
    source, uploadWhileRecording, crypto, now: clock.now, scheduleTimeout: clock.schedule, cancelTimeout: clock.cancel });
  let controller = build(), sessionId = "";
  return { bff, source, clock, get store() { return store; }, get storage() { return storage; },
    get controller() { return controller; }, get sessionId() { return sessionId; },
    async prepare() {
      const person = { appointment_id: "synthetic", practitioner_id: "synthetic", patient_id: "synthetic" };
      const consent = await bff.createConsent({ ...person, participant_regions: ["US-NY"], modality: "in_person",
        method: "verbal_attestation", all_parties_consented: true, granted_at: clock.now().toISOString() }, { idempotencyKey: "continuity-consent" });
      const session = await bff.createSession({ ...person, consent_record_id: consent.id, modality: "in_person" }, { idempotencyKey: "continuity-session" });
      sessionId = session.id; await controller.prepareConfigured(session.id);
    },
    async reopen() {
      await controller.deactivate(); store.close(); storage.close();
      store = await EncryptedIndexedDbFlowStore.open({ databaseName: flowName, indexedDB, crypto });
      storage = await EncryptedIndexedDbQueueStorage.open({ databaseName: queueName, indexedDB, crypto });
      controller = build(); await controller.restore();
    },
    async close() {
      await controller.deactivate().catch(() => undefined); store.close(); storage.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
