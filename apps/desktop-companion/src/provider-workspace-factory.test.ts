import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopProviderConnection, type DesktopProviderBackend, type DesktopProviderResources } from "./provider-workspace-factory.js";
import { DesktopProviderRecorder, type DesktopProviderRecorderOptions } from "./provider-recorder.js";
import type { ProviderProgress } from "../../capture/src/provider/workspace-journal";
import { InMemoryRecordingIndicator } from "./recording-indicator.js";

const workspaceId = "10000000-0000-4000-8000-000000000001", recoveryScope = "20000000-0000-4000-8000-000000000002";
const sessionId = "30000000-0000-4000-8000-000000000003";
const scope = { workspaceId, appointmentRef: "appointment_01j00000000000000000000000", bindingRef: "scribe_capture_binding_01j00000000000000000000000" };
const progress: ProviderProgress = { sessionId, uploaded: false, pendingSave: null,
  admission: { key: sessionId, languageMode: "en-US+es-US", attestation: { modality: "virtual", participant_regions: ["US-NY"],
    method: "verbal_attestation", all_parties_consented: true, granted_at: "2026-09-22T12:00:00Z" } } };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), "scribe-provider-factory-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
  const abort = new AbortController(), authorized = new AbortController();
  const release = vi.fn(async () => undefined), disposeBackend = vi.fn(async () => undefined);
  const authorizeRecorder = vi.fn(async () => ({ grant: { from: "invented server" }, status: "created" as const }));
  const authorizeStart = vi.fn(async () => ({ decision: "denied" }));
  const request = vi.fn(async (_path: string, body: Readonly<Record<string, unknown>>) => Response.json({
    contract_version: "1", binding_ref: body.binding_ref, workspace_id: body.workspace_id,
    request_nonce: body.request_nonce, checked_at: "2026-09-22T12:00:00Z",
    operation: (body.operation as { kind: string }).kind, receipt: { session_id: sessionId },
  }));
  const selected = { recoveryScope, scope: { ...scope }, signal: authorized.signal,
    encounter: { appointmentRef: scope.appointmentRef, title: "Invented visit", detail: "Invented all-party consent" },
    uploadTarget: { putCompleteEnvelope: vi.fn(async () => undefined) }, request,
    openInCore: vi.fn(async () => undefined), authorizeRecorder, authority: { authorizeStart } };
  const backend: DesktopProviderBackend = { signal: abort.signal, listEncounters: vi.fn(async () => [selected.encounter]),
    createEncounter: vi.fn(async () => undefined), openEncounter: vi.fn(async () => selected), dispose: disposeBackend };
  const resources: DesktopProviderResources = { enabled: true, directory,
    openCustody: vi.fn(async () => ({ key, release })), indicator: new InMemoryRecordingIndicator(),
    native: { helperPath: "/unused-invented-helper", helperSha256: "0".repeat(64), isSessionActive: () => true },
    selectWindow: vi.fn(async () => ({ application: "com.google.Chrome" as const, processID: 1, windowID: 1 })) };
  const connections: ReturnType<typeof createDesktopProviderConnection>[] = [];
  const connect = (overrides: Partial<DesktopProviderResources> = {}) => {
    const value = createDesktopProviderConnection(backend, { ...resources, ...overrides }, new AbortController().signal);
    connections.push(value); return value;
  };
  cleanup.push(async () => { for (const value of connections) await value.dispose(); });
  return { connect, resources, backend, selected, authorizeRecorder, authorizeStart, request, release, disposeBackend, abort, authorized, key };
}

describe("desktop provider resource factory", () => {
  it("reauthorizes before custody, recovers the journal, and rejects a replacement device key", async () => {
    const f = await fixture(), first = f.connect();
    const one = await first.workspace.openEncounter(scope.appointmentRef, new AbortController().signal);
    expect(f.backend.openEncounter).toHaveBeenCalledBefore(f.resources.openCustody as ReturnType<typeof vi.fn>);
    await one.journal.save(await one.journal.load(), progress);
    await first.dispose(); expect(f.release).toHaveBeenCalledTimes(1);
    const second = f.connect(), two = await second.workspace.openEncounter(scope.appointmentRef, new AbortController().signal);
    expect((await two.journal.load()).progress).toEqual(progress);
    await second.dispose();
    const wrongKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt", "wrapKey", "unwrapKey"]);
    const wrong = f.connect({ openCustody: async () => ({ key: wrongKey, release: f.release }) });
    await expect(wrong.workspace.openEncounter(scope.appointmentRef, new AbortController().signal)).rejects.toThrow();
    expect(f.release).toHaveBeenCalledTimes(3);
    expect(f.resources.selectWindow).not.toHaveBeenCalled();
  });

  it("owns a late custody result after access revocation, including synchronous backend cancellation", async () => {
    const f = await fixture(), gate = deferred<void>(), entered = deferred<void>();
    const connection = f.connect({ openCustody: async () => { entered.resolve(); await gate.promise; return { key: f.key, release: f.release }; } });
    const opening = connection.workspace.openEncounter(scope.appointmentRef, new AbortController().signal);
    const rejected = expect(opening).rejects.toThrow(); await entered.promise;
    f.authorized.abort(); const closing = connection.dispose();
    expect(f.release).not.toHaveBeenCalled(); gate.resolve(); await rejected; await closing;
    expect(f.release).toHaveBeenCalledTimes(1); expect(f.disposeBackend).toHaveBeenCalledTimes(1);
    const g = await fixture();
    vi.mocked(g.backend.openEncounter).mockImplementation(async (_ref, signal) => {
      g.abort.abort(); expect(signal.aborted).toBe(true); return g.selected;
    });
    const cancelled = g.connect();
    await expect(cancelled.workspace.openEncounter(scope.appointmentRef, new AbortController().signal)).rejects.toThrow();
    await cancelled.dispose(); expect(g.resources.openCustody).not.toHaveBeenCalled();
  });

  it("binds the recorder to retained admission and Core scope without starting a picker or inventing authority", async () => {
    const f = await fixture(), connection = f.connect();
    const opened = await connection.workspace.openEncounter(scope.appointmentRef, new AbortController().signal);
    let options!: DesktopProviderRecorderOptions;
    const stop = vi.fn(async () => undefined);
    const recorder = { availableForView: true, deactivate: stop } as unknown as DesktopProviderRecorder;
    const create = vi.spyOn(DesktopProviderRecorder, "open").mockImplementation(async value => { options = value; return recorder; });
    await expect(opened.recorder(sessionId, new AbortController().signal)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    await opened.journal.save(await opened.journal.load(), progress);
    f.selected.scope.workspaceId = crypto.randomUUID(); // A late backend mutation cannot select another store or request scope.
    await opened.recorder(sessionId, new AbortController().signal);
    await options.authorizeMount(options.signal);
    expect(f.authorizeRecorder).toHaveBeenCalledWith(sessionId, options.signal);
    await options.createBff(options.signal).getCapabilities(sessionId);
    expect(f.request).toHaveBeenCalledWith("/service/v1/agent/scribe/capture-operations",
      expect.objectContaining({ workspace_id: workspaceId, binding_ref: scope.bindingRef, operation: { kind: "capabilities" } }),
      expect.any(String), expect.any(AbortSignal));
    expect(options.authority).toBe(f.selected.authority); expect(f.authorizeStart).not.toHaveBeenCalled();
    expect(f.resources.selectWindow).not.toHaveBeenCalled();
    await options.release(); expect((await opened.journal.load()).progress).toEqual(progress);
    await connection.dispose(); expect(stop).toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("retains custody after an unconfirmed native stop and blocks encounter replacement until retry", async () => {
    const f = await fixture(), connection = f.connect();
    const opened = await connection.workspace.openEncounter(scope.appointmentRef, new AbortController().signal);
    await opened.journal.save(await opened.journal.load(), progress);
    let refuse = true;
    vi.spyOn(DesktopProviderRecorder, "open").mockResolvedValue({ availableForView: true,
      deactivate: async () => { if (refuse) throw new Error("invented failed stop"); },
    } as unknown as DesktopProviderRecorder);
    await opened.recorder(sessionId, new AbortController().signal);
    await expect(connection.workspace.listEncounters(new AbortController().signal)).rejects.toThrow();
    expect(f.backend.listEncounters).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
    await expect(connection.dispose()).rejects.toThrow(); expect(f.disposeBackend).not.toHaveBeenCalled();
    refuse = false; await connection.dispose();
    expect(f.release).toHaveBeenCalledTimes(1); expect(f.disposeBackend).toHaveBeenCalledTimes(1);
  });
});
