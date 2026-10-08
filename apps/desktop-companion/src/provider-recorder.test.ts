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
import type { PrepareRecordingWindowRequest } from "../../capture/src/bff/contracts";
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
import { CoreCaptureClient } from "../../capture/src/provider/core-client";
import { DesktopPreparationBff } from "./preparation-metadata.js";

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
      // Synthetic BFF budgets must not depend on the developer Mac's free disk.
      // Dedicated capacity tests below supply their own low/unknown readings.
      storageCapacity: { availableBytes: async () => 10_000_000_000 },
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

describe("desktop preparation screen", () => {
  it.each(["success", "revoked", "cancelled"] as const)("joins parallel preparation reads before writes or release on %s", async outcome => {
    const f = await fixture(true), reviewReply = deferred(), keyReply = deferred();
    const baseline = f.options.createBff(f.abort.signal);
    const key = await baseline.getAudioEncryptionKey(), capabilities = await baseline.getCapabilities(f.session.id);
    const writes = vi.spyOn(f.options.flowStore, "putPreparationState");
    const candidate = vi.spyOn(f.options.flowStore, "putSessionKeyCandidate");
    const issue = vi.spyOn(baseline, "issueLease"), bind = vi.spyOn(baseline, "bindSessionAudioKey");
    const request = vi.fn(async (_path: string, body: Readonly<Record<string, unknown>>) => {
      const kind = (body.operation as { kind: string }).kind;
      if (kind === "creator_review") await reviewReply.promise;
      if (kind === "encryption_key") await keyReply.promise;
      if (kind === "creator_review" && outcome === "revoked") return new Response(null, { status: 403 });
      const receipt = kind === "creator_review" ? { schema_version: "1.0", session_id: f.session.id, status: "created", source: null,
        working: null, review_queue: null, translation_progress: [] } : kind === "encryption_key" ? key : capabilities;
      return Response.json({ contract_version: "1", workspace_id: workspaceId, binding_ref: body.binding_ref,
        request_nonce: body.request_nonce, checked_at: new Date().toISOString(), operation: kind, receipt });
    });
    const metadata = new DesktopPreparationBff(new CoreCaptureClient({ workspaceId,
      appointmentRef: "appointment_01j00000000000000000000000", bindingRef: "scribe_capture_binding_01j00000000000000000000000" }, request, f.abort.signal), f.session.id);
    vi.spyOn(baseline, "getAudioEncryptionKey").mockImplementation(options => metadata.getAudioEncryptionKey(options));
    vi.spyOn(baseline, "getCapabilities").mockImplementation((id, options) => metadata.getCapabilities(id, options));
    const recorder = await f.open({ prepareInBackground: true,
      authorizePreparation: () => metadata.authorizePreparation(true) });
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
      expect(recorder.snapshot.desktop?.phase).toBe("preparing");
      expect(writes).not.toHaveBeenCalled(); expect(candidate).not.toHaveBeenCalled();
      expect(issue).not.toHaveBeenCalled(); expect(bind).not.toHaveBeenCalled();
      expect(f.nativeAvailability).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
      let closed = false;
      const closing = outcome === "cancelled" ? recorder.deactivate().then(() => { closed = true; }) : null;
      reviewReply.resolve();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(writes).not.toHaveBeenCalled(); expect(closed).toBe(false); expect(f.release).not.toHaveBeenCalled();
      keyReply.resolve();
      if (outcome === "success") {
        await vi.waitFor(() => expect(recorder.snapshot.desktop?.phase).toBe("ready"));
        expect(candidate).toHaveBeenCalledOnce(); expect(issue).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledTimes(3); // Real flow consumes each one-use response.
      } else if (outcome === "revoked") {
        await vi.waitFor(() => expect(recorder.snapshot.desktop?.phase).toBe("stopped"));
        expect(writes).not.toHaveBeenCalled(); expect(candidate).not.toHaveBeenCalled();
        expect(issue).not.toHaveBeenCalled(); expect(bind).not.toHaveBeenCalled();
      } else {
        await closing; expect(closed).toBe(true); expect(f.release).toHaveBeenCalledOnce();
        expect(writes).not.toHaveBeenCalled(); expect(candidate).not.toHaveBeenCalled();
      }
      expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
    } finally { reviewReply.resolve(); keyReply.resolve(); await f.close(); }
  });
  it.each(["metadata", "discovery"] as const)("overlaps fresh meeting discovery and preparation, waiting for %s before enabling Start", async last => {
    const f = await fixture(true), metadataEntered = deferred(), discoveryEntered = deferred();
    const metadataReply = deferred(), discoveryReply = deferred();
    const bff = f.options.createBff(f.abort.signal), capabilities = await bff.getCapabilities(f.session.id);
    const preflight = vi.fn(f.options.authorizePreparation);
    vi.spyOn(bff, "getCapabilities").mockImplementation(async () => {
      metadataEntered.resolve(); await metadataReply.promise; return capabilities;
    });
    const list = vi.fn(async () => {
      expect(preflight).toHaveBeenCalledOnce(); discoveryEntered.resolve(); await discoveryReply.promise;
      return [{ application: "us.zoom.xos" as const, processID: 42, windowID: 74, title: "Synthetic visit" }];
    });
    const recorder = await f.open({ prepareInBackground: true, listMeetingWindows: list, authorizePreparation: preflight });
    try {
      await Promise.all([metadataEntered.promise, discoveryEntered.promise]);
      expect(recorder.snapshot.desktop?.phase).toBe("preparing");
      if (last === "metadata") {
        discoveryReply.resolve();
        await vi.waitFor(() => expect(recorder.snapshot.desktop?.meetingWindows?.windows).toHaveLength(1));
        await expect(recorder.selectMeetingWindow(recorder.snapshot.desktop!.meetingWindows!.windows[0]!.id)).rejects.toThrow();
      } else {
        metadataReply.resolve();
        await vi.waitFor(async () => expect((await f.options.flowStore.getActiveCaptureState())?.captureAuthorizedUntil).toBeTruthy());
      }
      expect(recorder.snapshot.desktop?.phase).toBe("preparing");
      await expect(recorder.startRecording()).rejects.toThrow();
      expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
      metadataReply.resolve(); discoveryReply.resolve();
      await vi.waitFor(() => expect(recorder.snapshot.desktop?.phase).toBe("ready"));
      expect(recorder.snapshot.desktop?.meetingWindows?.windows).toHaveLength(1);
      expect(list).toHaveBeenCalledOnce(); expect(f.selectWindow).not.toHaveBeenCalled();
    } finally { metadataReply.resolve(); discoveryReply.resolve(); await f.close(); }
  });
  it("joins pending discovery after preparation failure before releasing its encrypted owner", async () => {
    const f = await fixture(true), entered = deferred(), reply = deferred();
    const bff = f.options.createBff(f.abort.signal);
    vi.spyOn(bff, "getCapabilities").mockRejectedValue(new Error("Synthetic preparation failed"));
    const recorder = await f.open({ prepareInBackground: true, listMeetingWindows: async () => {
      entered.resolve(); await reply.promise; return [];
    } });
    try {
      await entered.promise;
      const closing = recorder.deactivate();
      expect(recorder.availableForView).toBe(false); expect(f.release).not.toHaveBeenCalled();
      reply.resolve(); await closing;
      expect(f.release).toHaveBeenCalledOnce(); expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
    } finally { reply.resolve(); await f.close(); }
  });
  it("keeps microphone preparation independent of meeting discovery", async () => {
    const f = await fixture(true), list = vi.fn(async () => []);
    try {
      const recorder = await f.open({ audioMode: "microphone", listMeetingWindows: list });
      expect(recorder.snapshot.desktop?.phase).toBe("ready"); expect(list).not.toHaveBeenCalled();
      expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it("keeps failed discovery retryable without treating it as recording preparation failure", async () => {
    const f = await fixture(true), list = vi.fn<NonNullable<DesktopProviderRecorderOptions["listMeetingWindows"]>>(async () => {
      throw new Error("Synthetic discovery unavailable");
    });
    try {
      const recorder = await f.open({ listMeetingWindows: list });
      expect(recorder.snapshot).toMatchObject({ state: "ready", desktop: { phase: "ready",
        meetingWindows: { state: "unavailable", selectedId: null, windows: [] } } });
      await expect(recorder.startRecording()).rejects.toThrow();
      expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
      list.mockResolvedValue([]);
      await recorder.refreshMeetingWindows();
      expect(recorder.snapshot.desktop?.meetingWindows?.state).toBe("ready");
      expect(list).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });
  it("exposes disabled preparation before fresh review finishes, then enables the same owned recorder", async () => {
    const f = await fixture(true), checked = deferred(), review = deferred();
    const list = vi.fn(async () => [{ application: "com.google.Chrome" as const, processID: 1, windowID: 1, title: "Invented visit" }]);
    const recorder = await f.open({ prepareInBackground: true, listMeetingWindows: list,
      authorizePreparation: async () => { checked.resolve(); await review.promise; return { sessionId: f.session.id, status: "created" }; } });
    const bridge = wire(recorder), view = await connectDesktopRecorderView(bridge.port, f.session.id, f.abort.signal);
    try {
      await checked.promise;
      expect(view.controller.snapshot).toMatchObject({ state: "preparing", statusCode: "capture_preparing", desktop: { phase: "preparing" } });
      expect(await f.options.flowStore.getActiveCaptureState()).toBeNull();
      await expect(view.controller.startRecording()).rejects.toThrow();
      await expect(view.controller.refreshPermissions!()).rejects.toThrow();
      expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
      review.resolve();
      await vi.waitFor(() => expect(view.controller.snapshot.desktop?.phase).toBe("ready"));
      expect(view.controller.snapshot.desktop?.meetingWindows?.windows).toHaveLength(1);
      expect(list).toHaveBeenCalledTimes(1); expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
    } finally { review.resolve(); await view.deactivate(); await bridge.boundary.dispose(); await f.close(); }
  });
  it("joins a late metadata branch before releasing custody after cancellation", async () => {
    const f = await fixture(true), entered = deferred(), reply = deferred();
    const bff = f.options.createBff(f.abort.signal), capabilities = await bff.getCapabilities(f.session.id);
    vi.spyOn(bff, "getCapabilities").mockImplementation(async () => { entered.resolve(); await reply.promise; return capabilities; });
    const recorder = await f.open({ prepareInBackground: true });
    try {
      await entered.promise;
      const close = recorder.deactivate();
      expect(recorder.availableForView).toBe(false); expect(f.release).not.toHaveBeenCalled();
      reply.resolve(); await close;
      expect(f.release).toHaveBeenCalledTimes(1); expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
    } finally { reply.resolve(); await f.close(); }
  });
  it("shows a fixed preparation failure and retains its encrypted owner until navigation", async () => {
    const f = await fixture(true), reply = deferred();
    const recorder = await f.open({ prepareInBackground: true,
      authorizePreparation: async () => { await reply.promise; throw new Error("Invented private backend failure"); } });
    try {
      reply.resolve();
      await vi.waitFor(() => expect(recorder.snapshot).toMatchObject({ state: "error", statusCode: "capture_preparation_failed", desktop: { phase: "stopped" } }));
      expect(recorder.availableForView).toBe(true); expect(f.release).not.toHaveBeenCalled();
      expect(() => recorder.startRecording()).toThrow(); expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
      await recorder.deactivate(); expect(f.release).toHaveBeenCalledTimes(1);
    } finally { reply.resolve(); await f.close(); }
  });
  it("keeps direct diagnostic compositions waiting for completed preparation", async () => {
    const f = await fixture(true), entered = deferred(), reply = deferred(); let settled = false;
    const opening = f.open({ authorizePreparation: async () => { entered.resolve(); await reply.promise; return { sessionId: f.session.id, status: "created" }; } })
      .then(recorder => { settled = true; return recorder; });
    try {
      await entered.promise; expect(settled).toBe(false); reply.resolve();
      expect((await opening).snapshot.desktop?.phase).toBe("ready");
      expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
    } finally { reply.resolve(); await opening; await f.close(); }
  });
  it.each(["low", "unavailable"] as const)("shows %s storage before Start and rechecks after space is restored", async failure => {
    const f = await fixture(true), availableBytes = vi.fn(async (): Promise<number> => {
      if (failure === "unavailable") throw new Error("Invented private storage error");
      return 1;
    });
    interruptedDriver(f); // In-memory synthetic source; no executable or OS audio.
    const recorder = await f.open({ prepareInBackground: true, storageCapacity: { availableBytes } });
    const bridge = wire(recorder), view = await connectDesktopRecorderView(bridge.port, f.session.id, f.abort.signal);
    try {
      await vi.waitFor(() => expect(view.controller.snapshot).toMatchObject({ state: "ready",
        statusCode: failure === "low" ? "capture_storage_low" : "capture_storage_unavailable", desktop: { phase: "ready" } }));
      expect(availableBytes).toHaveBeenCalledTimes(1);
      expect(f.selectWindow).not.toHaveBeenCalled(); expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
      const prepared = await f.options.flowStore.getActiveCaptureState();
      await expect(view.controller.startRecording()).rejects.toThrow();
      expect(view.controller.snapshot.statusCode).toBe(failure === "low" ? "capture_storage_low" : "capture_storage_unavailable");
      expect(availableBytes).toHaveBeenCalledTimes(2);
      expect(await f.options.flowStore.getActiveCaptureState()).toEqual(prepared);
      expect(f.selectWindow).not.toHaveBeenCalled(); expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
      availableBytes.mockResolvedValue(10_000_000_000);
      await view.controller.startRecording();
      // Both existing checks run: before source choice and before flow capture.
      expect(availableBytes).toHaveBeenCalledTimes(4);
      expect(f.selectWindow).toHaveBeenCalledTimes(1); expect(f.nativeStart).toHaveBeenCalledTimes(1);
      expect(view.controller.snapshot.statusCode).not.toBe("capture_storage_low");
      expect(view.controller.snapshot.statusCode).not.toBe("capture_storage_unavailable");
      await view.deactivate();
      expect(f.indicator.current()?.visible).not.toBe(true);
    } finally { await view.deactivate(); await bridge.boundary.dispose(); await f.close(); }
  });
});

describe("automatic interrupted-owner settlement", () => {
  it("shows subchunk accepted duration and adds exact retained duration once on Resume", async () => {
    const f = await fixture(true);
    const bff = f.options.createBff(f.abort.signal);
    vi.spyOn(bff, "getCapabilities").mockResolvedValue({ ...await bff.getCapabilities(f.session.id), target_chunk_duration_ms: 10_000 });
    let frames = 0, sink!: Parameters<NativeProcessPCMDriver["start"]>[1];
    const start = { hostTimeNanoseconds: "1000000000", microphonePrerollNanoseconds: "0", systemPrerollNanoseconds: "0" };
    f.nativeStart!.mockImplementation((_configuration, next) => {
      sink = next; frames = 0;
      return { ready: Promise.resolve(start), activate: () => undefined, stop: async ({ mode }) => mode === "discard" ? null : {
        start, outputFrames: frames, endHostTimeNanoseconds: String(1_000_000_000n + BigInt(frames) * 62_500n),
        microphoneTailNanoseconds: "0", systemTailNanoseconds: "0" } };
    });
    const recorder = await f.open();
    const second = async () => {
      for (let i = 0; i < 4; i++) {
        const firstFrame = frames; frames += 4_000;
        await sink.onPcmPacket({ firstFrame, pcmBytes: new Uint8Array(8_000) });
      }
    };
    try {
      await recorder.startRecording(); await second();
      expect(recorder.snapshot).toMatchObject({ elapsedSeconds: 1, recordedChunks: 0 });
      expect((await f.options.queueStorage.list()).filter(row => row.state === "encrypted")).toHaveLength(0);
      await recorder.pauseRecording();
      expect(recorder.snapshot).toMatchObject({ elapsedSeconds: 1, recordedChunks: 1 });
      await recorder.resumeRecording();
      expect(recorder.snapshot.elapsedSeconds).toBe(1);
      await second();
      expect(recorder.snapshot).toMatchObject({ elapsedSeconds: 2, recordedChunks: 1 });
      await recorder.pauseRecording();
      expect(recorder.snapshot).toMatchObject({ elapsedSeconds: 2, recordedChunks: 2 });
      expect(f.complete).not.toHaveBeenCalled();
      await recorder.deactivate();
      const resources = await f.reopen();
      const reopened = await f.open({ ...resources,
        authorizePreparation: async () => ({ sessionId: f.session.id, status: "capturing" }) });
      // Restore conservatively budgets encrypted envelope bytes. Duration must
      // still come from actual retained native frames, not that storage bound.
      expect((await resources.flowStore.getActiveCaptureState())!.recordedPlaintextBytes).toBeGreaterThan(64_088);
      expect(reopened.snapshot).toMatchObject({ elapsedSeconds: 2, recordedChunks: 2 });
    } finally { await f.close(); }
  });

  it("settles the original physical stop and retirement before enabling Resume, without uploading", async () => {
    const f = await fixture(true), driver = interruptedDriver(f);
    const nativeStopped = deferred(), retirement = deferred(), retirementEntered = deferred();
    const retired = vi.fn(async () => { retirementEntered.resolve(); await retirement.promise; });
    const recorder = await f.open({ retireSource: retired });
    const renew = vi.spyOn(f.options.createBff(f.abort.signal), "renewLease");
    try {
      await recorder.startRecording();
      driver.stop.mockImplementation(async () => { await nativeStopped.promise; return null; });
      await driver.interrupt(true);
      expect(recorder.snapshot).toMatchObject({ state: "paused", desktop: { phase: "stopping" } });
      await expect(recorder.resumeRecording()).rejects.toThrow();
      expect(retired).not.toHaveBeenCalled(); expect(renew).not.toHaveBeenCalled();
      nativeStopped.resolve(); await retirementEntered.promise;
      expect(recorder.snapshot).toMatchObject({ statusCode: "capture_stop_acknowledgement_pending", desktop: { phase: "stopping" } });
      expect(f.indicator.current()?.visible).toBe(false);
      expect((await f.options.flowStore.getActiveCaptureState())?.phase).toBe("paused");
      expect((await f.options.queueStorage.list()).filter(row => row.state === "encrypted")).toHaveLength(1);
      await expect(recorder.resumeRecording()).rejects.toThrow();
      expect(f.complete).not.toHaveBeenCalled(); expect(renew).not.toHaveBeenCalled();
      retirement.resolve();
      await vi.waitFor(() => expect(recorder.snapshot).toMatchObject({ state: "paused", statusCode: "capture_paused", desktop: { phase: "interrupted" } }));
      expect(retired).toHaveBeenCalledOnce(); expect(driver.stop).toHaveBeenCalledOnce();
      expect(f.complete).not.toHaveBeenCalled();
      await recorder.resumeRecording();
      expect(recorder.snapshot.desktop?.phase).toBe("recording");
      expect(renew).toHaveBeenCalledOnce();
    } finally { nativeStopped.resolve(); retirement.resolve(); await f.close(); }
  });

  it("preserves Finish requested during the final durable pause, and uploads once", async () => {
    const f = await fixture(true), driver = interruptedDriver(f);
    const saving = deferred(), saved = deferred();
    let retired = false;
    const recorder = await f.open({ retireSource: async () => { retired = true; } });
    const persist = f.options.flowStore.putActiveCaptureState.bind(f.options.flowStore);
    vi.spyOn(f.options.flowStore, "putActiveCaptureState").mockImplementation(async value => {
      if (retired && value.phase === "paused") { saving.resolve(); await saved.promise; }
      await persist(value);
    });
    try {
      await recorder.startRecording(); await driver.interrupt(true); await saving.promise;
      const paused = recorder.pauseRecording(), finished = recorder.stopRecording();
      expect(finished).toBe(paused);
      expect(f.complete).not.toHaveBeenCalled();
      saved.resolve(); await finished;
      expect(recorder.snapshot).toMatchObject({ state: "processing", recordedChunks: 1 });
      expect(f.complete).toHaveBeenCalledOnce(); expect(driver.stop).toHaveBeenCalledOnce();
    } finally { saved.resolve(); await f.close(); }
  });

  it("waits for accepted encrypted chunk persistence before retiring and preserves it", async () => {
    const f = await fixture(true), writing = deferred(), saved = deferred();
    let sink!: Parameters<NativeProcessPCMDriver["start"]>[1];
    const stop = vi.fn(async () => null);
    f.nativeStart!.mockImplementation((_configuration, value) => {
      sink = value;
      return { ready: Promise.resolve({ hostTimeNanoseconds: "1000000000", microphonePrerollNanoseconds: "0", systemPrerollNanoseconds: "0" }),
        activate: () => undefined, stop };
    });
    const persist = f.options.queueStorage.compareAndSwap.bind(f.options.queueStorage);
    vi.spyOn(f.options.queueStorage, "compareAndSwap").mockImplementation(async (id, revision, replacement) => {
      if (replacement.state === "encrypted") { writing.resolve(); await saved.promise; }
      return persist(id, revision, replacement);
    });
    const recorder = await f.open();
    try {
      await recorder.startRecording();
      const accepted = sink.onPcmPacket({ firstFrame: 0, pcmBytes: new Uint8Array(3200) });
      await writing.promise; sink.onFailure("device_changed");
      await vi.waitFor(() => expect(stop).toHaveBeenCalled());
      expect(f.options.retireSource).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
      saved.resolve(); await accepted;
      await vi.waitFor(() => expect(recorder.snapshot).toMatchObject({ statusCode: "capture_paused", desktop: { phase: "interrupted" } }));
      expect(recorder.snapshot.recordedChunks).toBe(1);
      expect((await f.options.queueStorage.list()).filter(row => row.state === "encrypted")).toHaveLength(1);
      expect(f.options.retireSource).toHaveBeenCalledOnce(); expect(f.complete).not.toHaveBeenCalled();
    } finally { saved.resolve(); await f.close(); }
  });

  it("retains lost retirement acknowledgement for explicit pause retry without upload or automatic retry", async () => {
    const f = await fixture(true), driver = interruptedDriver(f);
    const retired = vi.fn(async () => undefined).mockRejectedValueOnce(new Error("invented lost stop reply"));
    const recorder = await f.open({ retireSource: retired });
    try {
      await recorder.startRecording(); await driver.interrupt(true);
      await vi.waitFor(() => expect(recorder.snapshot).toMatchObject({ statusCode: "capture_stop_acknowledgement_pending", desktop: { phase: "interrupted" } }));
      await expect(recorder.resumeRecording()).rejects.toThrow();
      expect(retired).toHaveBeenCalledOnce(); expect(f.complete).not.toHaveBeenCalled();
      await recorder.pauseRecording();
      expect(recorder.snapshot).toMatchObject({ statusCode: "capture_paused", desktop: { phase: "interrupted" } });
      expect(retired).toHaveBeenCalledTimes(2); expect(driver.stop).toHaveBeenCalledOnce();
      expect(f.complete).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("waits for in-flight interruption retirement before releasing custody on close", async () => {
    const f = await fixture(true), driver = interruptedDriver(f), entered = deferred(), settled = deferred();
    const retired = vi.fn(async () => { entered.resolve(); await settled.promise; });
    const recorder = await f.open({ retireSource: retired });
    try {
      await recorder.startRecording(); await driver.interrupt(true); await entered.promise;
      const closing = recorder.deactivate();
      expect(f.release).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
      settled.resolve(); await closing;
      expect(f.release).toHaveBeenCalledOnce(); expect(f.complete).not.toHaveBeenCalled();
      expect(f.nativeStart).toHaveBeenCalledOnce();
    } finally { settled.resolve(); await f.close(); }
  });

  it("coalesces Cancel start with a native interruption without activation or upload", async () => {
    const f = await fixture(true), entered = deferred();
    const ready = deferred<{ hostTimeNanoseconds: string; microphonePrerollNanoseconds: string; systemPrerollNanoseconds: string }>();
    let sink!: Parameters<NativeProcessPCMDriver["start"]>[1];
    const stop = vi.fn(async () => null), activate = vi.fn();
    f.nativeStart!.mockImplementation((_configuration, value) => {
      sink = value; entered.resolve(); return { ready: ready.promise, activate, stop };
    });
    const recorder = await f.open();
    try {
      const starting = recorder.startRecording(), rejected = expect(starting).rejects.toThrow();
      await entered.promise;
      const cancelling = recorder.stopRecording(); sink.onFailure("device_changed");
      ready.resolve({ hostTimeNanoseconds: "1000000000", microphonePrerollNanoseconds: "0", systemPrerollNanoseconds: "0" });
      await rejected; await cancelling;
      expect(activate).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
      expect(f.options.retireSource).toHaveBeenCalledOnce(); expect(f.nativeStart).toHaveBeenCalledOnce();
      expect(f.indicator.current()?.visible).not.toBe(true);
      expect((await f.options.queueStorage.list()).every(row => row.state === "reserved")).toBe(true);
    } finally {
      ready.resolve({ hostTimeNanoseconds: "1000000000", microphonePrerollNanoseconds: "0", systemPrerollNanoseconds: "0" });
      await f.close();
    }
  });
});

describe("existing chooser recovery", () => {
  it("focuses only the same pending picker, and rejects ready/canceled attempts without opening another", async () => {
    const f = await fixture(true);
    const choice = deferred<{ application: "com.google.Chrome"; processID: number; windowID: number }>();
    const showWindowChooser = vi.fn(async () => undefined);
    const recorder = await f.open({ selectWindow: async signal => {
      await f.selectWindow();
      signal.addEventListener("abort", () => choice.resolve({ application: "com.google.Chrome", processID: 1, windowID: 1 }), { once: true });
      return choice.promise;
    }, showWindowChooser });
    try {
      await expect(recorder.showWindowChooser()).rejects.toThrow();
      const start = recorder.startRecording(); const rejected = expect(start).rejects.toThrow();
      await vi.waitFor(() => expect(recorder.snapshot.statusCode).toBe("capture_window_selection_pending"));
      await recorder.showWindowChooser();
      expect(showWindowChooser).toHaveBeenCalledTimes(1);
      expect(f.selectWindow).toHaveBeenCalledTimes(1);
      expect(f.nativeStart).not.toHaveBeenCalled();
      await recorder.stopRecording(); await rejected;
      await expect(recorder.showWindowChooser()).rejects.toThrow();
      expect(showWindowChooser).toHaveBeenCalledTimes(1);
      expect(f.selectWindow).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });
});

describe("confirmed stop recovery", () => {
  it.each(["capturing", "processing", "transcript_ready"] as const)(
    "revalidates a failed resume against server %s without replacing saved work or starting capture", async status => {
    const f = await fixture(true), driver = interruptedDriver(f);
    const bff = f.options.createBff(f.abort.signal), renew = vi.spyOn(bff, "renewLease");
    const mount = vi.fn(f.options.authorizeMount), recorder = await f.open({ authorizeMount: mount });
    try {
      await recorder.startRecording(); await driver.interrupt(true);
      await vi.waitFor(() => expect(recorder.snapshot).toMatchObject({ statusCode: "capture_paused", desktop: { phase: "interrupted" } }));
      mount.mockRejectedValueOnce(new Error("invented lost resume reply"));
      await expect(recorder.resumeRecording()).rejects.toThrow();
      expect(recorder.snapshot).toMatchObject({ state: "ready", statusCode: "capture_start_failed",
        desktop: { phase: "ready" } });
      const ready = (await f.options.flowStore.getActiveCaptureState())!;
      expect(ready).toMatchObject({ phase: "ready", recordedChunks: 1,
        continuation: { prepared: true, firstSequenceNumber: 1 } });
      const key = await f.options.flowStore.getSessionKeyState(f.session.id);
      const queue = await f.options.queueStorage.list();
      await recorder.deactivate();
      const resources = await f.reopen();
      const open = () => f.open({ ...resources, authorizeMount: mount,
        authorizePreparation: async () => ({ sessionId: f.session.id, status }) });
      if (status !== "capturing") {
        await expect(open()).rejects.toThrow();
        const retained = await f.reopen();
        expect(await retained.flowStore.getActiveCaptureState()).toEqual(ready);
        expect(await retained.flowStore.getSessionKeyState(f.session.id)).toEqual(key);
        expect(await retained.queueStorage.list()).toEqual(queue);
        expect(f.nativeStart).toHaveBeenCalledTimes(1); expect(mount).toHaveBeenCalledTimes(2);
        return;
      }
      const restored = await open();
      expect(restored.snapshot).toMatchObject({ state: "ready", recordedChunks: 1,
        desktop: { phase: "ready", coverage: "incomplete" } });
      const recovered = (await resources.flowStore.getActiveCaptureState())!;
      // Restoration conservatively includes the retained ciphertext envelope overhead.
      expect(recovered.recordedPlaintextBytes).toBeGreaterThanOrEqual(ready.recordedPlaintextBytes);
      expect({ ...recovered, recordedPlaintextBytes: ready.recordedPlaintextBytes }).toEqual(ready);
      expect(await resources.flowStore.getSessionKeyState(f.session.id)).toEqual(key);
      expect(await resources.queueStorage.list()).toEqual(queue);
      expect(await resources.coverage.hasPriorCapture(ready.lease.receipt_id)).toBe(true);
      expect(f.nativeStart).toHaveBeenCalledTimes(1); expect(f.selectWindow).toHaveBeenCalledTimes(2);
      expect(mount).toHaveBeenCalledTimes(2); expect(renew).toHaveBeenCalledTimes(1);
      expect(f.complete).not.toHaveBeenCalled();
      await restored.startRecording();
      expect(restored.snapshot.state).toBe("recording");
      expect(restored.snapshot.statusCode).not.toBe("capture_start_failed");
      expect(mount.mock.calls.at(-1)![0]).toMatchObject({ captureLeaseGeneration: ready.lease.generation,
        leaseReceiptId: ready.lease.receipt_id, firstSequenceNumber: 1 });
      expect(f.nativeStart).toHaveBeenCalledTimes(2); expect(renew).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });

  it.each(["capturing", "processing", "transcript_ready"] as const)(
    "rejects initial ready storage when the server is %s", async status => {
      const f = await fixture(true), recorder = await f.open();
      try {
        await recorder.deactivate();
        const resources = await f.reopen(), before = await resources.flowStore.getActiveCaptureState();
        await expect(f.open({ ...resources,
          authorizePreparation: async () => ({ sessionId: f.session.id, status }) })).rejects.toThrow();
        const retained = await f.reopen();
        expect(await retained.flowStore.getActiveCaptureState()).toEqual(before);
        expect(f.nativeStart).not.toHaveBeenCalled(); expect(f.authority).not.toHaveBeenCalled();
      } finally { await f.close(); }
    });

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

  it("retains zero saved chunks as paused until explicit resume and preserves the interruption warning", async () => {
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
      await view.controller.resumeRecording!();
      expect(view.controller.snapshot).toMatchObject({ state: "recording", recordedChunks: 0, desktop: { coverage: "incomplete" } });
      await view.deactivate(); await w.boundary.dispose();
      const resources = await f.reopen();
      const reopened = await f.open({ ...resources,
        authorizePreparation: async () => ({ sessionId: f.session.id, status: "capturing" }) });
      expect(reopened.snapshot).toMatchObject({ state: "paused", recordedChunks: 0, desktop: { coverage: "incomplete" } });
      expect(f.nativeStart).toHaveBeenCalledTimes(2); // Reopen cannot start a third capture.
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
  it.each([true, false])("retains accurate first-capture coverage after unused setup expiry (history reader: %s)", async historyReader => {
    const f = await fixture(), choosing = deferred(), chosen = deferred();
    const selectWindow = vi.fn().mockImplementationOnce(async () => {
      choosing.resolve(); await chosen.promise; return f.selectWindow();
    }).mockImplementation(f.selectWindow);
    const coverage = (value: DesktopProviderRecorderOptions["coverage"]): DesktopProviderRecorderOptions["coverage"] => historyReader ? value : {
      load: () => value.load(), persist: item => value.persist(item),
      beginInterval: (receipt: string, first: number) => value.beginInterval!(receipt, first),
    };
    try {
      const recorder = await f.open({ selectWindow, coverage: coverage(f.options.coverage) });
      const before = (await f.options.flowStore.getActiveCaptureState())!;
      const starting = recorder.startRecording(), rejected = expect(starting).rejects.toThrow();
      await choosing.promise;
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse(before.lease.expires_at) + 1_000);
      await recorder.stopRecording(); await rejected;
      // The restored queue holds Date.now; reset that same clock before renewal
      // instead of stranding it in the future when global Date is restored.
      vi.setSystemTime(vi.getRealSystemTime()); chosen.resolve();
      expect(recorder.snapshot).toMatchObject({ state: "paused", recordedChunks: 0, desktop: { coverage: "not_started" } });
      await recorder.resumeRecording();
      expect(recorder.snapshot.desktop?.coverage).toBe(historyReader ? "aligned" : "incomplete");
      await vi.waitFor(() => expect(recorder.snapshot.recordedChunks).toBeGreaterThanOrEqual(2));
      await recorder.stopRecording();
      expect(recorder.snapshot).toMatchObject({ state: "processing", desktop: { coverage: historyReader ? "complete" : "incomplete" } });
      expect((await f.options.flowStore.getActiveCaptureState())?.continuation?.firstSequenceNumber).toBe(0);
      await recorder.deactivate();
      const resources = await f.reopen();
      const reopened = await f.open({ ...resources, coverage: coverage(resources.coverage),
        authorizePreparation: async () => ({ sessionId: f.session.id, status: "processing" }) });
      expect(reopened.snapshot.desktop?.coverage).toBe(historyReader ? "complete" : "incomplete");
      expect(f.complete).toHaveBeenCalledTimes(1);
      expect(f.authority).toHaveBeenCalledTimes(1); // Reopen never starts another capture.
    } finally { vi.useRealTimers(); chosen.resolve(); await f.close(); }
  });

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
  it("closes a never-settling choice when its existing setup lease expires", async () => {
    const f = await fixture(true), choosing = deferred(), chosen = deferred();
    let choiceSignal: AbortSignal | undefined;
    const scheduled: { delay: number; fire: () => void }[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (typeof callback === "function" && typeof delay === "number") {
        scheduled.push({ delay, fire: () => callback(...args) });
      }
      return realSetTimeout(callback, delay, ...args);
    });
    try {
      const recorder = await f.open({ selectWindow: async signal => {
        choiceSignal = signal; choosing.resolve(); await chosen.promise;
        return { application: "com.google.Chrome", processID: 1, windowID: 1 };
      } });
      timers.mockRestore();
      const before = await f.options.flowStore.getActiveCaptureState();
      const starting = recorder.startRecording(), rejected = expect(starting).rejects.toThrow();
      await choosing.promise;
      const remaining = Date.parse(before!.captureAuthorizedUntil!) - Date.now();
      const expiry = scheduled.find(timer => timer.delay >= remaining && timer.delay <= remaining + 1_000);
      expect(expiry).toBeDefined();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.parse(before!.captureAuthorizedUntil!) + 1);
      expiry!.fire();
      await vi.waitFor(() => expect(recorder.snapshot.state).toBe("paused"));
      expect(recorder.snapshot).toMatchObject({ statusCode: "capture_setup_expired", recordedChunks: 0, elapsedSeconds: 0,
        desktop: { phase: "interrupted", coverage: "not_started" } });
      const reserved = await f.options.queueStorage.listMetadata();
      expect(reserved.length).toBeGreaterThan(0);
      expect(reserved.every(row => row.state === "reserved")).toBe(true);
      expect(recorder.snapshot.queuedChunks).toBe(reserved.length);
      expect(choiceSignal?.aborted).toBe(true);
      await rejected;
      chosen.resolve(); await Promise.resolve();
      expect((await f.options.flowStore.getActiveCaptureState())!.lease).toEqual(before!.lease);
      expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
    } finally { timers.mockRestore(); chosen.resolve(); await f.close(); vi.useRealTimers(); }
  });

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
  it("overlaps fresh setup with the read-only availability probe and waits for both", async () => {
    const f = await fixture(true), capabilitiesEntered = deferred(), releaseCapabilities = deferred(), releaseProbe = deferred();
    const bff = f.options.createBff(f.abort.signal), capabilities = await bff.getCapabilities(f.session.id);
    const preflight = vi.fn(f.options.authorizePreparation);
    vi.spyOn(bff, "getCapabilities").mockImplementation(async () => {
      capabilitiesEntered.resolve(); await releaseCapabilities.promise; return capabilities;
    });
    f.nativeAvailability!.mockImplementation(async () => { await releaseProbe.promise; return true; });
    let opened = false;
    const opening = f.open({ authorizePreparation: preflight }).then(value => { opened = true; return value; });
    try {
      await capabilitiesEntered.promise;
      expect(f.nativeAvailability).toHaveBeenCalledOnce();
      expect(preflight).toHaveBeenCalledBefore(f.nativeAvailability!);
      expect(opened).toBe(false);
      releaseCapabilities.resolve();
      // Await the final setup reservation, rather than a wall-clock sleep.
      await vi.waitFor(async () => expect((await f.options.flowStore.getActiveCaptureState())?.captureAuthorizedUntil).toBeTruthy());
      expect(opened).toBe(false);
      releaseProbe.resolve();
      const recorder = await opening;
      expect(recorder.snapshot.desktop?.phase).toBe("ready");
      expect(f.nativeAvailability).toHaveBeenCalledOnce();
      expect(f.selectWindow).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
      expect(f.authority).not.toHaveBeenCalled();
    } finally {
      releaseCapabilities.resolve(); releaseProbe.resolve(); await opening.catch(() => undefined); await f.close();
    }
  });

  it("retains opening ownership until its overlapped probe settles after a preparation failure", async () => {
    const f = await fixture(true), releaseProbe = deferred(), probeEntered = deferred();
    const bff = f.options.createBff(f.abort.signal);
    vi.spyOn(bff, "getCapabilities").mockRejectedValue(new Error("invented capabilities failure"));
    f.nativeAvailability!.mockImplementation(async () => {
      probeEntered.resolve(); await releaseProbe.promise; return true;
    });
    const opening = f.open(), rejected = expect(opening).rejects.toThrow("invented capabilities failure");
    try {
      await probeEntered.promise;
      await vi.waitFor(async () => expect((await f.options.flowStore.getSessionKeyState(f.session.id))?.state).toBe("bound"));
      expect(f.release).not.toHaveBeenCalled();
      releaseProbe.resolve(); await rejected;
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.selectWindow).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
    } finally { releaseProbe.resolve(); await opening.catch(() => undefined); await f.close(); }
  });

  it("publishes a fixed failed-start status through IPC and clears it on explicit retry", async () => {
    const f = await fixture(true); interruptedDriver(f);
    const mount = vi.fn(f.options.authorizeMount).mockRejectedValueOnce(new Error("invented private transport detail"));
    const recorder = await f.open({ authorizeMount: mount }), w = wire(recorder);
    const view = await connectDesktopRecorderView(w.port, f.session.id, f.abort.signal);
    try {
      const prepared = await f.options.flowStore.getActiveCaptureState();
      await expect(view.controller.startRecording()).rejects.toThrow();
      expect(view.controller.snapshot).toMatchObject({ state: "ready", statusCode: "capture_start_failed" });
      expect(JSON.stringify(w.messages)).not.toContain("invented private transport detail");
      expect(await f.options.flowStore.getActiveCaptureState()).toEqual(prepared);
      expect(f.nativeStart).not.toHaveBeenCalled();
      await view.controller.startRecording();
      expect(view.controller.snapshot).toMatchObject({ state: "recording", statusCode: "capture_recording" });
      expect(f.nativeStart).toHaveBeenCalledTimes(1);
    } finally { await w.boundary.dispose(); await f.close(); }
  });

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
      expect(f.nativeAvailability).not.toHaveBeenCalled();
      expect(mount).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it("rejects a changed session in preflight before lease work", async () => {
    const f = await fixture(true), issue = vi.spyOn(f.options.createBff(f.abort.signal), "issueLease");
    try {
      await expect(f.open({ authorizePreparation: async () => ({ sessionId: crypto.randomUUID(), status: "created" }) })).rejects.toThrow();
      expect(issue).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
      expect(f.nativeAvailability).not.toHaveBeenCalled();
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
      expect(f.nativeAvailability).toHaveBeenCalledTimes(2); // The parallel read-only check conveys no authority.
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
      expect(f.nativeAvailability).toHaveBeenCalledTimes(2); expect(f.nativeStart).not.toHaveBeenCalled();
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
        recordedChunks: 0, elapsedSeconds: 0, desktop: { phase: "interrupted", coverage: "not_started" } });
      const reserved = await f.options.queueStorage.listMetadata();
      expect(reserved.length).toBeGreaterThan(0);
      expect(reserved.every(row => row.state === "reserved")).toBe(true);
      expect(recorder.snapshot.queuedChunks).toBe(reserved.length);
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


describe("resume readiness overlap", () => {
  it("overlaps the read-only probe only after retirement and keeps every fresh Start check", async () => {
    const f = await fixture(true), driver = interruptedDriver(f), retired = vi.fn(async () => undefined);
    const recorder = await f.open({ retireSource: retired });
    const probeEntered = deferred(), releaseProbe = deferred(), renewEntered = deferred(), releaseRenew = deferred();
    const bff = f.options.createBff(f.abort.signal), renew = bff.renewLease.bind(bff);
    try {
      await recorder.startRecording(); await driver.interrupt(true);
      await vi.waitFor(() => expect(recorder.snapshot).toMatchObject({ statusCode: "capture_paused", desktop: { phase: "interrupted" } }));
      retired.mockClear();
      f.nativeAvailability!.mockClear();
      f.nativeAvailability!.mockImplementation(async () => {
        expect(retired).toHaveBeenCalled(); probeEntered.resolve(); await releaseProbe.promise; return true;
      });
      vi.spyOn(bff, "renewLease").mockImplementation(async (...args) => {
        renewEntered.resolve(); await releaseRenew.promise; return renew(...args);
      });
      let settled = false;
      const resuming = recorder.resumeRecording().then(() => { settled = true; });
      await renewEntered.promise; await probeEntered.promise;
      expect(f.authority).toHaveBeenCalledTimes(1); expect(f.nativeStart).toHaveBeenCalledTimes(1);
      releaseRenew.resolve();
      await vi.waitFor(async () => expect((await f.options.flowStore.getActiveCaptureState())?.continuation?.prepared).toBe(true));
      expect(settled).toBe(false);
      releaseProbe.resolve(); await resuming;
      expect(recorder.snapshot.desktop?.phase).toBe("recording");
      expect(f.nativeAvailability).toHaveBeenCalledTimes(2); // Native start owns the final fresh permission check.
      expect(f.authority).toHaveBeenCalledTimes(2); expect(f.nativeStart).toHaveBeenCalledTimes(2);
    } finally { releaseProbe.resolve(); releaseRenew.resolve(); await f.close(); }
  });

  it.each(["preparation_failure", "cancelled"] as const)("settles the overlapped probe before returning %s without another capture", async mode => {
    const f = await fixture(true), driver = interruptedDriver(f), recorder = await f.open();
    const probeEntered = deferred(), releaseProbe = deferred();
    let resuming: Promise<void> | undefined, closing: Promise<void> | undefined;
    try {
      await recorder.startRecording(); await driver.interrupt(true);
      await vi.waitFor(() => expect(recorder.snapshot).toMatchObject({ statusCode: "capture_paused", desktop: { phase: "interrupted" } }));
      f.nativeAvailability!.mockImplementation(async () => { probeEntered.resolve(); await releaseProbe.promise; return true; });
      if (mode === "preparation_failure") {
        vi.spyOn(f.options.createBff(f.abort.signal), "getCapabilities").mockRejectedValue(new Error("invented preparation failure"));
      }
      let settled = false;
      resuming = recorder.resumeRecording();
      const rejected = expect(resuming).rejects.toThrow();
      void resuming.finally(() => { settled = true; }).catch(() => undefined);
      await probeEntered.promise;
      if (mode === "cancelled") closing = recorder.deactivate();
      await Promise.resolve(); await Promise.resolve();
      expect(settled).toBe(false); expect(f.release).not.toHaveBeenCalled();
      expect(f.authority).toHaveBeenCalledTimes(1); expect(f.nativeStart).toHaveBeenCalledTimes(1);
      releaseProbe.resolve(); await rejected; await closing;
      expect(f.authority).toHaveBeenCalledTimes(1); expect(f.nativeStart).toHaveBeenCalledTimes(1);
    } finally { releaseProbe.resolve(); await resuming?.catch(() => undefined); await closing; await f.close(); }
  });
});


describe("start readiness overlap", () => {
  it("prepares the mobile-sized first window without acquiring audio or changing continuation batches", async () => {
    const f = await fixture(true), bff = f.options.createBff(f.abort.signal), driver = interruptedDriver(f);
    const reserve = vi.spyOn(bff, "reserveChunks");
    const prepare = vi.fn(async (id: string, request: PrepareRecordingWindowRequest) => {
      const binding = await bff.bindSessionAudioKey(id, request.binding, { idempotencyKey: request.bind_idempotency_key });
      const lease = await bff.issueLease(id, { protocol_version: "1.0" }, { idempotencyKey: request.lease_idempotency_key });
      const reservations = await bff.reserveChunks(id, { protocol_version: "1.0", capture_lease_id: lease.lease_id,
        capture_lease_generation: lease.generation, channel: request.channel, first_sequence_number: 0, count: request.reservation_count },
      { idempotencyKey: request.reserve_idempotency_key });
      return { schema_version: "1.0" as const, binding, lease, reservations };
    });
    try {
      const recorder = await f.open({ createBff: () => Object.assign(bff, { prepareRecordingWindow: prepare }) });
      expect(prepare.mock.calls[0]![1].reservation_count).toBe(30);
      expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
      await recorder.startRecording(); await driver.interrupt(true);
      await vi.waitFor(() => expect(recorder.snapshot.desktop?.phase).toBe("interrupted"));
      await recorder.resumeRecording();
      expect(reserve.mock.calls.map(call => call[1].count)).toEqual([30, 90]);
      expect(f.authority).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });

  it("preserves the initialization deadline and ignores a late ready result", async () => {
    const f = await fixture(true), recorder = await f.open(), entered = deferred(), reply = deferred();
    const scheduled: (() => void)[] = [], original = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (typeof callback === "function" && delay === 15_000) scheduled.push(() => callback(...args));
      return original(callback, delay, ...args);
    });
    f.nativeAvailability!.mockImplementationOnce(async () => { entered.resolve(); await reply.promise; return true; });
    const starting = recorder.startRecording(), rejected = expect(starting).rejects.toThrow();
    try {
      await entered.promise; timer.mockRestore();
      expect(scheduled).toHaveLength(1); scheduled[0]!();
      await rejected;
      expect(recorder.snapshot.desktop?.phase).toBe("interrupted");
      reply.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
    } finally { timer.mockRestore(); reply.resolve(); await starting.catch(() => undefined); await f.close(); }
  });

  it("overlaps mount with a fresh probe after choice and retains native start authority", async () => {
    const f = await fixture(true); interruptedDriver(f);
    const mountEntered = deferred(), releaseMount = deferred(), probeEntered = deferred(), releaseProbe = deferred();
    const recorder = await f.open({ authorizeMount: async (prepared, signal) => {
      mountEntered.resolve(); await releaseMount.promise; return f.options.authorizeMount(prepared, signal);
    } });
    f.nativeAvailability!.mockClear();
    f.nativeAvailability!.mockImplementationOnce(async () => {
      expect(f.selectWindow).toHaveBeenCalledOnce(); probeEntered.resolve(); await releaseProbe.promise; return true;
    });
    const starting = recorder.startRecording();
    try {
      await mountEntered.promise; await probeEntered.promise;
      expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
      releaseProbe.resolve(); await Promise.resolve();
      expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
      releaseMount.resolve(); await starting;
      expect(recorder.snapshot.desktop?.phase).toBe("recording");
      expect(f.nativeAvailability).toHaveBeenCalledOnce(); // No disposable probe before guarded native start.
      expect(f.authority).toHaveBeenCalledOnce(); expect(f.nativeStart).toHaveBeenCalledOnce();
    } finally { releaseMount.resolve(); releaseProbe.resolve(); await starting.catch(() => undefined); await f.close(); }
  });

  it("retires a cancelled attempt and never reuses its ready result for a later permission-required attempt", async () => {
    const f = await fixture(true), probeEntered = deferred(), releaseProbe = deferred();
    const mount = vi.fn(f.options.authorizeMount), retireSource = vi.fn(async () => undefined);
    const recorder = await f.open({ authorizeMount: mount, retireSource });
    f.nativeAvailability!.mockClear();
    f.nativeAvailability!.mockImplementationOnce(async () => { probeEntered.resolve(); await releaseProbe.promise; return true; });
    const starting = recorder.startRecording(), rejected = expect(starting).rejects.toThrow();
    let stopping: Promise<void> | undefined;
    try {
      await probeEntered.promise;
      stopping = recorder.stopRecording();
      expect(retireSource).not.toHaveBeenCalled();
      releaseProbe.resolve(); await rejected; await stopping;
      expect(retireSource).toHaveBeenCalledOnce(); expect(recorder.snapshot.desktop?.phase).toBe("ready");
      f.nativeAvailability!.mockResolvedValue(false);
      await recorder.startRecording();
      expect(recorder.snapshot.desktop?.phase).toBe("permission_required");
      expect(f.nativeAvailability).toHaveBeenCalledTimes(3);
      expect(mount).toHaveBeenCalledTimes(2); expect(retireSource).toHaveBeenCalledTimes(2);
      expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
    } finally { releaseProbe.resolve(); await starting.catch(() => undefined); await stopping; await f.close(); }
  });

  it.each(["mount", "probe"] as const)("settles both branches after %s failure before allowing retirement", async failure => {
    const f = await fixture(true), branchEntered = deferred(), releaseBranch = deferred();
    const mount = vi.fn(async (prepared: PreparedDesktopCapture, signal: AbortSignal) => {
      if (failure === "mount") throw new Error("invented mount failure");
      branchEntered.resolve(); await releaseBranch.promise; return f.options.authorizeMount(prepared, signal);
    });
    const retireSource = vi.fn(async () => undefined), recorder = await f.open({ authorizeMount: mount, retireSource });
    f.nativeAvailability!.mockImplementationOnce(async () => {
      if (failure === "probe") throw new Error("invented probe failure");
      branchEntered.resolve(); await releaseBranch.promise; return true;
    });
    let settled = false;
    const starting = recorder.startRecording(), rejected = expect(starting).rejects.toThrow();
    void starting.finally(() => { settled = true; }).catch(() => undefined);
    try {
      await branchEntered.promise; await Promise.resolve();
      expect(settled).toBe(false); expect(retireSource).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
      expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
      releaseBranch.resolve(); await rejected;
      if (failure === "probe") {
        expect(recorder.snapshot.desktop?.phase).toBe("interrupted");
        await expect(recorder.startRecording()).rejects.toThrow();
        expect(mount).toHaveBeenCalledOnce();
      }
      await recorder.stopRecording();
      expect(retireSource).toHaveBeenCalledOnce(); expect(f.nativeStart).not.toHaveBeenCalled();
    } finally { releaseBranch.resolve(); await starting.catch(() => undefined); await f.close(); }
  });
});


describe("deliberate desktop input selection", () => {
  it("uses only an explicit current inline choice, refresh invalidates it, and selection never captures", async () => {
    const f = await fixture(true); interruptedDriver(f);
    const list = vi.fn(async () => [{ application: "us.zoom.xos" as const, processID: 42, windowID: 74, title: "Zoom — Synthetic visit" }]);
    const recorder = await f.open({ listMeetingWindows: list });
    try {
      expect(recorder.snapshot.desktop?.meetingWindows?.selectedId).toBeNull();
      await expect(recorder.startRecording()).rejects.toThrow();
      expect(f.authority).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled();
      const id = recorder.snapshot.desktop!.meetingWindows!.windows[0]!.id;
      await recorder.selectMeetingWindow(id);
      expect(f.nativeStart).not.toHaveBeenCalled();
      await recorder.refreshMeetingWindows();
      await expect(recorder.selectMeetingWindow(id)).rejects.toThrow();
      expect(recorder.snapshot.desktop?.meetingWindows?.selectedId).toBeNull();
      const wireId = recorder.snapshot.desktop!.meetingWindows!.windows[0]!.id;
      const ipc = wire(recorder), view = await connectDesktopRecorderView(ipc.port, f.session.id, f.abort.signal);
      await view.controller.selectMeetingWindow!(wireId);
      expect(f.nativeStart).not.toHaveBeenCalled();
      await view.controller.startRecording();
      expect(f.selectWindow).not.toHaveBeenCalled(); expect(f.authority).toHaveBeenCalledOnce();
      expect(f.nativeStart).toHaveBeenCalledOnce();
      await view.deactivate(); await ipc.boundary.dispose();
    } finally { await f.close(); }
  });

  it("starts microphone-only without a picker and keeps the current backend start decision", async () => {
    const f = await fixture(true), driver = interruptedDriver(f);
    const saveAudioMode = vi.fn(async () => undefined);
    const recorder = await f.open({ audioMode: "microphone", saveAudioMode });
    try {
      expect(recorder.snapshot.desktop?.audioMode).toBe("microphone");
      await recorder.startRecording();
      expect(f.selectWindow).not.toHaveBeenCalled();
      expect(f.authority).toHaveBeenCalledOnce();
      expect(f.nativeStart).toHaveBeenCalledOnce();
      await expect(recorder.selectDesktopAudio("meeting")).rejects.toThrow();
      await driver.interrupt(true);
      await vi.waitFor(() => expect(recorder.snapshot.desktop?.phase).toBe("interrupted"));
      await expect(recorder.selectDesktopAudio("meeting")).rejects.toThrow();
      expect(saveAudioMode).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it("persists an explicit input change before capture and still uses the picker for meeting audio", async () => {
    const f = await fixture(true); interruptedDriver(f);
    const save = vi.fn(async () => undefined), recorder = await f.open({ audioMode: "microphone", saveAudioMode: save });
    try {
      await recorder.selectDesktopAudio("meeting");
      expect(save).toHaveBeenCalledWith("meeting");
      expect(recorder.snapshot.desktop?.audioMode).toBe("meeting");
      await recorder.startRecording(); expect(f.selectWindow).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
});
