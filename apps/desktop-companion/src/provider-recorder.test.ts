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
import { DesktopProviderRecorder, type DesktopProviderRecorderOptions } from "./provider-recorder.js";
import { DesktopProviderRecorderIpc } from "./provider-recorder-ipc.js";
import { DurableDesktopRecordStore } from "./durable-record-store.js";
import { DurableDesktopFlowStore } from "./durable-flow-store.js";
import { DurableDesktopQueueStorage } from "./durable-queue-store.js";
import { DurableDesktopCoverage } from "./durable-provider-records.js";
import { InMemoryRecordingIndicator } from "./recording-indicator.js";
import { NativeProcessPCMDriver } from "./native-process-driver.js";

const helperPath = process.env.SCRIBE_DESKTOP_PIPE_FIXTURE;
const workspaceId = "10000000-0000-4000-8000-000000000001", recoveryScope = "20000000-0000-4000-8000-000000000002";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

async function fixture() {
  if (!helperPath) throw new Error("separate compiled invented audio fixture required");
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
      captureCapability: { capabilityId: crypto.randomUUID(), secret: "invented-start-capability", expiresAt } };
  });
  const selectWindow = vi.fn(async () => {
    expect(indicator.current()).toMatchObject({ visible: true, phase: "recording" });
    return { application: "com.google.Chrome" as const, processID: 1, windowID: 1 };
  });
  const complete = vi.spyOn(bff, "completeCapture");
  const originalCapabilities = await bff.getCapabilities(session.id);
  // Small invented chunks expose accepted-vs-discarded tails without real speech.
  vi.spyOn(bff, "getCapabilities").mockResolvedValue({ ...originalCapabilities, target_chunk_duration_ms: 100 });
  const resources = () => {
    const flowStore = new DurableDesktopFlowStore(store.namespace("flow"));
    return { flowStore, createSessionKey: flowStore.createSessionKey,
      queueStorage: new DurableDesktopQueueStorage(store.namespace(`queue:${session.id}`), session.id),
      coverage: new DurableDesktopCoverage(store.namespace("coverage"), session.id) };
  };
  const options: DesktopProviderRecorderOptions = { enabled: true, sessionId: session.id, signal: abort.signal,
    createBff: () => bff, authorizeMount: async () => ({ grant, status: "created" }), authority: { authorizeStart: authority },
    indicator, ...resources(), uploadTarget: new HttpCiphertextUploadTarget([origin]),
    native: { helperPath, helperSha256: createHash("sha256").update(await readFile(helperPath)).digest("hex"), isSessionActive: () => !abort.signal.aborted },
    selectWindow, release };
  return { options, indicator, abort, authority, selectWindow, release, complete, session,
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

describe.skipIf(!helperPath)("desktop provider main and renderer recorder", () => {
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
        authorizeMount: async signal => ({ ...await f.options.authorizeMount(signal), status: "capturing" }) });
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
      await expect(f.open({ authorizeMount: async signal => {
        const value = await f.options.authorizeMount(signal); return { ...value, grant: { ...value.grant as object, captureSessionId: crypto.randomUUID() } };
      } })).rejects.toThrow();
      expect(f.selectWindow).not.toHaveBeenCalled(); expect(f.authority).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
