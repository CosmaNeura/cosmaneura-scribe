import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64UrlEncode, encodeChunkAdditionalDataBase64Url, encodeEnvelope, PROTOCOL_VERSION } from "@cosmaneura-scribe/capture-protocol";
import { EncryptedIndexedDbQueueStorage } from "../storage/encrypted-indexeddb";
import { CaptureQueue, type ChunkReservation } from "../queue";
import type { CaptureBff } from "../bff/contracts";
import { connectNativeProviderRecorder, parseNativeRecordingState } from "./native-recorder";
import { recordingFixture, syntheticSession as sessionId } from "./native-recorder.fixture";
import { beginRecordReadyTiming, startWithRecordReadyTiming } from "./record-ready-timing";

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

async function retainedUpload(h: Awaited<ReturnType<typeof fixture>>) {
  const queue = new CaptureQueue(h.storage), objectId = crypto.randomUUID(), createdAt = "2026-10-15T12:00:00.000Z";
  const reservation: ChunkReservation = { protocolVersion: PROTOCOL_VERSION, objectId, sessionId, channel: "microphone",
    sequenceNumber: 0, createdAt, additionalAuthenticatedData: encodeChunkAdditionalDataBase64Url({
      tenantId: crypto.randomUUID(), objectId, sessionId, channel: "microphone", sequenceNumber: 0 }) };
  await queue.reserve(reservation, crypto.randomUUID());
  const encrypted = await queue.encrypt(objectId, encodeEnvelope({ schema_version: PROTOCOL_VERSION,
    content_encryption: "A256GCM", nonce: base64UrlEncode(new Uint8Array(12)), media_type: "audio/wav" }, new Uint8Array(48)));
  const receipt = vi.fn<CaptureBff["getChunkReceipt"]>().mockResolvedValue({ state: "registered",
    reservation: { protocol_version: PROTOCOL_VERSION, object_id: objectId, session_id: sessionId, channel: "microphone",
      sequence_number: 0, additional_authenticated_data: reservation.additionalAuthenticatedData, created_at: createdAt },
    registration: { chunk_id: crypto.randomUUID(), sha256: encrypted.sha256,
      ciphertext_size_bytes: encrypted.byteLength, registered_at: createdAt } });
  const complete = vi.fn<CaptureBff["completeCapture"]>().mockResolvedValue({ id: sessionId,
    appointment_id: crypto.randomUUID(), consent_record_id: crypto.randomUUID(), created_at: createdAt,
    ingest_mode: "chunk_upload", modality: "in_person", patient_id: crypto.randomUUID(),
    practitioner_id: crypto.randomUUID(), status: "uploaded" });
  h.bff.getChunkReceipt = receipt; h.bff.completeCapture = complete;
  return { receipt, complete, queue, objectId, completion: { idempotencyKey: crypto.randomUUID(),
    leaseId: crypto.randomUUID(), leaseGeneration: 14, finalSequence: 0 } };
}

describe("native provider controller", () => {
  it("maps native time on existing requests without adding a polling or authority path", async () => {
    const h = await fixture(); let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    h.f.set({ nativeTiming: { version: 1, clock: "dispatch-uptime-ns", monotonicNs: "1000000000", captureAttempt: 0, droppedEvents: 0 } });
    const original = h.port.command;
    h.port.command = request => {
      if (request.kind === "start") {
        h.f.set({ nativeTiming: { version: 1, clock: "dispatch-uptime-ns", monotonicNs: "1082000000", captureAttempt: 1, droppedEvents: 0 } });
        now = 184;
      }
      return original(request);
    };
    const view = await h.open();
    try {
      expect(view.controller.snapshot.native?.clockCorrelation?.transportBracketWidthMs).toBe(0);
      expect(view.controller.snapshot.native?.clockCorrelation?.uncertaintyMs).toBeNull();
      now = 180; await view.controller.startRecording();
      const result = view.controller.snapshot.native?.clockCorrelation;
      expect(result?.sample.captureAttempt).toBe(1);
      expect(result?.sentAtRendererMs).toBe(180); expect(result?.receivedAtRendererMs).toBe(184);
      expect(result?.estimatedRendererAtAnchorLowerMs).toBe(100); expect(result?.estimatedRendererAtAnchorUpperMs).toBe(100);
      expect(result?.qualification).toBe("NOT_ESTABLISHED");
      expect(h.commands.map(command => command.kind)).toEqual(["start"]);
      expect(view.controller.snapshot.state).toBe("recording");
    } finally { await view.deactivate(); h.storage.close(); }
  });
  it("ignores a late native time sample after a newer paused reply", async () => {
    const h = await fixture(); let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    h.f.set({ nativeTiming: { version: 1, clock: "dispatch-uptime-ns", monotonicNs: "1000000000", captureAttempt: 1, droppedEvents: 0 } });
    const view = await h.open(), held = deferred<unknown>(), original = h.port.command;
    let late: unknown;
    h.port.command = request => {
      if (request.kind === "read") { late = h.response(request.requestId); return held.promise; }
      if (request.kind === "pause") {
        h.f.set({ nativeTiming: { version: 1, clock: "dispatch-uptime-ns", monotonicNs: "1020000000", captureAttempt: 1, droppedEvents: 0 } });
        now = 125;
      }
      return original(request);
    };
    try {
      now = 110; const reading = view.controller.getCaptureSignal!();
      now = 115; await view.controller.pauseRecording!();
      const accepted = view.controller.snapshot.native?.clockCorrelation;
      now = 130; held.resolve(late); await reading;
      expect(view.controller.snapshot.native?.clockCorrelation).toEqual(accepted);
      expect(view.controller.snapshot.state).toBe("paused");
    } finally { await view.deactivate(); h.storage.close(); }
  });
  it("finishes the original frontend span only after its positive native recording reply", async () => {
    const h = await fixture(), held = deferred<unknown>(), command = h.port.command;
    let now = 100, requestId = "";
    const report = vi.fn(), timing = beginRecordReadyTiming(report, { now: () => now });
    now = 3100; const view = await h.open(); // Admission/acquisition work stayed inside the span.
    h.port.command = request => request.kind === "start" ? (requestId = request.requestId, held.promise) : command(request);
    try {
      const starting = startWithRecordReadyTiming(view.controller, timing, () => !h.abort.signal.aborted);
      await vi.waitFor(() => expect(requestId).not.toBe("")); expect(report).not.toHaveBeenCalled();
      now = 5600; h.f.set({ phase: "recording" }); held.resolve(h.response(requestId)); await starting;
      expect(report.mock.calls).toEqual([[5500]]);
    } finally { await view.deactivate(); h.storage.close(); }
  });
  it("does not time a cancel-resolved Start even when its original native reply arrives late", async () => {
    const h = await fixture(), held = deferred<unknown>(), command = h.port.command;
    let late: unknown, requestId = "";
    h.port.command = request => {
      if (request.kind !== "start") return command(request);
      requestId = request.requestId; h.f.set({ phase: "recording" }); late = h.response(requestId);
      return held.promise;
    };
    const view = await h.open(), report = vi.fn();
    try {
      const starting = startWithRecordReadyTiming(view.controller, beginRecordReadyTiming(report), () => true);
      await vi.waitFor(() => expect(requestId).not.toBe(""));
      await view.controller.pauseRecording!(); await starting;
      expect(view.controller.snapshot.native?.phase).toBe("paused"); expect(report).not.toHaveBeenCalled();
      held.resolve(late); await Promise.resolve(); await Promise.resolve();
      expect(report).not.toHaveBeenCalled(); expect(view.controller.snapshot.native?.phase).toBe("paused");
    } finally { held.resolve(late); await view.deactivate(); h.storage.close(); }
  });
  it("uses the advertised device UID without replacing the session or saved capture position", async () => {
    const h = await fixture(), command = h.port.command;
    const devices = [
      { id: "synthetic-phone", label: "Synthetic phone", kind: "built_in" as const, current: true },
      { id: "synthetic-headset", label: "Synthetic headset", kind: "bluetooth" as const, current: false },
    ] as const;
    h.f.set({ phase: "recording", inputDevices: devices, selectedInputId: devices[0].id,
      recordedChunks: 1, recordedPlaintextBytes: 204 });
    h.port.command = request => {
      if (request.kind === "input") h.f.set({ selectedInputId: request.inputId ?? null,
        inputDevices: devices.map(device => ({ ...device, current: device.id === request.inputId })) });
      return command(request);
    };
    const view = await h.open();
    try {
      await view.controller.selectAudioInput!(devices[1].id);
      expect(h.commands).toHaveLength(1);
      expect(h.commands[0]).toMatchObject({ kind: "input", input: "bluetooth", inputId: "synthetic-headset" });
      expect(view.controller.snapshot).toMatchObject({ sessionId, state: "recording", recordedChunks: 1, selectedInputId: devices[1].id });
      await expect(view.controller.selectAudioInput!("unadvertised")).rejects.toThrow();
    } finally { await view.deactivate(); h.storage.close(); }
  });
  it("reports accepted frames before a chunk is committed and freezes without new frames", async () => {
    const h = await fixture();
    h.f.set({ phase: "recording", capturedAudioFrames: 16_000 });
    const view = await h.open();
    try {
      expect(view.controller.snapshot).toMatchObject({ elapsedSeconds: 1, recordedChunks: 0, queuedChunks: 0 });
      await view.controller.refreshTranscriptionStatus();
      expect(view.controller.snapshot.elapsedSeconds).toBe(1);
      h.f.set({ capturedAudioFrames: 32_000 });
      await view.controller.refreshTranscriptionStatus();
      expect(view.controller.snapshot.elapsedSeconds).toBe(2);
      h.f.set({ phase: "paused", recordedChunks: 1, recordedPlaintextBytes: 64_044 });
      await view.controller.refreshTranscriptionStatus();
      expect(view.controller.snapshot.elapsedSeconds).toBe(2);
      await view.controller.resumeRecording!();
      h.f.set({ capturedAudioFrames: 48_000 });
      await view.controller.refreshTranscriptionStatus();
      expect(view.controller.snapshot).toMatchObject({ elapsedSeconds: 3, recordedChunks: 1 });
    } finally { await view.deactivate(); h.storage.close(); }
  });

  it("does not label upload before native stop and sealing are confirmed", async () => {
    const h = await fixture(), held = deferred<unknown>();
    let sealId = "";
    h.f.set({ phase: "recording" });
    const command = h.port.command;
    h.port.command = request => {
      if (request.kind !== "seal") return command(request);
      sealId = request.requestId; h.f.set({ phase: "pausing", busy: true }); return held.promise;
    };
    const view = await h.open();
    try {
      const stopping = view.controller.stopRecording(), rejected = expect(stopping).rejects.toThrow();
      await view.controller.refreshTranscriptionStatus();
      expect(view.controller.snapshot.statusCode).toBe("capture_stopping");
      h.f.set({ phase: "sealing" });
      await view.controller.refreshTranscriptionStatus();
      expect(view.controller.snapshot.statusCode).toBe("capture_sealing");
      h.f.set({ phase: "paused", busy: false, failure: "recoveryFailed" });
      held.resolve(h.f.response(sealId, false)); await rejected;
      expect(view.controller.snapshot.statusCode).toBe("capture_recovery_pending");
    } finally { await view.deactivate(); h.storage.close(); }
  });

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

  it("keeps an incomplete native tail visible on repeated reads", async () => {
    const h = await fixture();
    h.f.set({ phase: "stopPending", failure: "recordingIncomplete", recordedChunks: 1, recordedPlaintextBytes: 204 });
    const view = await h.open();
    try {
      expect(view.controller.snapshot).toMatchObject({ statusCode: "capture_tail_not_saved", recordedChunks: 1 });
      await view.controller.refreshTranscriptionStatus();
      expect(view.controller.snapshot.statusCode).toBe("capture_tail_not_saved");
      expect(h.commands.map(c => c.kind)).toEqual(["read"]);
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
      await starting;
      expect(view.controller.snapshot.native?.phase).toBe("paused");
      expect(view.controller.snapshot.statusCode).toBe("capture_paused");
      const old = { ...h.f.state, revision: 1, phase: "recording" };
      pending.resolve({ requestId: startID, ok: true, recording: old }); await starting;
      expect(view.controller.snapshot.state).toBe("paused");
      expect(h.commands.map(c => c.kind)).toEqual(["pause"]);
    } finally { await view.deactivate(); h.storage.close(); }
  });

  it("keeps a newer Resume starting when the cancelled Start fails late", async () => {
    const h = await fixture(), first = deferred<unknown>(), second = deferred<unknown>();
    const command = h.port.command;
    let calls = 0, firstID = "", secondID = "";
    h.port.command = request => {
      if (request.kind !== "start") return command(request);
      if (++calls === 1) { firstID = request.requestId; return first.promise; }
      secondID = request.requestId;
      return second.promise;
    };
    const view = await h.open();
    try {
      const starting = view.controller.startRecording();
      await view.controller.stopRecording();
      await starting;
      expect(view.controller.snapshot.statusCode).toBe("capture_paused");
      const resuming = view.controller.resumeRecording!();
      expect(view.controller.snapshot.statusCode).toBe("capture_starting");
      first.resolve(h.f.response(firstID, false));
      await Promise.resolve();
      await Promise.resolve();
      expect(view.controller.snapshot.statusCode).toBe("capture_starting");
      expect(view.controller.snapshot.native?.phase).toBe("starting");
      expect(h.commands.map(c => c.kind)).toEqual(["pause"]);
      h.f.set({ phase: "recording" });
      second.resolve(h.f.response(secondID));
      await resuming;
      expect(view.controller.snapshot.statusCode).toBe("capture_recording");
    } finally { await view.deactivate(); h.storage.close(); }
  });

  it("does not settle Start until native cancellation is confirmed", async () => {
    const h = await fixture(), pending = deferred<unknown>(), command = h.port.command;
    let startID = "", rejectPause = true, settled = false;
    h.port.command = request => {
      if (request.kind === "start") { startID = request.requestId; return pending.promise; }
      if (request.kind === "pause" && rejectPause) return Promise.resolve(h.f.response(request.requestId, false));
      return command(request);
    };
    const view = await h.open();
    try {
      const starting = view.controller.startRecording().then(() => { settled = true; });
      await expect(view.controller.stopRecording()).rejects.toThrow();
      expect(settled).toBe(false);
      expect(view.controller.snapshot.statusCode).toBe("capture_starting");
      rejectPause = false;
      await view.controller.stopRecording();
      await starting;
      expect(settled).toBe(true);
      expect(view.controller.snapshot.statusCode).toBe("capture_paused");
      pending.resolve(h.f.response(startID));
      await Promise.resolve();
      expect(h.commands.map(c => c.kind)).toEqual(["pause"]);
    } finally { await view.deactivate(); h.storage.close(); }
  });

  it("releases a cancelled Start even when its failure-confirmation read is delayed", async () => {
    const h = await fixture(), pending = deferred<unknown>(), command = h.port.command;
    let readID = "";
    h.port.command = request => {
      if (request.kind === "start") return Promise.resolve(h.f.response(request.requestId, false));
      if (request.kind === "read") { readID = request.requestId; return pending.promise; }
      return command(request);
    };
    const view = await h.open();
    try {
      const starting = view.controller.startRecording();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(readID).not.toBe("");
      await view.controller.stopRecording();
      await starting;
      expect(view.controller.snapshot.statusCode).toBe("capture_paused");
      pending.resolve(h.f.response(readID));
      await Promise.resolve();
      expect(view.controller.snapshot.statusCode).toBe("capture_paused");
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

  it.each(["continue", "input"] as const)("finishes retained audio once while a delayed %s is starting", async operation => {
    const h = await fixture(), retained = await retainedUpload(h), pending = deferred<unknown>(), sealing = deferred<unknown>();
    const command = h.port.command;
    const devices = [
      { id: "synthetic-phone", label: "Synthetic phone", kind: "built_in" as const, current: true },
      { id: "synthetic-headset", label: "Synthetic headset", kind: "bluetooth" as const, current: false },
    ];
    h.f.set({ phase: operation === "continue" ? "paused" : "recording", recordedChunks: 1,
      recordedPlaintextBytes: 204, inputDevices: devices, selectedInputId: devices[0]!.id });
    let pendingID = "", sealID = "";
    h.port.command = request => {
      if (request.kind === (operation === "continue" ? "start" : "input")) {
        h.commands.push(request); pendingID = request.requestId;
        if (operation === "input") h.f.set({ phase: "starting", busy: true });
        return pending.promise;
      }
      if (request.kind === "seal") {
        h.commands.push(request); sealID = request.requestId;
        h.f.set({ phase: "sealing", busy: true }); return sealing.promise;
      }
      return command(request);
    };
    const view = await h.open();
    try {
      const continuation = operation === "continue" ? view.controller.resumeRecording!()
        : view.controller.selectAudioInput!(devices[1]!.id);
      const settledContinuation = operation === "input" ? expect(continuation).rejects.toThrow() : continuation;
      if (operation === "input") await view.controller.refreshTranscriptionStatus();
      expect(view.controller.snapshot.native?.phase).toBe("starting");
      const finishing = view.controller.stopRecording();
      await vi.waitFor(() => expect(h.commands.filter(c => c.kind === "seal")).toHaveLength(1));
      const lateCancelledResponse = h.f.response(pendingID, false);
      const duplicateFinish = view.controller.stopRecording();
      expect(retained.complete).not.toHaveBeenCalled();
      h.f.set({ phase: "sealed", busy: false, completion: retained.completion });
      sealing.resolve(h.f.response(sealID));
      await Promise.all([finishing, duplicateFinish]);
      expect(view.controller.snapshot).toMatchObject({ sessionId, state: "processing", recordedChunks: 1 });
      expect(h.commands.filter(c => c.kind === "pause")).toHaveLength(1);
      expect(h.commands.filter(c => c.kind === "seal")).toHaveLength(1);
      expect(retained.receipt).toHaveBeenCalledTimes(1);
      expect(retained.complete).toHaveBeenCalledTimes(1);
      expect(retained.complete.mock.calls[0]).toEqual([sessionId, { protocol_version: "1.0",
        capture_lease_id: retained.completion.leaseId, capture_lease_generation: 14,
        channels: [{ channel: "microphone", final_sequence_number: 0 }] },
      { idempotencyKey: retained.completion.idempotencyKey }]);
      expect((await retained.queue.get(retained.objectId))?.state).toBe("purged");
      pending.resolve(lateCancelledResponse); await settledContinuation;
      expect(view.controller.snapshot.state).toBe("processing");
      expect(h.commands.filter(c => c.kind === "start")).toHaveLength(operation === "continue" ? 1 : 0);
      expect(h.commands.filter(c => c.kind === "input")).toHaveLength(operation === "input" ? 1 : 0);
    } finally { await view.deactivate(); h.storage.close(); }
  });

  it("keeps an initial-empty delayed Start cancellation even when Pause commits its tail", async () => {
    const h = await fixture(), pending = deferred<unknown>(), command = h.port.command;
    let startID = "";
    h.port.command = request => {
      if (request.kind === "start") { startID = request.requestId; return pending.promise; }
      if (request.kind === "pause") h.f.set({ recordedChunks: 1, recordedPlaintextBytes: 204 });
      return command(request);
    };
    const view = await h.open();
    try {
      const starting = view.controller.startRecording();
      expect(view.controller.snapshot.recordedChunks).toBe(0);
      await view.controller.stopRecording(); await starting;
      expect(view.controller.snapshot).toMatchObject({ state: "paused", recordedChunks: 1, statusCode: "capture_paused" });
      pending.resolve(h.f.response(startID, false)); await Promise.resolve();
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
    { maximumPlaintextBytes: 1 }, { revision: -1 }, { completion: { finalSequence: 3 } }, { secret: "excluded" },
    ...[-1, 0.5, NaN, Infinity, 327_680_001].map(capturedAudioFrames => ({ capturedAudioFrames })),
    { recordedChunks: 1, recordedPlaintextBytes: 320_044, capturedAudioFrames: 159_999 }])(
  "rejects malformed native metadata %j", update => {
    expect(() => parseNativeRecordingState({ ...recordingFixture().state, ...update })).toThrow();
  });
});
