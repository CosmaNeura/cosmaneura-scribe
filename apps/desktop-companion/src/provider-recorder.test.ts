import { DesktopPcmCaptureSource } from "./pcm-capture-source.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockBffServer } from "../../capture/src/mock-bff/server";
import { HttpCaptureBff } from "../../capture/src/bff/http-client";
import { HttpCiphertextUploadTarget } from "../../capture/src/bff/upload-target";
import { connectDesktopRecorderView, parseDesktopRecorderState,
  type DesktopRecorderPort } from "../../capture/src/provider/desktop-recorder-view";
import { DesktopProviderRecorder, type DesktopProviderRecorderOptions, type PreparedDesktopCapture } from "./provider-recorder.js";
import { DesktopProviderRecorderIpc } from "./provider-recorder-ipc.js";
import { DurableDesktopRecordStore } from "./durable-record-store.js";
import { DurableDesktopFlowStore } from "./durable-flow-store.js";
import { DurableDesktopQueueStorage } from "./durable-queue-store.js";
import { DurableDesktopCoverage } from "./durable-provider-records.js";
import { InMemoryRecordingIndicator } from "./recording-indicator.js";
import { NativeProcessPCMDriver } from "./native-process-driver.js";
import { nativePipeFixtureFence } from "./native-pipe-fixture.js";

const helperPath = process.env.SCRIBE_DESKTOP_PIPE_FIXTURE;
const workspaceId = "10000000-0000-4000-8000-000000000001", recoveryScope = "20000000-0000-4000-8000-000000000002";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function fixture(nativeStub = false) {
  if (!helperPath && !nativeStub) throw new Error("separate compiled invented audio fixture required");
  const nativeAvailability = nativeStub ? vi.spyOn(NativeProcessPCMDriver.prototype, "getAvailability").mockResolvedValue(true) : undefined;
  const nativeStart = nativeStub ? vi.spyOn(NativeProcessPCMDriver.prototype, "start").mockImplementation(() => {
    throw new Error("Native I/O deliberately excluded from window-order checks");
  }) : undefined;
  if (nativeStub) cleanup.push(() => { nativeAvailability!.mockRestore(); nativeStart!.mockRestore(); });
  const directory = await mkdtemp(join(realpathSync(tmpdir()), "scribe-desktop-provider-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
  const server = createMockBffServer();
  cleanup.push(async () => { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bff = new HttpCaptureBff((url, init) => fetch(typeof url === "string" ? new URL(url, origin) : url, init));
  const person = { appointment_id: "invented-desktop-appointment", practitioner_id: "invented-creator", patient_id: "invented-patient" };
  const consent = await bff.createConsent({ ...person, participant_regions: ["US-NY"], modality: "in_person", method: "verbal_attestation",
    all_parties_consented: true, granted_at: new Date().toISOString() }, { idempotencyKey: "provider-invented-consent" });
  const session = await bff.createSession({ ...person, consent_record_id: consent.id, modality: "in_person" }, { idempotencyKey: "provider-invented-session" });
  const grant = { captureSessionId: session.id, actorId: "invented-creator", consentRecordId: consent.id,
    consentStatus: "granted", sessionStatus: "authorized", source: "desktop_companion", sourceLeaseId: "invented-desktop-source" } as const;
  const storeOptions = { directory, recoveryScope, workspaceId, key };
  let store = await DurableDesktopRecordStore.open(storeOptions);
  cleanup.push(() => store.close());
  const owned: DesktopProviderRecorder[] = [];
  const indicator = new InMemoryRecordingIndicator(), abort = new AbortController();
  const release = vi.fn(async () => { store.close(); });
  const authority = vi.fn(async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    return { schemaVersion: 1, decision: "authorized", ...grant, issuedAt: new Date().toISOString(), expiresAt,
      captureCapability: { capabilityId: crypto.randomUUID(), secret: "your-invented-start-capability", expiresAt } };
  });
  const selectWindow = vi.fn(async () => {
    expect(indicator.current()?.visible).not.toBe(true);
    return { application: "com.google.Chrome" as const, processID: 1, windowID: 1 };
  });
  const complete = vi.spyOn(bff, "completeCapture");
  const originalCapabilities = await bff.getCapabilities(session.id);
  // Small invented chunks expose accepted-vs-discarded tails without real speech.
  vi.spyOn(bff, "getCapabilities").mockResolvedValue({ ...originalCapabilities, target_chunk_duration_ms: 100 });
  const resources = () => {
    const flowStore = new DurableDesktopFlowStore(store.namespace("flow"));
    return { flowStore, createSessionKey: flowStore.createSessionKey,
      storageCapacity: { availableBytes: () => store.availableBytes() },
      queueStorage: new DurableDesktopQueueStorage(store.namespace(`queue:${session.id}`), session.id),
      coverage: new DurableDesktopCoverage(store.namespace("coverage"), session.id) };
  };
  const options: DesktopProviderRecorderOptions = { enabled: true, sessionId: session.id, signal: abort.signal,
    createBff: () => bff, authorizePreparation: async () => ({ sessionId: session.id, status: "created" }),
    authorizeMount: async () => ({ grant, status: "created" }), authority: { authorizeStart: authority },
    indicator, ...resources(), uploadTarget: new HttpCiphertextUploadTarget([origin]),
    native: { helperPath: helperPath ?? "/unused-native-ordering-fixture",
      helperSha256: nativeStub ? "0".repeat(64) : createHash("sha256").update(await readFile(helperPath!)).digest("hex"),
      getProcessFence: nativePipeFixtureFence,
      isSessionActive: () => !abort.signal.aborted },
    selectWindow, release, retireSource: vi.fn(async () => undefined) };
  return { options, indicator, abort, authority, selectWindow, release, complete, session, nativeStart, nativeAvailability,
    open: async (overrides: Partial<DesktopProviderRecorderOptions> = {}) => {
      const recorder = await DesktopProviderRecorder.open({ ...options, ...overrides }); owned.push(recorder); return recorder;
    },
    reopen: async () => { store = await DurableDesktopRecordStore.open(storeOptions); return resources(); },
    close: async () => {
      for (const recorder of owned) await recorder.deactivate(); store.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    } };
}

// The actual application uses Electron's sandboxed IPC. This port transports its
// exact cloned messages while the real main/flow/SQLite/Swift helper run below.
function wire(recorder: DesktopProviderRecorder) {
  type Main = ConstructorParameters<typeof DesktopProviderRecorderIpc>[0];
  type Event = Parameters<Parameters<Main["handle"]>[1]>[0];
  let handler: Parameters<Main["handle"]>[1] | undefined;
  const receive = new Set<(value: unknown) => void>(), exits = new Map<string, () => void>();
  const frame = { url: "app://cosmas/provider.html" }, event: Event = { sender: { id: 7, mainFrame: frame }, senderFrame: frame };
  const messages: unknown[] = [];
  const boundary = new DesktopProviderRecorderIpc({ handle: (_channel, fn) => { handler = fn; }, removeHandler: () => { handler = undefined; } },
    { id: 7, mainFrame: frame, isDestroyed: () => false, send: (_channel, value) => {
      messages.push(structuredClone(value)); receive.forEach(listener => listener(structuredClone(value)));
    }, on: (name, fn) => { exits.set(name, fn); }, removeListener: name => { exits.delete(name); } }, recorder);
  boundary.install();
  const invoke = (value: unknown, sender = event) => handler!(sender, structuredClone(value));
  const port: DesktopRecorderPort = { request: value => invoke(value), subscribe: listener => {
    receive.add(listener); return () => receive.delete(listener);
  } };
  return { port, boundary, invoke, event, messages, exits };
}

/** Invented PCM only: bypass the native executable and all OS audio/window I/O. */
function interruptedDriver(f: Awaited<ReturnType<typeof fixture>>) {
  let sink!: Parameters<NativeProcessPCMDriver["start"]>[1];
  const stop = vi.fn(async () => null);
  f.nativeStart!.mockImplementation((_configuration, value) => {
    sink = value;
    return { ready: Promise.resolve({ hostTimeNanoseconds: "1000000000",
      microphonePrerollNanoseconds: "0", systemPrerollNanoseconds: "0" }), activate: () => undefined, stop };
  });
  return { stop, interrupt: async (savedChunk = false) => {
    if (savedChunk) await sink.onPcmPacket({ firstFrame: 0, pcmBytes: new Uint8Array(3200) });
    // 25ms of invented silence, shorter than the fixture's 100ms saved chunk.
    await sink.onPcmPacket({ firstFrame: savedChunk ? 1600 : 0, pcmBytes: new Uint8Array(800) });
    sink.onFailure("overflow");
  } };
}

describe("confirmed stop recovery", () => {
  it("checks storage before native choice and retires the source after a low-space pause", async () => {
    const f = await fixture(true);
    let sink!: Parameters<NativeProcessPCMDriver["start"]>[1];
    const nativeStop = vi.fn(async ({ mode }: { mode: "drain" | "discard" }) => mode === "discard" ? null : ({
      start: { hostTimeNanoseconds: "1000000000", microphonePrerollNanoseconds: "0", systemPrerollNanoseconds: "0" },
      endHostTimeNanoseconds: "1100000000", outputFrames: 1600,
      microphoneTailNanoseconds: "0", systemTailNanoseconds: "0",
    }));
    f.nativeStart!.mockImplementation((_configuration, value) => {
      sink = value;
      return { ready: Promise.resolve({ hostTimeNanoseconds: "1000000000", microphonePrerollNanoseconds: "0", systemPrerollNanoseconds: "0" }), activate: () => undefined, stop: nativeStop };
    });
    const availableBytes = vi.fn(async () => 1);
    const recorder = await f.open({ storageCapacity: { availableBytes } });
    try {
      await expect(recorder.startRecording()).rejects.toThrow("capture_storage_low");
      expect(f.selectWindow).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
      expect(recorder.snapshot).toMatchObject({ state: "ready", statusCode: "capture_storage_low" });
      availableBytes.mockResolvedValue(10_000_000_000);
      await recorder.startRecording();
      availableBytes.mockResolvedValue(1);
      await sink.onPcmPacket({ firstFrame: 0, pcmBytes: new Uint8Array(3200) });
      await vi.waitFor(() => expect(recorder.snapshot).toMatchObject({ state: "paused", statusCode: "capture_storage_low" }));
      expect(nativeStop).toHaveBeenCalledTimes(1);
      expect(f.options.retireSource).toHaveBeenCalledTimes(1);
      expect(f.indicator.current()?.visible).not.toBe(true);
      expect((await f.options.queueStorage.listMetadata()).filter(record => record.state === "encrypted")).toHaveLength(1);
      expect(f.complete).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("retains zero saved chunks as paused without upload, completion, or fresh authority", async () => {
    const f = await fixture(true), driver = interruptedDriver(f);
    const issue = vi.spyOn(f.options.createBff(f.abort.signal), "issueLease");
    const upload = vi.spyOn(f.options.uploadTarget, "putCompleteEnvelope");
    const recorder = await f.open(), w = wire(recorder);
    const view = await connectDesktopRecorderView(w.port, f.session.id, f.abort.signal);
    try {
      const key = await f.options.flowStore.getSessionKeyState(f.session.id);
      const prepared = (await f.options.flowStore.getActiveCaptureState())!;
      const reserved = await f.options.queueStorage.list();
      await view.controller.startRecording(); await driver.interrupt();
      await vi.waitFor(() => expect(recorder.snapshot.state).toBe("paused"));
      await view.controller.stopRecording();
      expect(view.controller.snapshot).toMatchObject({ state: "paused", statusCode: "capture_no_saved_audio",
        recordedChunks: 0, elapsedSeconds: 0, desktop: { phase: "interrupted", coverage: "incomplete" } });
      expect(await f.options.flowStore.getActiveCaptureState()).toMatchObject({ phase: "paused", lease: prepared.lease });
      expect(await f.options.flowStore.getSessionKeyState(f.session.id)).toEqual(key);
      expect(await f.options.queueStorage.list()).toEqual(reserved);
      expect(upload).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
      expect(issue).toHaveBeenCalledTimes(1); expect(f.authority).toHaveBeenCalledTimes(1);
      expect(f.nativeStart).toHaveBeenCalledTimes(1);
      expect(driver.stop).toHaveBeenCalledWith({ mode: "discard" });
      expect(f.options.retireSource).toHaveBeenCalledTimes(1);
    } finally { await w.boundary.dispose(); await f.close(); }
  });

  it("uploads retained complete chunks while keeping discarded-tail coverage incomplete", async () => {
    const f = await fixture(true), driver = interruptedDriver(f);
    const upload = vi.spyOn(f.options.uploadTarget, "putCompleteEnvelope");
    const recorder = await f.open();
    try {
      await recorder.startRecording(); await driver.interrupt(true);
      await vi.waitFor(() => expect(recorder.snapshot.state).toBe("paused"));
      const retained = (await f.options.queueStorage.list()).filter(row => row.state === "encrypted");
      expect(retained).toHaveLength(1);
      const key = await f.options.flowStore.getSessionKeyState(f.session.id);
      await recorder.stopRecording();
      expect(recorder.snapshot).toMatchObject({ state: "processing", recordedChunks: 1,
        desktop: { phase: "stopped", coverage: "incomplete" } });
      expect(upload).toHaveBeenCalledTimes(1); expect(f.complete).toHaveBeenCalledTimes(1);
      expect(await f.options.flowStore.getSessionKeyState(f.session.id)).toEqual(key);
      expect(f.nativeStart).toHaveBeenCalledTimes(1); expect(f.authority).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });

  it.each(["native", "retirement"] as const)("does not report zero-audio recovery before %s stop confirmation", async barrier => {
    const f = await fixture(true), driver = interruptedDriver(f);
    const retireSource = vi.fn(async () => undefined);
    const recorder = await f.open({ retireSource });
    try {
      await recorder.startRecording();
      if (barrier === "native") driver.stop.mockRejectedValue(new Error("invented unconfirmed native closure"));
      else retireSource.mockRejectedValueOnce(new Error("invented lost server stop reply"));
      await driver.interrupt();
      await vi.waitFor(() => expect(recorder.snapshot.state).toBe("paused"));
      await expect(recorder.stopRecording()).rejects.toThrow();
      expect(recorder.snapshot.statusCode).not.toBe("capture_no_saved_audio");
      expect(recorder.snapshot.statusCode).not.toBe("capture_reopen_required");
      if (barrier === "native") {
        expect(recorder.snapshot.desktop?.phase).toBe("stop_unconfirmed");
        expect(retireSource).not.toHaveBeenCalled();
      } else expect(recorder.snapshot.statusCode).toBe("capture_stop_acknowledgement_pending");
      expect(f.complete).not.toHaveBeenCalled();
      driver.stop.mockResolvedValue(null);
      await recorder.stopRecording();
      expect(recorder.snapshot).toMatchObject({ state: "paused", statusCode: "capture_no_saved_audio" });
      expect(f.complete).not.toHaveBeenCalled(); expect(f.nativeStart).toHaveBeenCalledTimes(1);
    } finally { driver.stop.mockResolvedValue(null); await f.close(); }
  });

  it.each([false, true])("requires same-encounter reopen for an existing error without resetting it (mismatched session: %s)", async mismatch => {
    const f = await fixture(true), driver = interruptedDriver(f);
    const recorder = await f.open(), w = wire(recorder);
    const view = await connectDesktopRecorderView(w.port, f.session.id, f.abort.signal);
    try {
      await view.controller.startRecording(); await driver.interrupt();
      await vi.waitFor(() => expect(recorder.snapshot.state).toBe("paused"));
      await vi.waitFor(async () => expect((await f.options.flowStore.getActiveCaptureState())?.phase).toBe("paused"));
      const before = (await f.options.flowStore.getActiveCaptureState())!;
      const key = await f.options.flowStore.getSessionKeyState(f.session.id);
      const queue = await f.options.queueStorage.list();
      // Simulate a failed persistence acknowledgement after the existing pause
      // was durable. The unknown error must not be reset into recording-ready.
      vi.spyOn(f.options.flowStore, "putActiveCaptureState").mockRejectedValueOnce(new Error("invented persistence reply failure"));
      await expect(view.controller.stopRecording()).rejects.toThrow();
      expect(recorder.snapshot).toMatchObject({ state: "error", statusCode: "synthetic_preview_failed" });
      expect(await f.options.flowStore.getActiveCaptureState()).toEqual(before);
      if (mismatch) {
        vi.spyOn(f.options.flowStore, "getActiveCaptureState").mockResolvedValueOnce({ ...before, sessionId: crypto.randomUUID() });
        await expect(view.controller.stopRecording()).rejects.toThrow();
        expect(recorder.snapshot.statusCode).not.toBe("capture_reopen_required");
        return;
      }
      await view.controller.stopRecording();
      expect(view.controller.snapshot).toMatchObject({ state: "error", statusCode: "capture_reopen_required",
        recordedChunks: 0, desktop: { phase: "stopped", coverage: "incomplete" } });
      await expect(view.controller.startRecording()).rejects.toThrow();
      await expect(view.controller.resumeRecording!()).rejects.toThrow();
      expect(await f.options.flowStore.getActiveCaptureState()).toEqual(before);
      expect(await f.options.flowStore.getSessionKeyState(f.session.id)).toEqual(key);
      expect(await f.options.queueStorage.list()).toEqual(queue);
      expect(f.complete).not.toHaveBeenCalled();
      await view.deactivate(); await w.boundary.dispose();
      const resources = await f.reopen();
      const reopened = await f.open({ ...resources,
        authorizePreparation: async () => ({ sessionId: f.session.id, status: "capturing" }) });
      expect(reopened.snapshot).toMatchObject({ state: "paused", statusCode: "capture_recovered_paused", sessionId: f.session.id });
      expect(await resources.flowStore.getSessionKeyState(f.session.id)).toEqual(key);
      expect((await resources.flowStore.getActiveCaptureState())?.lease).toEqual(before.lease);
      expect(await resources.queueStorage.list()).toEqual(queue);
      expect(f.nativeStart).toHaveBeenCalledTimes(1); expect(f.authority).toHaveBeenCalledTimes(1);
    } finally { await w.boundary.dispose(); await f.close(); }
  });
});

describe.skipIf(!helperPath)("desktop provider main and renderer recorder", () => {
  it("shows native Stop and receipt progress while live upload and final confirmation are delayed", async () => {
    const f = await fixture(), uploadGate = deferred<void>(), completionGate = deferred<void>();
    const bff = f.options.createBff(f.abort.signal), capabilities = await bff.getCapabilities(f.session.id);
    // Use the existing short renewal fixture so new native packets arrive while
    // both upload workers are held; no physical microphone or wall-clock visit.
    vi.spyOn(bff, "getCapabilities").mockResolvedValue({ ...capabilities, max_reservations_per_batch: 10 });
    const renewal = vi.spyOn(bff, "renewLease");
    const target = f.options.uploadTarget.putCompleteEnvelope.bind(f.options.uploadTarget);
    const upload = vi.spyOn(f.options.uploadTarget, "putCompleteEnvelope").mockImplementation(async (...args) => {
      await uploadGate.promise; return target(...args);
    });
    const complete = HttpCaptureBff.prototype.completeCapture.bind(f.options.createBff(f.abort.signal));
    f.complete.mockImplementationOnce(async (...args) => { await completionGate.promise; return complete(...args); });
    const recorder = await f.open({ uploadWhileRecording: true }), w = wire(recorder);
    const view = await connectDesktopRecorderView(w.port, f.session.id, f.abort.signal);
    let stopping: Promise<void> | undefined;
    try {
      await view.controller.startRecording();
      await vi.waitFor(() => expect(upload).toHaveBeenCalled());
      expect(upload.mock.calls.length).toBeLessThanOrEqual(2);
      await vi.waitFor(() => expect(view.controller.snapshot.recordedChunks).toBe(5), { timeout: 3000 });
      expect(renewal).toHaveBeenCalledTimes(1);
      expect(view.controller.snapshot.uploadProgress).toEqual({ total: 5, registered: 0 });
      stopping = view.controller.stopRecording();
      await vi.waitFor(() => expect(view.controller.snapshot).toMatchObject({ statusCode: "capture_upload_settling",
        desktop: { phase: "stopped" }, uploadProgress: { total: 6, registered: 0 } }));
      expect(f.indicator.current()?.visible).toBe(false); expect(f.complete).not.toHaveBeenCalled();
      uploadGate.resolve();
      await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(1));
      expect(view.controller.snapshot).toMatchObject({ state: "uploading", statusCode: "capture_upload_confirming",
        uploadProgress: { total: 6, registered: 6 }, desktop: { phase: "stopped" } });
      completionGate.resolve(); await stopping;
      expect(view.controller.snapshot.state).toBe("processing");
      expect((await f.options.queueStorage.listMetadata()).filter(row => row.state === "purged")).toHaveLength(6);
    } finally {
      uploadGate.resolve(); completionGate.resolve(); await stopping?.catch(() => undefined);
      await view.deactivate(); await w.boundary.dispose(); await f.close();
    }
  });
  it("renews through Core, native capture and SQLite without another window choice or source mount", async () => {
    const f = await fixture();
    const bff = f.options.createBff(f.abort.signal), capabilities = await bff.getCapabilities(f.session.id);
    // Ten 100ms fixture chunks exercise the real renewal timer quickly; the
    // same generated source emits both tracks on each side of the renewal.
    vi.spyOn(bff, "getCapabilities").mockResolvedValue({ ...capabilities, max_reservations_per_batch: 10 });
    const renewal = vi.spyOn(bff, "renewLease"), mount = vi.fn(f.options.authorizeMount);
    const recorder = await f.open({ authorizeMount: mount }), w = wire(recorder);
    const view = await connectDesktopRecorderView(w.port, f.session.id, f.abort.signal);
    try {
      await view.controller.startRecording();
      // The aligned mixer retains its last packet until normal drain.
      await vi.waitFor(() => expect(view.controller.snapshot.recordedChunks).toBe(5), { timeout: 3000 });
      expect(renewal).toHaveBeenCalledTimes(1);
      expect(view.controller.snapshot).toMatchObject({ state: "recording", desktop: { coverage: "aligned" } });
      expect(f.indicator.current()?.visible).toBe(true);
      const active = await f.options.flowStore.getActiveCaptureState();
      expect(active).toMatchObject({ schemaVersion: 5, recordedChunks: 5, phase: "recording",
        continuation: { continuous: true, prepared: true }, lease: { generation: 2 } });
      const saved = (await f.options.queueStorage.listMetadata()).filter(record => record.state === "encrypted");
      expect(saved.map(record => record.reservation.sequenceNumber)).toEqual([0, 1, 2, 3, 4]);
      await view.controller.stopRecording();
      expect(view.controller.snapshot).toMatchObject({ state: "processing", desktop: { coverage: "complete" } });
      expect(f.complete.mock.calls[0]![1]).toMatchObject({ capture_lease_generation: 2,
        channels: [{ channel: "mixed", final_sequence_number: 5 }] });
      expect(mount).toHaveBeenCalledTimes(1); expect(f.selectWindow).toHaveBeenCalledTimes(1);
      expect(f.authority).toHaveBeenCalledTimes(1); expect(f.options.retireSource).toHaveBeenCalledTimes(1);
      expect(f.indicator.current()?.visible).toBe(false);
    } finally { await view.deactivate(); await w.boundary.dispose(); await f.close(); }
  });
  it("continues through renderer commands with fresh ownership and durable interval coverage", async () => {
    const f = await fixture(); let boundary: DesktopProviderRecorderIpc | undefined;
    try {
      const mount = vi.fn(f.options.authorizeMount), recorder = await f.open({ authorizeMount: mount });
      const w = wire(recorder); boundary = w.boundary;
      const view = await connectDesktopRecorderView(w.port, f.session.id, f.abort.signal);
      await view.controller.startRecording();
      await vi.waitFor(() => expect(view.controller.snapshot.recordedChunks).toBeGreaterThanOrEqual(2));
      await view.controller.pauseRecording!();
      expect(f.indicator.current()?.visible).toBe(false); expect(f.complete).not.toHaveBeenCalled();
      const before = view.controller.snapshot.recordedChunks;
      const retained = await f.options.queueStorage.list();
      const key = await f.options.flowStore.getSessionKeyState(f.session.id);
      await view.controller.resumeRecording!();
      expect(mount).toHaveBeenCalledTimes(2); expect(f.authority).toHaveBeenCalledTimes(2);
      expect(mount.mock.calls[1]![0]).toMatchObject({ firstSequenceNumber: before, captureLeaseGeneration: 2 });
      expect(f.selectWindow).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(view.controller.snapshot.recordedChunks).toBeGreaterThan(before));
      expect(await f.options.flowStore.getSessionKeyState(f.session.id)).toEqual(key);
      for (const row of retained.filter(row => row.state !== "reserved")) {
        expect(await f.options.queueStorage.get(row.reservation.objectId)).toEqual(row);
      }
      await view.controller.stopRecording();
      expect(view.controller.snapshot).toMatchObject({ state: "processing", desktop: { coverage: "incomplete" } });
      expect(f.complete).toHaveBeenCalledTimes(1);
      expect(f.complete.mock.calls[0]![1]).toMatchObject({ capture_lease_generation: 2,
        channels: [{ channel: "mixed", final_sequence_number: view.controller.snapshot.recordedChunks - 1 }] });
      expect(JSON.stringify(w.messages)).not.toMatch(/invented-start-capability|wrappedDek|pcmBytes|windowID/u);
    } finally { await boundary?.dispose(); await f.close(); }
  });

  it("routes view Start/Stop through real native capture, clears indicator before slow upload, and rejects foreign commands", async () => {
    const f = await fixture(), upload = deferred<void>(), entered = deferred<void>();
    let boundary: DesktopProviderRecorderIpc | undefined;
    try {
      const recorder = await f.open({ uploadTarget: { putCompleteEnvelope: async (...args) => {
        entered.resolve(); await upload.promise; return f.options.uploadTarget.putCompleteEnvelope(...args);
      } } });
      const w = wire(recorder); boundary = w.boundary;
      const view = await connectDesktopRecorderView(w.port, f.session.id, f.abort.signal);
      expect(f.selectWindow).not.toHaveBeenCalled();
      const starting = view.controller.startRecording();
      expect(view.controller.snapshot.desktop?.phase).toBe("starting");
      await starting;
      expect(view.controller.snapshot.desktop?.phase).toBe("recording");
      await vi.waitFor(() => expect(view.controller.snapshot.recordedChunks).toBeGreaterThanOrEqual(2));
      const stopping = view.controller.stopRecording(); await entered.promise;
      expect(f.indicator.current()).toMatchObject({ visible: false });
      expect(view.controller.snapshot.state).toBe("uploading"); expect(view.controller.snapshot.desktop?.phase).toBe("stopped");
      expect(f.complete).not.toHaveBeenCalled(); upload.resolve(); await stopping;
      expect(view.controller.snapshot.state).toBe("processing"); expect(view.controller.snapshot.desktop?.coverage).toBe("complete");
      expect(f.complete).toHaveBeenCalledTimes(1);
      expect(f.complete.mock.calls[0]![1].channels).toEqual([{ channel: "mixed", final_sequence_number: 2 }]);
      const latest = parseDesktopRecorderState(w.messages.at(-1));
      const request = { kind: "start", requestId: crypto.randomUUID(), recorderId: latest.recorderId };
      await expect(w.invoke({ ...request, credential: "forbidden" })).rejects.toThrow();
      await expect(w.invoke({ ...request, recorderId: crypto.randomUUID() })).rejects.toThrow();
      await expect(w.invoke(request, { ...w.event, senderFrame: { url: "app://cosmas/frame" } })).rejects.toThrow();
      await expect(w.invoke(request, { sender: { id: 99, mainFrame: w.event.sender.mainFrame }, senderFrame: w.event.senderFrame })).rejects.toThrow();
      expect(JSON.stringify(w.messages)).not.toMatch(/invented-start-capability|helperPath|wrappedDek|pcmBytes|windowID/u);
      await view.releaseUploadedCapture(); expect(await f.options.flowStore.getActiveCaptureState()).toBeNull();
      await view.deactivate(); expect(f.release).toHaveBeenCalledTimes(1);
    } finally { upload.resolve(); await boundary?.dispose(); await f.close(); }
  });

  it("retains the exact native handle and warning until a failed stop is explicitly retried", async () => {
    const f = await fixture(); let refuse = true;
    // The wrapper below deliberately supplies each actual driver as the receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const start = NativeProcessPCMDriver.prototype.start;
    const starting = vi.spyOn(NativeProcessPCMDriver.prototype, "start").mockImplementation(function (this: NativeProcessPCMDriver, configuration, sink) {
      const handle = start.call(this, configuration, sink);
      return { ready: handle.ready, activate: () => handle.activate(), stop: options => {
        if (refuse) return Promise.reject(new Error("invented unconfirmed OS stop"));
        return handle.stop(options);
      } };
    });
    try {
      const recorder = await f.open(); await recorder.startRecording();
      await vi.waitFor(() => expect(recorder.snapshot.recordedChunks).toBeGreaterThanOrEqual(2));
      await expect(recorder.stopRecording()).rejects.toThrow();
      expect(recorder.snapshot.desktop?.phase).toBe("stop_unconfirmed");
      expect(f.indicator.current()).toMatchObject({ visible: true, phase: "failed" });
      expect(f.complete).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
      refuse = false; await recorder.stopRecording();
      expect(starting).toHaveBeenCalledTimes(1); expect(f.indicator.current()).toMatchObject({ visible: false });
      expect(recorder.snapshot.state).toBe("processing"); expect(recorder.snapshot.desktop?.coverage).toBe("incomplete");
      expect(f.complete).toHaveBeenCalledTimes(1);
    } finally { refuse = false; await f.close(); starting.mockRestore(); }
  });

  it("cancels a pending window selection without late native startup or upload", async () => {
    const f = await fixture(), chosen = deferred<void>(), selecting = deferred<void>();
    try {
      const recorder = await f.open({ selectWindow: async () => {
        selecting.resolve(); await chosen.promise; return { application: "com.google.Chrome", processID: 1, windowID: 1 };
      } });
      const states: string[] = []; recorder.subscribe(value => { states.push(value.desktop!.phase); });
      const starting = recorder.startRecording(); const rejected = expect(starting).rejects.toThrow();
      await selecting.promise;
      const stopping = recorder.stopRecording(); await rejected;
      await stopping.catch(() => undefined); chosen.resolve();
      await recorder.deactivate();
      expect(states).not.toContain("recording"); expect(f.complete).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledTimes(1); expect(f.indicator.current()).toMatchObject({ visible: false });
    } finally { chosen.resolve(); await f.close(); }
  });

  it("revokes a running view, retains encrypted work, and reopens paused without starting another helper", async () => {
    const f = await fixture();
    try {
      const recorder = await f.open(), w = wire(recorder);
      const view = await connectDesktopRecorderView(w.port, f.session.id, f.abort.signal);
      await view.controller.startRecording();
      await vi.waitFor(() => expect(recorder.snapshot.recordedChunks).toBeGreaterThanOrEqual(2));
      f.abort.abort();
      expect(() => view.controller.snapshot).toThrow();
      await recorder.deactivate(); await w.boundary.dispose();
      expect(f.complete).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(1);
      const resources = await f.reopen(); expect((await resources.flowStore.getActiveCaptureState())?.phase).toBe("paused");
      const fresh = new AbortController();
      const reopened = await f.open({ ...resources, signal: fresh.signal,
        native: { ...f.options.native, isSessionActive: () => true },
        authorizePreparation: async () => ({ sessionId: f.session.id, status: "capturing" }) });
      expect(reopened.snapshot.state).toBe("paused"); expect(reopened.snapshot.desktop?.coverage).toBe("incomplete");
      expect(f.selectWindow).toHaveBeenCalledTimes(1);
      await reopened.stopRecording(); expect(f.complete).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });

  it("refuses disabled startup and a changed backend session before native acquisition", async () => {
    const f = await fixture();
    try {
      await expect(f.open({ enabled: false })).rejects.toThrow();
      expect(f.release).not.toHaveBeenCalled();
      const recorder = await f.open({ authorizeMount: async (prepared, signal) => {
        const value = await f.options.authorizeMount(prepared, signal); return { ...value, grant: { ...value.grant as object, captureSessionId: crypto.randomUUID() } };
      } });
      await expect(recorder.startRecording()).rejects.toThrow();
      expect(f.selectWindow).toHaveBeenCalledTimes(1); expect(f.authority).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});
describe("window choice before server start authority", () => {
  it("waits for deliberate choice without requesting authority or starting native I/O", async () => {
    const f = await fixture(true), choosing = deferred(), chosen = deferred();
    const selection = vi.fn(async () => {
      choosing.resolve(); await chosen.promise;
      return { application: "com.google.Chrome" as const, processID: 1, windowID: 1 };
    });
    try {
      const recorder = await f.open({ selectWindow: selection });
      const starting = recorder.startRecording(), rejected = expect(starting).rejects.toThrow();
      await choosing.promise;
      expect(recorder.snapshot).toMatchObject({ statusCode: "capture_window_selection_pending",
        recordedChunks: 0, desktop: { phase: "starting", coverage: "not_started" } });
      expect(f.authority).not.toHaveBeenCalled();
      expect(f.nativeStart).not.toHaveBeenCalled();
      expect(f.indicator.current()?.visible).not.toBe(true);
      chosen.resolve(); await rejected; // Stub rejects only when native start is finally attempted.
      expect(recorder.snapshot.statusCode).not.toBe("capture_window_selection_pending");
      expect(f.authority).toHaveBeenCalledTimes(1);
      expect(f.nativeStart).toHaveBeenCalledTimes(1);
      expect(selection).toHaveBeenCalledTimes(1);
    } finally { chosen.resolve(); await f.close(); }
  });

  it("cancels a pending choice without waiting for its late result or spending start authority", async () => {
    const f = await fixture(true), choosing = deferred(), chosen = deferred();
    try {
      const recorder = await f.open({ selectWindow: async () => {
        choosing.resolve(); await chosen.promise;
        return { application: "com.google.Chrome", processID: 1, windowID: 1 };
      } });
      const starting = recorder.startRecording(), rejected = expect(starting).rejects.toThrow();
      await choosing.promise;
      await recorder.stopRecording(); await rejected;
      expect(f.authority).not.toHaveBeenCalled();
      chosen.resolve(); await Promise.resolve();
      expect(f.nativeStart).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.indicator.current()).toMatchObject({ visible: false });
    } finally { chosen.resolve(); await f.close(); }
  });

  it("reauthorizes after the choice and rejects a revoked grant before native I/O", async () => {
    const f = await fixture(true), choosing = deferred(), chosen = deferred();
    let revoked = false;
    const authority = vi.fn(async () => {
      expect(revoked).toBe(true);
      return { schemaVersion: 1, decision: "denied", denialCode: "revoked" };
    });
    try {
      const recorder = await f.open({ authority: { authorizeStart: authority }, selectWindow: async () => {
        choosing.resolve(); await chosen.promise;
        return { application: "com.google.Chrome", processID: 1, windowID: 1 };
      } });
      const starting = recorder.startRecording(), rejected = expect(starting).rejects.toThrow();
      await choosing.promise; expect(authority).not.toHaveBeenCalled();
      revoked = true; chosen.resolve(); await rejected;
      expect(authority).toHaveBeenCalledTimes(1);
      expect(f.nativeStart).not.toHaveBeenCalled();
      expect(f.indicator.current()?.visible).not.toBe(true);
    } finally { chosen.resolve(); await f.close(); }
  });

  it("does not accept a late choice after owner revocation", async () => {
    const f = await fixture(true), choosing = deferred(), chosen = deferred();
    try {
      const recorder = await f.open({ selectWindow: async () => {
        choosing.resolve(); await chosen.promise;
        return { application: "com.google.Chrome", processID: 1, windowID: 1 };
      } });
      const starting = recorder.startRecording(), rejected = expect(starting).rejects.toThrow();
      await choosing.promise; f.abort.abort(); await rejected;
      await recorder.deactivate(); chosen.resolve(); await Promise.resolve();
      expect(f.authority).not.toHaveBeenCalled();
      expect(f.nativeStart).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledTimes(1);
    } finally { chosen.resolve(); await f.close(); }
  });
});

it.skipIf(!helperPath)("connects a delayed window choice to fresh source ownership, native chunks and one upload", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = await fixture(), choosing = deferred(), chosen = deferred();
  let preparedAt: number | null = null;
  const mount = vi.fn(async (prepared: PreparedDesktopCapture, signal: AbortSignal) => {
    preparedAt = Date.now();
    return f.options.authorizeMount(prepared, signal);
  });
  const authorizeStart = vi.fn(async () => {
    if (preparedAt === null || Date.now() - preparedAt >= 120_000) throw new Error("source preparation expired");
    return f.authority();
  });
  const retireSource = vi.fn(async () => {
    expect(f.indicator.current()?.visible).toBe(false);
    expect(f.complete).not.toHaveBeenCalled();
  });
  try {
    const recorder = await f.open({ authorizeMount: mount, authority: { authorizeStart }, retireSource,
      selectWindow: async () => {
        choosing.resolve(); await chosen.promise;
        return { application: "com.google.Chrome", processID: 1, windowID: 1 };
      } });
    const starting = recorder.startRecording();
    await choosing.promise;
    vi.setSystemTime(Date.now() + 121_000);
    chosen.resolve(); await starting;
    expect(recorder.snapshot.desktop?.phase).toBe("recording");
    await vi.waitFor(() => expect(recorder.snapshot.recordedChunks).toBeGreaterThanOrEqual(2));
    await recorder.stopRecording();
    expect(recorder.snapshot.state).toBe("processing");
    expect(recorder.snapshot.desktop?.coverage).toBe("complete");
    expect(mount).toHaveBeenCalledTimes(1); expect(authorizeStart).toHaveBeenCalledTimes(1);
    expect(retireSource).toHaveBeenCalledTimes(1); expect(f.complete).toHaveBeenCalledTimes(1);
    retireSource.mockResolvedValue(undefined);
  } finally { chosen.resolve(); retireSource.mockResolvedValue(undefined); await f.close(); vi.useRealTimers(); }
});

it.skipIf(!helperPath)("retains paused desktop capture and encrypted chunks until a lost server stop reply is retried", async () => {
  const f = await fixture();
  const nativeStart = vi.spyOn(NativeProcessPCMDriver.prototype, "start");
  const upload = vi.spyOn(f.options.uploadTarget, "putCompleteEnvelope");
  const retireSource = vi.fn(async () => undefined)
    .mockRejectedValueOnce(new Error("invented lost server stop reply"));
  let boundary: DesktopProviderRecorderIpc | undefined;
  try {
    const recorder = await f.open({ retireSource }), w = wire(recorder); boundary = w.boundary;
    const view = await connectDesktopRecorderView(w.port, f.session.id, f.abort.signal);
    await view.controller.startRecording();
    await vi.waitFor(() => expect(view.controller.snapshot.recordedChunks).toBeGreaterThanOrEqual(2));
    await expect(view.controller.stopRecording()).rejects.toThrow();
    expect(f.indicator.current()?.visible).toBe(false);
    expect(view.controller.snapshot).toMatchObject({ state: "paused", statusCode: "capture_stop_acknowledgement_pending",
      desktop: { phase: "interrupted", coverage: "complete" } });
    expect((await f.options.flowStore.getActiveCaptureState())?.phase).toBe("paused");
    const encrypted = (await f.options.queueStorage.list()).filter(chunk => chunk.state === "encrypted");
    expect(encrypted.length).toBeGreaterThanOrEqual(2);
    expect(upload).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
    await expect(view.controller.startRecording()).rejects.toThrow();
    await view.controller.stopRecording();
    expect(view.controller.snapshot.state).toBe("processing");
    expect(view.controller.snapshot.statusCode).not.toBe("capture_stop_acknowledgement_pending");
    expect(upload).toHaveBeenCalledTimes(encrypted.length); expect(f.complete).toHaveBeenCalledTimes(1);
    expect(retireSource).toHaveBeenCalledTimes(2); expect(nativeStart).toHaveBeenCalledTimes(1);
    expect(f.authority).toHaveBeenCalledTimes(1);
  } finally { await boundary?.dispose(); await f.close(); nativeStart.mockRestore(); }
});

describe("prepared desktop start", () => {
  it("requests recording permissions only on explicit setup without starting or replacing the prepared lease", async () => {
    const f = await fixture(true), issue = vi.spyOn(f.options.createBff(f.abort.signal), "issueLease");
    f.nativeAvailability!.mockResolvedValue(false);
    const request = vi.spyOn(NativeProcessPCMDriver.prototype, "requestPermissions").mockImplementation(async signal => {
      expect(signal.aborted).toBe(false); f.nativeAvailability!.mockResolvedValue(true); return true;
    });
    try {
      const recorder = await f.open();
      expect(recorder.snapshot.desktop?.phase).toBe("permission_required");
      expect(request).not.toHaveBeenCalled();
      const prepared = await f.options.flowStore.getActiveCaptureState();
      const leaseCalls = issue.mock.calls.length;
      await recorder.refreshPermissions();
      expect(recorder.snapshot.desktop?.phase).toBe("ready");
      expect(request).toHaveBeenCalledTimes(1);
      expect(issue).toHaveBeenCalledTimes(leaseCalls);
      expect(await f.options.flowStore.getActiveCaptureState()).toEqual(prepared);
      expect(f.selectWindow).not.toHaveBeenCalled();
      expect(f.authority).not.toHaveBeenCalled();
      expect(f.nativeStart).not.toHaveBeenCalled();
    } finally { request.mockRestore(); await f.close(); }
  });
  it("checks current Core session before lease work and sends saved receipts only after window choice", async () => {
    const f = await fixture(true), bff = f.options.createBff(f.abort.signal);
    const issue = vi.spyOn(bff, "issueLease");
    const preflight = vi.fn(async () => {
      expect(await f.options.flowStore.getActiveCaptureState()).toBeNull();
      expect(await f.options.flowStore.getPreparationState()).toBeNull();
      return { sessionId: f.session.id, status: "created" as const };
    });
    const mount = vi.fn(async (prepared: PreparedDesktopCapture, signal: AbortSignal) => {
      const active = (await f.options.flowStore.getActiveCaptureState())!;
      expect(active.phase).toBe("ready"); expect(active.captureAuthorizedUntil).not.toBeNull();
      expect(prepared).toEqual({ sessionId: f.session.id, captureLeaseId: active.lease.lease_id,
        leaseReceiptId: active.lease.receipt_id, captureLeaseGeneration: active.lease.generation,
        captureAuthorizedUntil: active.captureAuthorizedUntil });
      expect(Object.isFrozen(prepared)).toBe(true);
      return f.options.authorizeMount(prepared, signal);
    });
    try {
      const recorder = await f.open({ authorizePreparation: preflight, authorizeMount: mount });
      expect(recorder.snapshot.desktop?.phase).toBe("ready");
      expect(preflight).toHaveBeenCalledBefore(issue); expect(mount).not.toHaveBeenCalled();
      expect(f.authority).not.toHaveBeenCalled(); expect(f.selectWindow).not.toHaveBeenCalled();
      expect(f.nativeStart).not.toHaveBeenCalled();
      await expect(recorder.startRecording()).rejects.toThrow(); // The native-I/O stub rejects.
      expect(issue).toHaveBeenCalledBefore(mount); expect(f.selectWindow).toHaveBeenCalledBefore(mount);
      expect(mount).toHaveBeenCalledBefore(f.authority); expect(f.nativeStart).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });
  it("rejects revoked preflight before writing preparation, binding a key or issuing a lease", async () => {
    const f = await fixture(true), bff = f.options.createBff(f.abort.signal);
    const preparation = vi.spyOn(f.options.flowStore, "putPreparationState");
    const bind = vi.spyOn(bff, "bindSessionAudioKey"), issue = vi.spyOn(bff, "issueLease");
    const mount = vi.fn(f.options.authorizeMount);
    try {
      await expect(f.open({ authorizePreparation: async () => { throw new Error("invented revocation"); }, authorizeMount: mount })).rejects.toThrow();
      expect(preparation).not.toHaveBeenCalled(); expect(bind).not.toHaveBeenCalled(); expect(issue).not.toHaveBeenCalled();
      expect(mount).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it("rejects a changed session in preflight before lease work", async () => {
    const f = await fixture(true), issue = vi.spyOn(f.options.createBff(f.abort.signal), "issueLease");
    try {
      await expect(f.open({ authorizePreparation: async () => ({ sessionId: crypto.randomUUID(), status: "created" }) })).rejects.toThrow();
      expect(issue).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it("retains and reuses the same lease after a lost grant reply instead of issuing another lease", async () => {
    const f = await fixture(true), issue = vi.spyOn(f.options.createBff(f.abort.signal), "issueLease");
    let prepared!: PreparedDesktopCapture;
    try {
      const first = await f.open({ authorizeMount: async value => {
        prepared = value; throw new Error("invented lost grant reply");
      } });
      await expect(first.startRecording()).rejects.toThrow("invented lost grant reply");
      expect(issue).toHaveBeenCalledTimes(1);
      await first.deactivate();
      const resources = await f.reopen();
      const retried = vi.fn(async (value: PreparedDesktopCapture, signal: AbortSignal) => {
        expect(value).toEqual(prepared); return f.options.authorizeMount(value, signal);
      });
      const recorder = await f.open({ ...resources, authorizeMount: retried });
      expect(recorder.snapshot.desktop?.phase).toBe("ready"); expect(retried).not.toHaveBeenCalled();
      expect(issue).toHaveBeenCalledTimes(1); expect(f.nativeStart).not.toHaveBeenCalled();
      expect(f.authority).not.toHaveBeenCalled();
      await expect(recorder.startRecording()).rejects.toThrow();
      expect(retried).toHaveBeenCalledTimes(1); expect(issue).toHaveBeenCalledTimes(1);
      expect(f.nativeStart).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });
  it.each(["generation", "deadline"])("rejects changed %s while the backend grant is pending", async field => {
    const f = await fixture(true);
    try {
      const recorder = await f.open({ authorizeMount: async (prepared, signal) => {
        const active = (await f.options.flowStore.getActiveCaptureState())!;
        await f.options.flowStore.putActiveCaptureState(field === "generation"
          ? { ...active, lease: { ...active.lease, generation: active.lease.generation + 1 } }
          : { ...active, captureAuthorizedUntil: new Date(Date.parse(active.captureAuthorizedUntil!) - 1_000).toISOString() });
        return f.options.authorizeMount(prepared, signal);
      } });
      await expect(recorder.startRecording()).rejects.toThrow();
      expect(f.nativeAvailability).toHaveBeenCalledTimes(1);
      expect(f.nativeStart).not.toHaveBeenCalled(); expect(f.authority).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it("restores confirmed-upload metadata without requesting a new grant or native availability", async () => {
    const f = await fixture(true);
    try {
      const first = await f.open(), active = (await f.options.flowStore.getActiveCaptureState())!;
      // Invented persisted upload receipt state; no physical/audio trial is run.
      await f.options.flowStore.putActiveCaptureState({ ...active, phase: "processing", recordedChunks: 1 });
      await first.deactivate();
      const resources = await f.reopen(), mount = vi.fn(f.options.authorizeMount);
      f.nativeAvailability!.mockClear();
      const restored = await f.open({ ...resources, authorizePreparation: async () => ({ sessionId: f.session.id, status: "processing" }), authorizeMount: mount });
      expect(restored.snapshot.state).toBe("processing"); expect(mount).not.toHaveBeenCalled();
      expect(f.nativeAvailability).not.toHaveBeenCalled();
      expect(f.nativeStart).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it.each(["capturing", "processing"] as const)("does not initialize fresh capture storage for existing %s work", async status => {
    const f = await fixture(true), issue = vi.spyOn(f.options.createBff(f.abort.signal), "issueLease");
    try {
      await expect(f.open({ authorizePreparation: async () => ({ sessionId: f.session.id, status }) })).rejects.toThrow();
      expect(issue).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it("rejects a changed backend capture status after preparation and before native acquisition", async () => {
    const f = await fixture(true);
    try {
      const recorder = await f.open({ authorizeMount: async (prepared, signal) => ({
        ...await f.options.authorizeMount(prepared, signal), status: "capturing",
      }) });
      await expect(recorder.startRecording()).rejects.toThrow();
      expect(f.nativeAvailability).toHaveBeenCalledTimes(1); expect(f.nativeStart).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("refreshes native permission availability without reserving source ownership", async () => {
    const f = await fixture(true), mount = vi.fn(f.options.authorizeMount);
    try {
      f.nativeAvailability!.mockResolvedValue(false);
      const recorder = await f.open({ authorizeMount: mount });
      expect(recorder.snapshot.desktop?.phase).toBe("permission_required");
      expect(mount).not.toHaveBeenCalled(); expect(f.selectWindow).not.toHaveBeenCalled();
      f.nativeAvailability!.mockResolvedValue(true); await recorder.refreshPermissions();
      expect(recorder.snapshot.desktop?.phase).toBe("ready"); expect(mount).not.toHaveBeenCalled();
      await expect(recorder.startRecording()).rejects.toThrow();
      expect(mount).toHaveBeenCalledTimes(1); expect(f.nativeStart).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });

  it("retires preparation when permissions change after window choice and takes a fresh preparation on retry", async () => {
    const f = await fixture(true), mount = vi.fn(f.options.authorizeMount);
    const retireSource = vi.fn(async () => { expect(f.nativeStart).not.toHaveBeenCalled(); });
    try {
      const recorder = await f.open({ authorizeMount: mount, retireSource });
      const link = wire(recorder), view = await connectDesktopRecorderView(link.port, f.session.id, f.abort.signal);
      f.nativeAvailability!.mockResolvedValue(false);
      await view.controller.startRecording();
      expect(view.controller.snapshot.state).toBe("ready");
      expect(view.controller.snapshot.desktop?.phase).toBe("permission_required");
      expect(retireSource).toHaveBeenCalledTimes(1); expect(f.authority).not.toHaveBeenCalled();
      expect(f.nativeStart).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
      f.nativeAvailability!.mockResolvedValue(true);
      await view.controller.refreshPermissions!();
      expect(view.controller.snapshot.desktop?.phase).toBe("ready"); expect(mount).toHaveBeenCalledTimes(1);
      retireSource.mockImplementation(async () => undefined);
      await expect(view.controller.startRecording()).rejects.toThrow(); // Deliberate native-I/O exclusion.
      expect(mount).toHaveBeenCalledTimes(2); expect(f.selectWindow).toHaveBeenCalledTimes(2);
      expect(f.authority).toHaveBeenCalledTimes(1); expect(f.nativeStart).toHaveBeenCalledTimes(1);
      await view.deactivate(); await link.boundary.dispose();
    } finally { await f.close(); }
  });

  it("keeps permission recovery blocked until the unused preparation retirement is confirmed", async () => {
    const f = await fixture(true), mount = vi.fn(f.options.authorizeMount);
    const retireSource = vi.fn(async (): Promise<void> => { throw new Error("fixture retirement reply unavailable"); });
    try {
      const recorder = await f.open({ authorizeMount: mount, retireSource });
      f.nativeAvailability!.mockResolvedValue(false);
      await expect(recorder.startRecording()).rejects.toThrow();
      expect(recorder.snapshot.desktop?.phase).toBe("permission_required");
      f.nativeAvailability!.mockResolvedValue(true);
      await expect(recorder.refreshPermissions()).rejects.toThrow();
      await expect(recorder.startRecording()).rejects.toThrow();
      expect(mount).toHaveBeenCalledTimes(1); expect(f.authority).not.toHaveBeenCalled();
      expect(f.nativeStart).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
      retireSource.mockImplementation(async () => undefined);
      await recorder.refreshPermissions();
      expect(recorder.snapshot.desktop?.phase).toBe("ready"); expect(mount).toHaveBeenCalledTimes(1);
    } finally { retireSource.mockImplementation(async () => undefined); await f.close(); }
  });

  it("waits for a pending preparation on Stop, then retires it without native start", async () => {
    const f = await fixture(true), entered = deferred(), reply = deferred();
    const retireSource = vi.fn(async () => undefined);
    try {
      const recorder = await f.open({ retireSource, authorizeMount: async (prepared, signal) => {
        entered.resolve(); await reply.promise;
        expect(signal.aborted).toBe(false);
        return f.options.authorizeMount(prepared, signal);
      } });
      const starting = recorder.startRecording(), rejected = expect(starting).rejects.toThrow();
      await entered.promise; const stopping = recorder.stopRecording();
      expect(retireSource).not.toHaveBeenCalled(); expect(f.authority).not.toHaveBeenCalled();
      reply.resolve(); await stopping; await rejected;
      expect(retireSource).toHaveBeenCalledTimes(1);
      expect(f.nativeStart).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
    } finally { reply.resolve(); await f.close(); }
  });
});

describe("cancelled preparation recovery", () => {
  it("returns the IPC view to ready after cancelling a choice and requires a fresh choice", async () => {
    const f = await fixture(true), choosing = deferred(), chosen = deferred();
    const mount = vi.fn(f.options.authorizeMount);
    const selection = vi.fn().mockImplementationOnce(async () => {
      choosing.resolve(); await chosen.promise;
      return { application: "com.google.Chrome", processID: 1, windowID: 1 };
    }).mockImplementation(f.options.selectWindow);
    try {
      const recorder = await f.open({ selectWindow: selection, authorizeMount: mount });
      const link = wire(recorder), view = await connectDesktopRecorderView(link.port, f.session.id, f.abort.signal);
      const before = await f.options.flowStore.getActiveCaptureState();
      const starting = view.controller.startRecording(), rejected = expect(starting).rejects.toThrow();
      await choosing.promise;
      await view.controller.stopRecording(); await rejected;
      expect(view.controller.snapshot).toMatchObject({ state: "ready", recordedChunks: 0, desktop: { phase: "ready" } });
      expect(await f.options.flowStore.getActiveCaptureState()).toEqual(before);
      expect(mount).not.toHaveBeenCalled(); expect(f.authority).not.toHaveBeenCalled();
      chosen.resolve(); await Promise.resolve();
      expect(f.nativeStart).not.toHaveBeenCalled();
      await expect(view.controller.startRecording()).rejects.toThrow(); // Native I/O is deliberately stubbed.
      expect(selection).toHaveBeenCalledTimes(2); expect(mount).toHaveBeenCalledTimes(1);
      expect(f.authority).toHaveBeenCalledTimes(1); expect(f.nativeStart).toHaveBeenCalledTimes(1);
      expect(f.complete).not.toHaveBeenCalled();
      await view.deactivate(); await link.boundary.dispose();
    } finally { chosen.resolve(); await f.close(); }
  });

  it("retains expired authority after cancellation instead of obtaining a new lease", async () => {
    const f = await fixture(true), choosing = deferred(), chosen = deferred();
    try {
      const recorder = await f.open({ selectWindow: async () => {
        choosing.resolve(); await chosen.promise;
        return { application: "com.google.Chrome", processID: 1, windowID: 1 };
      } });
      const before = await f.options.flowStore.getActiveCaptureState();
      const issue = vi.spyOn(f.options.createBff(f.abort.signal), "issueLease");
      const starting = recorder.startRecording(), rejected = expect(starting).rejects.toThrow();
      await choosing.promise;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.parse(before!.lease.expires_at) + 1_000);
      await recorder.stopRecording(); await rejected;
      expect(recorder.snapshot).toMatchObject({ state: "paused", statusCode: "capture_setup_expired",
        recordedChunks: 0, desktop: { phase: "interrupted", coverage: "not_started" } });
      expect((await f.options.flowStore.getActiveCaptureState())!.lease).toEqual(before!.lease);
      await expect(recorder.startRecording()).rejects.toThrow();
      expect(issue).not.toHaveBeenCalled(); expect(f.authority).not.toHaveBeenCalled();
      expect(f.nativeStart).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); chosen.resolve(); await f.close(); }
  });

  it("requires confirmed retirement after a cancelled preparation before taking another owner", async () => {
    const f = await fixture(true), entered = deferred(), reply = deferred();
    const mount = vi.fn(f.options.authorizeMount).mockImplementationOnce(async (prepared, signal) => {
      entered.resolve(); await reply.promise; return f.options.authorizeMount(prepared, signal);
    });
    const retireSource = vi.fn(async (): Promise<void> => undefined)
      .mockRejectedValueOnce(new Error("fixture lost retirement reply"));
    try {
      const recorder = await f.open({ authorizeMount: mount, retireSource });
      const starting = recorder.startRecording(), rejected = expect(starting).rejects.toThrow();
      await entered.promise;
      const stopping = recorder.stopRecording(), stopRejected = expect(stopping).rejects.toThrow();
      reply.resolve(); await rejected; await stopRejected;
      expect(recorder.snapshot.statusCode).toBe("capture_stop_acknowledgement_pending");
      await expect(recorder.startRecording()).rejects.toThrow();
      expect(mount).toHaveBeenCalledTimes(1); expect(f.authority).not.toHaveBeenCalled();
      expect(f.nativeStart).not.toHaveBeenCalled();
      await recorder.stopRecording();
      expect(retireSource).toHaveBeenCalledTimes(2);
      expect(recorder.snapshot).toMatchObject({ state: "ready", desktop: { phase: "ready" } });
      await expect(recorder.startRecording()).rejects.toThrow();
      expect(mount).toHaveBeenCalledTimes(2); expect(f.authority).toHaveBeenCalledTimes(1);
      expect(f.nativeStart).toHaveBeenCalledTimes(1); expect(f.complete).not.toHaveBeenCalled();
    } finally { reply.resolve(); await f.close(); }
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}

it("retains desktop custody through unconfirmed native stop and lost server stop acknowledgement", async () => {
  const f = await fixture(true);
  const retireSource = vi.fn(async () => undefined);
  const stopped = vi.spyOn(DesktopPcmCaptureSource.prototype, "stop");
  try {
    const recorder = await f.open({ retireSource });
    stopped.mockRejectedValue(new Error("unconfirmed native stop"));
    await expect(recorder.deactivate()).rejects.toThrow();
    expect(retireSource).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
    stopped.mockResolvedValue(undefined);
    retireSource.mockRejectedValueOnce(new Error("lost server stop reply"));
    await expect(recorder.deactivate()).rejects.toThrow("lost server stop reply");
    expect(f.release).not.toHaveBeenCalled();
    await recorder.deactivate();
    expect(retireSource).toHaveBeenCalledTimes(2); expect(f.release).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledBefore(retireSource);
    expect(f.nativeStart).not.toHaveBeenCalled();
  } finally { stopped.mockResolvedValue(undefined); await f.close(); stopped.mockRestore(); }
});
