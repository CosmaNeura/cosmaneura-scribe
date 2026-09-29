import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64UrlEncode, encodeChunkAdditionalDataBase64Url, encodeEnvelope, PROTOCOL_VERSION } from "@cosmaneura-scribe/capture-protocol";
import { EncryptedIndexedDbQueueStorage } from "../storage/encrypted-indexeddb";
import { CaptureQueue, type ChunkReservation } from "../queue";
import type { CaptureBff } from "../bff/contracts";
import { connectNativeProviderRecorder, parseNativeRecordingState } from "./native-recorder";
import { recordingFixture, syntheticSession as sessionId } from "./native-recorder.fixture";

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  const f = recordingFixture(), abort = new AbortController();
  const storage = await EncryptedIndexedDbQueueStorage.open({ databaseName: crypto.randomUUID(), indexedDB: new IDBFactory(), crypto });
  const unused = async (): Promise<never> => { throw new Error("Unexpected renderer key/lease/source work"); };
  const bff: CaptureBff = { getAudioEncryptionKey: unused, createConsent: unused, createSession: unused,
    bindSessionAudioKey: unused, getCapabilities: unused, issueLease: unused, renewLease: unused,
    reserveChunks: unused, authorizeUpload: unused, getChunkReceipt: unused, registerChunk: unused,
    completeCapture: unused, getTranscriptionStatus: unused, getTranscript: unused };
  return { ...f, f, abort, storage, bff, open: () => connectNativeProviderRecorder({ sessionId, port: f.port,
    bff, queueStorage: storage, uploadTarget: { putCompleteEnvelope: unused }, signal: abort.signal }) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("native provider controller", () => {
  it("keeps an interruption visible without resuming until the provider chooses Resume", async () => {
    const h = await fixture(), command = h.port.command;
    h.f.set({ phase: "paused", failure: "captureInterrupted", recordedChunks: 1, recordedPlaintextBytes: 204 });
    h.port.command = request => {
      if (request.kind === "start") h.f.set({ failure: null });
      return command(request);
    };
    const view = await h.open();
    try {
      expect(view.controller.snapshot).toMatchObject({ state: "paused", statusCode: "capture_interrupted", recordedChunks: 1 });
      await view.controller.refreshTranscriptionStatus();
      expect(view.controller.snapshot.statusCode).toBe("capture_interrupted");
      expect(h.commands.map(c => c.kind)).toEqual(["read"]);
      await view.controller.resumeRecording!();
      expect(view.controller.snapshot.statusCode).toBe("capture_recording");
      expect(view.controller.snapshot.recordedChunks).toBe(1);
      expect(h.commands.map(c => c.kind)).toEqual(["read", "start"]);
    } finally { await view.deactivate(); h.storage.close(); }
  });

  it.each([0, 1])("keeps failed sealing distinct from an ordinary pause with %i saved chunks", async recordedChunks => {
    const h = await fixture(), command = h.port.command;
    h.f.set({ phase: "recording", recordedChunks, recordedPlaintextBytes: recordedChunks * 204 });
    h.port.command = request => {
      if (request.kind === "seal") {
        h.commands.push(request);
        h.f.set({ phase: "paused", failure: "recoveryFailed" });
        return Promise.resolve(h.f.response(request.requestId, false));
      }
      if (request.kind === "start") h.f.set({ failure: null });
      return command(request);
    };
    const view = await h.open();
    try {
      await expect(view.controller.stopRecording()).rejects.toThrow();
      expect(view.controller.snapshot).toMatchObject({ state: "paused", statusCode: "capture_recovery_pending", recordedChunks });
      await view.controller.refreshTranscriptionStatus();
      expect(view.controller.snapshot.statusCode).toBe("capture_recovery_pending");
      await view.controller.resumeRecording!();
      expect(view.controller.snapshot.statusCode).toBe("capture_recording");
      expect(h.commands.map(c => c.kind)).toEqual(["seal", "read", "start"]);
    } finally { await view.deactivate(); h.storage.close(); }
  });

  it("shows Starting immediately, permits cancellation and ignores an older late start response", async () => {
    const h = await fixture(), pending = deferred<unknown>(), command = h.port.command;
    let startID = "";
    h.port.command = request => { if (request.kind === "start") { startID = request.requestId; return pending.promise; } return command(request); };
    const view = await h.open();
    try {
      const starting = view.controller.startRecording();
      expect(view.controller.snapshot.native?.phase).toBe("starting");
      expect(view.controller.snapshot.state).toBe("ready");
      await view.controller.stopRecording();
      const old = { ...h.f.state, revision: 1, phase: "recording" };
      pending.resolve({ requestId: startID, ok: true, recording: old }); await starting;
      expect(view.controller.snapshot.state).toBe("paused");
      expect(h.commands.map(c => c.kind)).toEqual(["pause"]);
    } finally { await view.deactivate(); h.storage.close(); }
  });

  it("uses a fresh native read to confirm recording while the original start reply is delayed", async () => {
    const h = await fixture(), pending = deferred<unknown>(), command = h.port.command;
    let startID = "";
    h.port.command = request => { if (request.kind === "start") { startID = request.requestId; return pending.promise; } return command(request); };
    const view = await h.open(), starting = view.controller.startRecording();
    try {
      h.f.set({ phase: "recording" });
      await view.controller.refreshTranscriptionStatus();
      expect(view.controller.snapshot.native?.phase).toBe("recording");
      expect(view.controller.snapshot.statusCode).toBe("capture_recording");
      pending.resolve(h.f.response(startID)); await starting;
    } finally { await view.deactivate(); h.storage.close(); }
  });

  it("shows Resume starting immediately and cancels it without uploading retained audio", async () => {
    const h = await fixture(), pending = deferred<unknown>(), command = h.port.command;
    h.f.set({ phase: "paused", recordedChunks: 1, recordedPlaintextBytes: 320_044 });
    let startID = "";
    h.port.command = request => { if (request.kind === "start") { startID = request.requestId; return pending.promise; } return command(request); };
    const view = await h.open();
    try {
      const resuming = view.controller.resumeRecording!();
      expect(view.controller.snapshot.native?.phase).toBe("starting");
      expect(view.controller.snapshot.statusCode).toBe("capture_starting");
      await view.controller.stopRecording();
      pending.resolve(h.f.response(startID)); await resuming;
      expect(view.controller.snapshot.state).toBe("paused");
      expect(view.controller.snapshot.recordedChunks).toBe(1);
      expect(h.commands.map(c => c.kind)).toEqual(["pause"]);
    } finally { await view.deactivate(); h.storage.close(); }
  });

  it("confirms native start within 250ms and stops redundant or hidden polling", async () => {
    const h = await fixture(), pending = deferred<unknown>(), command = h.port.command;
    let startID = "";
    h.port.command = request => { if (request.kind === "start") { startID = request.requestId; return pending.promise; } return command(request); };
    vi.useFakeTimers();
    const view = await h.open();
    try {
      const starting = view.controller.startRecording();
      h.f.set({ phase: "recording" });
      await vi.advanceTimersByTimeAsync(249);
      expect(view.controller.snapshot.native?.phase).toBe("starting");
      await vi.advanceTimersByTimeAsync(1);
      expect(view.controller.snapshot.state).toBe("recording");
      pending.resolve(h.f.response(startID)); await starting;
      for (let i = 0; i < 4; i += 1) {
        await view.controller.getCaptureSignal!();
        await vi.advanceTimersByTimeAsync(250);
      }
      expect(h.commands.filter(c => c.kind === "read")).toHaveLength(5);
      Object.assign(document, { visibilityState: "hidden" });
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.commands.filter(c => c.kind === "read")).toHaveLength(5);
      Object.assign(document, { visibilityState: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve(); await Promise.resolve();
      expect(h.commands.filter(c => c.kind === "read")).toHaveLength(6);
    } finally { await view.deactivate(); h.storage.close(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the exact handle across failed close and never requests renderer key or lease work", async () => {
    const h = await fixture(), view = await h.open(), command = h.port.command;
    h.port.command = vi.fn().mockRejectedValueOnce(new Error("Lost close response")).mockImplementation(command);
    await expect(view.deactivate()).rejects.toThrow("Lost close response");
    await view.deactivate();
    expect(h.commands.at(-1)).toMatchObject({ kind: "close", recorderId: h.f.state.recorderId });
    h.storage.close();
  });

  it("returns a failed or late open handle for explicit workspace cleanup", async () => {
    const h = await fixture();
    h.port.open = async (_session, id) => {
      h.abort.abort(); h.f.set({ phase: "failed", failure: "preparationFailed" }); return h.f.response(id, false);
    };
    const view = await h.open();
    await view.deactivate();
    expect(h.commands.map(c => c.kind)).toEqual(["close"]); h.storage.close();
  });

  it("refreshes real signal metadata, changes input only deliberately and rejects another handle", async () => {
    const h = await fixture(), view = await h.open();
    try {
      await view.controller.selectMicrophoneInput!("built_in"); expect(h.commands).toHaveLength(0);
      await view.controller.selectMicrophoneInput!("external");
      expect(h.commands.at(-1)).toMatchObject({ kind: "input", input: "external" });
      expect(await view.controller.getCaptureSignal!()).toEqual({ version: 2, signal: null });
      h.f.set({ recorderId: crypto.randomUUID() });
      await expect(view.controller.getCaptureSignal!()).rejects.toThrow("provider_native_recording_unconfirmed");
    } finally { await view.deactivate(); h.storage.close(); }
  });

  it("reuses registered ciphertext receipts and the frozen completion intent after a lost response and reopen", async () => {
    const h = await fixture(), queue = new CaptureQueue(h.storage), held = deferred<void>();
    const receipts = new Map<string, Awaited<ReturnType<CaptureBff["getChunkReceipt"]>>>();
    const objectIds: string[] = [], createdAt = "2026-09-26T12:00:00.000Z";
    for (let sequenceNumber = 0; sequenceNumber < 3; sequenceNumber += 1) {
      const objectId = crypto.randomUUID(); objectIds.push(objectId);
      const reservation: ChunkReservation = { protocolVersion: PROTOCOL_VERSION, objectId, sessionId, channel: "microphone",
        sequenceNumber, createdAt, additionalAuthenticatedData:
          encodeChunkAdditionalDataBase64Url({ tenantId: crypto.randomUUID(), objectId, sessionId, channel: "microphone", sequenceNumber }) };
      await queue.reserve(reservation, crypto.randomUUID());
      const encrypted = await queue.encrypt(objectId, encodeEnvelope({ schema_version: PROTOCOL_VERSION,
        content_encryption: "A256GCM", nonce: base64UrlEncode(new Uint8Array(12)), media_type: "audio/wav" }, new Uint8Array(48)));
      receipts.set(objectId, { state: "registered", reservation: { protocol_version: PROTOCOL_VERSION,
        object_id: objectId, session_id: sessionId, channel: "microphone", sequence_number: sequenceNumber,
        additional_authenticated_data: reservation.additionalAuthenticatedData, created_at: createdAt },
      registration: { chunk_id: crypto.randomUUID(), sha256: encrypted.sha256,
        ciphertext_size_bytes: encrypted.byteLength, registered_at: createdAt } });
    }
    const getChunkReceipt = vi.fn<CaptureBff["getChunkReceipt"]>(async (_session, objectId) => {
      if (objectId === objectIds[2]) await held.promise;
      return receipts.get(objectId)!;
    });
    h.bff.getChunkReceipt = getChunkReceipt;
    const completion = { idempotencyKey: crypto.randomUUID(), leaseId: crypto.randomUUID(), leaseGeneration: 14, finalSequence: 2 };
    h.f.set({ phase: "sealed", recordedChunks: 3, recordedPlaintextBytes: 612, completion });
    const complete = vi.fn<CaptureBff["completeCapture"]>().mockRejectedValueOnce(new Error("Lost completion response"))
      .mockResolvedValue({ id: sessionId, appointment_id: crypto.randomUUID(), consent_record_id: crypto.randomUUID(),
        created_at: createdAt, ingest_mode: "chunk_upload", modality: "in_person",
        patient_id: crypto.randomUUID(), practitioner_id: crypto.randomUUID(), status: "uploaded" });
    h.bff.completeCapture = complete;
    const first = await h.open();
    const uploading = first.resumePendingWork();
    const rejected = expect(uploading).rejects.toThrow("Lost completion response");
    await vi.waitFor(() => expect(first.controller.snapshot.native?.uploadProgress).toEqual({ total: 3, registered: 2 }));
    expect(first.controller.snapshot.queuedChunks).toBe(1);
    expect(first.controller.snapshot.state).toBe("uploading");
    expect(complete).not.toHaveBeenCalled();
    held.resolve(); await rejected;
    expect(first.controller.snapshot.statusCode).toBe("capture_upload_pending");
    expect(first.controller.snapshot.native?.uploadProgress).toEqual({ total: 3, registered: 3 });
    expect(first.controller.snapshot.state).toBe("uploading");
    for (const objectId of objectIds) expect((await queue.get(objectId))?.state).toBe("purged");
    await first.deactivate();
    const reopened = await h.open();
    try {
      await reopened.resumePendingWork();
      expect(complete.mock.calls[0]).toEqual(complete.mock.calls[1]);
      expect(complete.mock.calls[1]![2]).toEqual({ idempotencyKey: completion.idempotencyKey });
      expect(reopened.controller.snapshot.state).toBe("processing");
      expect(getChunkReceipt).toHaveBeenCalledTimes(3);
      expect(h.commands.every(c => c.kind === "close")).toBe(true);
    } finally { await reopened.deactivate(); h.storage.close(); }
  });

  it("never completes an upload with a missing recorded position", async () => {
    const h = await fixture();
    h.f.set({ phase: "sealed", recordedChunks: 1080, recordedPlaintextBytes: 345_647_520,
      completion: { idempotencyKey: crypto.randomUUID(), leaseId: crypto.randomUUID(), leaseGeneration: 14, finalSequence: 1079 } });
    const view = await h.open();
    try {
      expect(view.controller.snapshot.elapsedSeconds).toBe(10800);
      expect(view.controller.snapshot.remainingBudgetSeconds).toBeGreaterThan(1700);
      await expect(view.resumePendingWork()).rejects.toThrow();
      expect(view.controller.snapshot.statusCode).toBe("capture_upload_pending");
      expect(view.controller.snapshot.native?.uploadProgress).toBeUndefined();
    } finally { await view.deactivate(); h.storage.close(); }
  });

  it.each([{ phase: {} }, { failure: {} }, { recordedChunks: 2049 }, { recordedPlaintextBytes: 1 },
    { maximumPlaintextBytes: 1 }, { revision: -1 }, { completion: { finalSequence: 3 } }, { secret: "excluded" }])(
  "rejects malformed native metadata %j", update => {
    expect(() => parseNativeRecordingState({ ...recordingFixture().state, ...update })).toThrow();
  });
});
