import { webcrypto } from "node:crypto";
import { Capacitor } from "@capacitor/core";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeChunkAdditionalDataBase64Url, PROTOCOL_VERSION } from "@cosmaneura-scribe/capture-protocol";
import type { SecureQueueCompareAndSwapOptions, SecureQueueRecord } from "@cosmaneura-scribe/capacitor-secure-queue";
import { createReservedRecord } from "../queue/records";
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
  let locked = false;
  const locks: CaptureFlowLockManager = { request: async (name, _options, callback) => {
    if (locked) return callback(null);
    locked = true;
    try { return await callback({ name, mode: "exclusive" }); }
    finally { locked = false; }
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
