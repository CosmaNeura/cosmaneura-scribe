import { webcrypto } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Capacitor } from "@capacitor/core";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeChunkAdditionalDataBase64Url, PROTOCOL_VERSION } from "@cosmaneura-scribe/capture-protocol";
import type { SecureQueueCompareAndSwapOptions, SecureQueueRecord } from "@cosmaneura-scribe/capacitor-secure-queue";
import { createReservedRecord } from "../queue/records";
import { CaptureQueue } from "../queue/capture-queue";
import { CaptureFlowController } from "../flow/controller";
import { HttpCaptureBff } from "../bff/http-client";
import { BffCaptureQueueTransport } from "../bff/queue-transport";
import { HttpCiphertextUploadTarget } from "../bff/upload-target";
import { createMockBffServer } from "../mock-bff/server";
import { encodePcm16MonoWav, pcm16WavProfile, type CaptureSourceStartOptions } from "../capture";
import { EncryptedIndexedDbFlowStore } from "../flow/encrypted-store";
import type { CaptureFlowLockManager } from "../flow/capture-lock";
import * as sourceFactory from "./ios-capture-source";
import { createProviderIOSHost, type AuthorizedProviderIOSMount, type ProviderIOSBackend } from "./ios-host";

const native = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), list: vi.fn(), compareAndSwap: vi.fn() }));
vi.mock("@cosmaneura-scribe/capacitor-secure-queue", () => ({ SecureQueue: native }));
const recovery = "10000000-0000-4000-8000-000000000001";
const workspace = "20000000-0000-4000-8000-000000000002";
const session = "30000000-0000-4000-8000-000000000003";
const objectId = "40000000-0000-4000-8000-000000000004";
const other = "50000000-0000-4000-8000-000000000005";
const appointment = "appointment_01j00000000000000000000000";
const source = { kind: "microphone" as const, start: vi.fn(), stop: vi.fn() };
let rows: Map<string, { data: string; revision: string }>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("indexedDB", new IDBFactory());
  const locked = new Set<string>();
  const locks: CaptureFlowLockManager = { request: async (name, _options, callback) => {
    if (locked.has(name)) return callback(null);
    locked.add(name);
    try { return await callback({ name, mode: "exclusive" }); }
    finally { locked.delete(name); }
  } };
  vi.stubGlobal("navigator", { locks });
  vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
  vi.spyOn(Capacitor, "getPlatform").mockReturnValue("ios");
  vi.spyOn(Capacitor, "isPluginAvailable").mockReturnValue(true);
  source.start.mockResolvedValue(undefined); source.stop.mockResolvedValue(undefined);
  vi.spyOn(sourceFactory, "createProviderIOSCaptureSource").mockReturnValue(source);
  rows = new Map();
  native.get.mockImplementation(async ({ key }: { key: string }) => {
    const row = rows.get(key);
    if (!row) throw Object.assign(new Error("missing fixture record"), { code: "SECURE_QUEUE_NOT_FOUND" });
    return { key, ...row };
  });
  native.list.mockImplementation(async () => ({ keys: [...rows.keys()] }));
  native.create.mockImplementation(async ({ key, data }: SecureQueueRecord) => {
    if (rows.has(key)) throw Object.assign(new Error("fixture already exists"), { code: "SECURE_QUEUE_ALREADY_EXISTS" });
    rows.set(key, { data, revision: "1" }); return { revision: "1" };
  });
  native.compareAndSwap.mockImplementation(async ({ key, data, expectedRevision }: SecureQueueCompareAndSwapOptions) => {
    if (rows.get(key)?.revision !== expectedRevision) {
      throw Object.assign(new Error("fixture revision changed"), { code: "SECURE_QUEUE_REVISION_CONFLICT" });
    }
    const revision = String(Number(expectedRevision) + 1);
    rows.set(key, { data, revision }); return { revision };
  });
});

function connection(overrides: Partial<AuthorizedProviderIOSMount> = {}) {
  const abort = new AbortController();
  const mount: AuthorizedProviderIOSMount = {
    encounter: { appointmentRef: appointment, title: "Invented visit", detail: "Synthetic fixture" },
    scope: { workspaceId: workspace, appointmentRef: appointment, bindingRef: "scribe_capture_binding_01j00000000000000000000000" },
    recoveryScope: recovery, signal: abort.signal,
    request: async () => { throw new Error("No Core operation should run during acquisition"); },
    uploadTarget: { putCompleteEnvelope: async () => undefined },
    prepareNativeSource: vi.fn(async () => undefined), releaseNativeSource: vi.fn(async () => undefined),
    reauthorizeRecorder: vi.fn(async () => undefined), openInCore: vi.fn(async () => undefined), ...overrides,
  };
  const backend: ProviderIOSBackend = { signal: abort.signal,
    listEncounters: async () => [mount.encounter], createEncounter: vi.fn(async () => undefined),
    openEncounter: async () => mount };
  return { backend, mount, abort, open: () => createProviderIOSHost(backend).openEncounter(appointment, abort.signal) };
}
function record(sessionId = session) {
  return createReservedRecord({ protocolVersion: PROTOCOL_VERSION, objectId, sessionId, channel: "microphone",
    sequenceNumber: 0, additionalAuthenticatedData: encodeChunkAdditionalDataBase64Url({ tenantId: recovery,
      sessionId, objectId, sequenceNumber: 0, channel: "microphone" }), createdAt: "2026-09-22T13:00:00.000Z" },
  { reservation: "reserved-synthetic-0001", uploadAuthorization: "upload-synthetic-0001",
    uploadAuthorizationGeneration: 1, registration: "registered-synthetic-0001" });
}
const preparation = { mode: "configured_core" as const, schemaVersion: 2 as const,
  sessionId: session, startedAt: "2026-09-22T13:00:00.000Z", completeIdempotencyKey: "complete-synthetic-0001",
  leaseIdempotencyKey: null, leaseRequest: null };

describe("native provider host composition", () => {
  it("reuses only the custody read for restore, then rereads native storage", async () => {
    const service = connection(), first = await (await service.open()).recorder(session, service.abort.signal);
    await first.queueStorage.create(record()); await first.release();
    native.list.mockClear(); native.get.mockClear();
    const restored = await (await service.open()).recorder(session, service.abort.signal);
    expect(native.list).toHaveBeenCalledTimes(1); expect(native.get).toHaveBeenCalledTimes(1);
    expect(await restored.queueStorage.list()).toEqual([record()]);
    expect(native.list).toHaveBeenCalledTimes(1); expect(native.get).toHaveBeenCalledTimes(1);
    native.list.mockRejectedValueOnce(new Error("native custody became unavailable"));
    await expect(restored.queueStorage.list()).rejects.toThrow("native custody became unavailable");
    await restored.release();
  });

  it.each(["create", "get", "compareAndSwap"] as const)("invalidates the opening read before %s, including a failed operation", async operation => {
    const service = connection(), resources = await (await service.open()).recorder(session, service.abort.signal);
    if (operation === "create") {
      await resources.queueStorage.create(record());
    } else if (operation === "get") {
      expect(await resources.queueStorage.get(objectId)).toBeNull();
    } else {
      expect(await resources.queueStorage.compareAndSwap(objectId, 0, record())).toBe(false);
    }
    native.list.mockRejectedValueOnce(new Error("fresh native read required"));
    await expect(resources.queueStorage.list()).rejects.toThrow("fresh native read required");
    await resources.release();
  });

  it("cannot use the opening read after encounter revocation", async () => {
    const service = connection(), resources = await (await service.open()).recorder(session, service.abort.signal);
    service.abort.abort();
    await expect(resources.queueStorage.list()).rejects.toThrow("provider_native_scope_unavailable");
    await resources.release();
  });

  it("uses the authorized binding and recovers the same encrypted flow and scoped queue without starting audio", async () => {
    const service = connection(), encounter = await service.open();
    expect(await encounter.journal.load()).toEqual({ revision: null, progress: null });
    expect(await encounter.reviewJournal(session).load()).toBeNull();
    const first = await encounter.recorder(session, service.abort.signal);
    expect(service.mount.reauthorizeRecorder).toHaveBeenCalledWith(session, service.abort.signal);
    expect(first.source.kind).toBe("microphone"); expect(source.start).not.toHaveBeenCalled();
    expect(first.uploadTarget).toBe(service.mount.uploadTarget);
    await first.flowStore.putPreparationState(preparation);
    await first.queueStorage.create(record());
    await first.release();
    const restored = await (await service.open()).recorder(session, service.abort.signal);
    expect(await restored.flowStore.getPreparationState()).toEqual(preparation);
    expect(await restored.queueStorage.list()).toEqual([record()]);
    await restored.release();
    await encounter.openInCore(null); expect(service.mount.openInCore).toHaveBeenCalledWith(null);
  });

  it("never reads another creator, workspace, session or legacy queue namespace", async () => {
    const service = connection(), first = await (await service.open()).recorder(session, service.abort.signal);
    await first.queueStorage.create(record()); await first.release();
    const firstKey = [...rows.keys()][0];
    rows.set(objectId, { data: "legacy-record-must-not-be-read", revision: "1" });
    native.get.mockClear();
    for (const [changed, sessionId] of [
      [{ recoveryScope: other }, session],
      [{ scope: { ...service.mount.scope, workspaceId: other } }, session],
      [{}, other],
    ] as const) {
      const next = connection(changed), resources = await (await next.open()).recorder(sessionId, next.abort.signal);
      expect(await resources.queueStorage.list()).toEqual([]);
      expect(await resources.queueStorage.get(objectId)).toBeNull();
      await resources.release();
    }
    expect(native.get).not.toHaveBeenCalledWith({ key: firstKey });
    expect(native.get).not.toHaveBeenCalledWith({ key: objectId });
    const restored = await (await service.open()).recorder(session, service.abort.signal);
    expect(() => restored.queueStorage.create(record(other))).toThrow("provider_native_scope_unavailable");
    await restored.release();
  });

  it("retains a pending session and releases a failed acquisition without clearing it", async () => {
    const service = connection(), encounter = await service.open();
    const first = await encounter.recorder(session, service.abort.signal);
    await first.flowStore.putPreparationState(preparation); await first.release();
    await expect(encounter.recorder(other, service.abort.signal)).rejects.toThrow("provider_saved_session_changed");
    const recovered = await encounter.recorder(session, service.abort.signal);
    expect(await recovered.flowStore.getPreparationState()).toEqual(preparation); await recovered.release();
  });

  it("keeps the native handle and exclusive lock until stopping is confirmed", async () => {
    const service = connection(), encounter = await service.open();
    const resources = await encounter.recorder(session, service.abort.signal);
    source.stop.mockRejectedValueOnce(new Error("audio_capture_native_stop_failed"));
    await expect(resources.release()).rejects.toThrow("audio_capture_native_stop_failed");
    await expect(encounter.recorder(session, service.abort.signal)).rejects.toThrow("capture_flow_already_active");
    await resources.release();
    const next = await encounter.recorder(session, service.abort.signal); await next.release();
    expect(source.start).not.toHaveBeenCalled();
  });

  it("requires fresh authorization and native custody, with no browser queue fallback", async () => {
    const authorize = vi.fn(async () => undefined).mockRejectedValueOnce(new Error("revoked"));
    const service = connection({ reauthorizeRecorder: authorize }), encounter = await service.open();
    await expect(encounter.recorder(session, service.abort.signal)).rejects.toThrow("revoked");
    expect(sourceFactory.createProviderIOSCaptureSource).not.toHaveBeenCalled();
    native.list.mockRejectedValueOnce(new Error("native store unavailable"));
    await expect(encounter.recorder(session, service.abort.signal)).rejects.toThrow("native store unavailable");
    expect(rows.size).toBe(0);
    const recovered = await encounter.recorder(session, service.abort.signal); await recovered.release();
    service.abort.abort();
    await expect(encounter.recorder(session, service.abort.signal)).rejects.toThrow("provider_native_scope_unavailable");
    vi.mocked(Capacitor.isPluginAvailable).mockReturnValue(false);
    expect(() => createProviderIOSHost(connection().backend)).toThrow("provider_native_host_unavailable");
  });

  it("closes a late store open after revocation and makes the recorder lock available again", async () => {
    const open = EncryptedIndexedDbFlowStore.open.bind(EncryptedIndexedDbFlowStore);
    let resume!: () => void, opened = false;
    const wait = new Promise<void>(resolve => { resume = resolve; });
    vi.spyOn(EncryptedIndexedDbFlowStore, "open").mockImplementationOnce(async options => {
      const store = await open(options); opened = true; await wait; return store;
    });
    const service = connection(), encounter = await service.open();
    const pending = encounter.recorder(session, service.abort.signal);
    await vi.waitFor(() => expect(opened).toBe(true));
    service.abort.abort(); resume();
    await expect(pending).rejects.toThrow("provider_native_scope_unavailable");
    const next = connection(), resources = await (await next.open()).recorder(session, next.abort.signal);
    await resources.release(); expect(source.start).not.toHaveBeenCalled();
  });
});

it("retries server stop acknowledgement on the same iOS resources after native closure", async () => {
  const releaseNativeSource = vi.fn(async () => undefined);
  const service = connection({ releaseNativeSource }), encounter = await service.open();
  const resources = await encounter.recorder(session, service.abort.signal);
  source.stop.mockRejectedValueOnce(new Error("unconfirmed native stop"));
  await expect(resources.source.stop()).rejects.toThrow("unconfirmed native stop");
  expect(releaseNativeSource).not.toHaveBeenCalled();
  releaseNativeSource.mockRejectedValueOnce(new Error("lost server reply"));
  await expect(resources.source.stop()).rejects.toMatchObject({ code: "capture_stop_acknowledgement_pending" });
  await expect(encounter.recorder(session, service.abort.signal)).rejects.toThrow("capture_flow_already_active");
  await resources.source.stop();
  expect(releaseNativeSource.mock.calls).toEqual([[session], [session]]);
  await resources.release();
});

it.each(["recording", "interrupted", "expired"] as const)("holds mobile upload until server stop is confirmed (state=%s)", async state => {
  const server = createMockBffServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const bff = new HttpCaptureBff((input, init) => fetch(new URL(String(input), origin), init));
  const releaseNativeSource = vi.fn(async () => undefined);
  const uploadTarget = new HttpCiphertextUploadTarget([origin]);
  const upload = vi.spyOn(uploadTarget, "putCompleteEnvelope");
  const complete = vi.spyOn(bff, "completeCapture");
  const service = connection({ releaseNativeSource, uploadTarget });
  let controller: CaptureFlowController | undefined;
  let resources: Awaited<ReturnType<Awaited<ReturnType<typeof service.open>>["recorder"]>> | undefined;
  let capture: CaptureSourceStartOptions | undefined;
  let now = Date.now(), expire = (): void => undefined;
  try {
    const ids = { appointment_id: "synthetic-stop-appointment", practitioner_id: "synthetic-stop-provider",
      patient_id: "synthetic-stop-patient", modality: "in_person" as const };
    const consent = await bff.createConsent({ ...ids, method: "verbal_attestation", all_parties_consented: true,
      participant_regions: ["US-NY"], granted_at: new Date().toISOString() }, { idempotencyKey: "stop-consent-fixture-0001" });
    const admitted = await bff.createSession({ ...ids, consent_record_id: consent.id }, { idempotencyKey: "stop-session-fixture-0001" });
    resources = await (await service.open()).recorder(admitted.id, service.abort.signal);
    controller = new CaptureFlowController({ bff, flowStore: resources.flowStore,
      queue: new CaptureQueue(resources.queueStorage), source: resources.source,
      queueTransport: new BffCaptureQueueTransport(bff, resources.uploadTarget), now: () => new Date(now),
      scheduleTimeout: callback => { expire = callback; return callback; },
      cancelTimeout: handle => { if (handle === expire) expire = () => undefined; } });
    source.start.mockImplementationOnce(async (options: CaptureSourceStartOptions) => { capture = options; });
    await controller.prepareConfigured(admitted.id);
    await controller.startRecording();
    expect(service.mount.prepareNativeSource).toHaveBeenCalledTimes(1);
    const started = capture!;
    const profile = pcm16WavProfile(started.capabilities);
    await started.onChunk({ sequenceNumber: 0, durationMs: 20,
      wavBytes: encodePcm16MonoWav(new Int16Array(profile.sampleRateHz / 50), profile) });
    if (state === "interrupted") started.onInterruption?.("audio_session_interrupted");
    const retained = await resources.queueStorage.list();
    expect(retained.filter(row => row.state === "encrypted")).toHaveLength(1);
    releaseNativeSource.mockRejectedValueOnce(new Error("invented lost server stop reply"));
    if (state === "expired") {
      now = Date.parse((await resources.flowStore.getActiveCaptureState())!.captureAuthorizedUntil!) + 1;
      expire();
      await vi.waitFor(() => expect(controller!.snapshot.statusCode).toBe("capture_stop_acknowledgement_pending"));
    } else {
      await expect(controller.stopRecording()).rejects.toMatchObject({ code: "capture_stop_acknowledgement_pending" });
    }
    expect(controller.snapshot).toMatchObject({ state: "paused", recordedChunks: 1,
      statusCode: "capture_stop_acknowledgement_pending" });
    expect(await resources.flowStore.getActiveCaptureState()).toMatchObject({ phase: "paused", recordedChunks: 1 });
    expect(await resources.queueStorage.list()).toEqual(retained);
    expect(upload).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
    await expect((await service.open()).recorder(admitted.id, service.abort.signal)).rejects.toThrow("capture_flow_already_active");
    await controller.stopRecording();
    expect(controller.snapshot).toMatchObject({ state: "processing", recordedChunks: 1 });
    expect(source.start).toHaveBeenCalledTimes(1);
    expect(releaseNativeSource.mock.calls).toEqual([[admitted.id], [admitted.id]]);
    expect(upload).toHaveBeenCalledTimes(1); expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[1].channels).toEqual([{ channel: "microphone", final_sequence_number: 0 }]);
  } finally {
    releaseNativeSource.mockResolvedValue(undefined);
    await controller?.deactivate(); await resources?.release();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
