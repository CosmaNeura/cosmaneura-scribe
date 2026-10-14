import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopProviderConnection, type DesktopProviderBackend, type DesktopProviderResources } from "./provider-workspace-factory.js";
import { DesktopProviderRecorder, type DesktopProviderRecorderOptions } from "./provider-recorder.js";
import type { ProviderProgress } from "../../capture/src/provider/workspace-journal";
import { InMemoryRecordingIndicator } from "./recording-indicator.js";
import type { NativePresentationEvent } from "./native-provider-presentation.js";
import { DesktopPreparationBff } from "./preparation-metadata.js";
import { CoreCaptureClient } from "../../capture/src/provider/core-client";
import { claimDesktopInitialWindow, type DesktopInitialWindowProof } from "./desktop-initial-window.js";
import { DesktopRecordNamespace } from "./durable-record-store.js";
import type { ConfiguredCapturePreparationState, SessionKeyBindingState } from "../../capture/src/flow/types";

const workspaceId = "10000000-0000-4000-8000-000000000001", recoveryScope = "20000000-0000-4000-8000-000000000002";
const sessionId = "30000000-0000-4000-8000-000000000003";
const scope = { workspaceId, appointmentRef: "appointment_01j00000000000000000000000", bindingRef: "scribe_capture_binding_01j00000000000000000000000" };
const progress: ProviderProgress = { sessionId, uploaded: false, pendingSave: null,
  admission: { key: sessionId, languageMode: "en-US+es-US", attestation: { modality: "virtual", participant_regions: ["US-NY"],
    method: "verbal_attestation", all_parties_consented: true, granted_at: "2026-09-22T12:00:00Z" } } };
const cleanup: (() => Promise<void>)[] = [];
let initialWindowJwk: Promise<JsonWebKey> | undefined;
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
    operation: (body.operation as { kind: string }).kind,
    receipt: (body.operation as { kind: string }).kind === "preparation_metadata" ? { schema_version: "1.0",
      review: { schema_version: "1.0", session_id: sessionId, status: "created", source: null, working: null, review_queue: null, translation_progress: [] },
      encryption_key: { key_version: "synthetic-key", algorithm: "RSA-OAEP-256", public_jwk: { kty: "RSA", n: "a".repeat(512), e: "AQAB", alg: "RSA-OAEP-256", ext: true, key_ops: ["wrapKey"] } },
      capabilities: { protocol_version: "1.0", media: { media_type: "audio/wav", encoding: "pcm_s16le", channels: 1, sample_rate_hz: 16000 },
        target_chunk_duration_ms: 10000, max_envelope_bytes: 327680, max_chunks: 1000, remaining_aggregate_plaintext_bytes: 67108864,
        capture_lease_ttl_seconds: 900, reservation_window_seconds: 900, max_reservations_per_batch: 90, upload_concurrency: 2 } }
      : (body.operation as { kind: string }).kind === "creator_review"
      ? { schema_version: "1.0", session_id: sessionId, status: "created", source: null,
        working: null, review_queue: null, translation_progress: [] } : { session_id: sessionId },
  }));
  const selected = { recoveryScope, scope: { ...scope }, signal: authorized.signal,
    encounter: { appointmentRef: scope.appointmentRef, title: "Invented visit", detail: "Invented all-party consent" },
    uploadTarget: { putCompleteEnvelope: vi.fn(async () => undefined) }, request,
    openInCore: vi.fn(async () => undefined), retireSource: vi.fn(async () => undefined), authorizeRecorder, authority: { authorizeStart } };
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
  it.each(["fresh", "consent_uncertain", "session_uncertain", "input_uncertain", "initial_preparation_uncertain", "key_uncertain", "recipe_uncertain", "old_reply", "missing_status", "missing_configuration", "configuration_mismatch", "extra_optional_field", "cancelled"])(
    "uses the real encrypted custody witness and preserves recovery keys: %s", async mode => {
      const f = await fixture();
      initialWindowJwk ??= crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 3072,
        publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["wrapKey", "unwrapKey"])
        .then(pair => crypto.subtle.exportKey("jwk", pair.publicKey));
      const publishedJwk = await initialWindowJwk;
      const original = f.request.getMockImplementation()!;
      const fresh = vi.fn(async (proof: DesktopInitialWindowProof, body: Readonly<Record<string, unknown>>, key: string, signal: AbortSignal) => {
        expect(signal.aborted).toBe(false);
        const admission = claimDesktopInitialWindow(proof, { scope, body, key });
        expect(admission.key).toBe(progress.admission.key); expect(admission.receipt.session_id).toBe(sessionId);
        expect(admission.receipt.preparation_metadata).toBeDefined();
        return original("/service/v1/agent/scribe/capture-operations", body);
      });
      vi.mocked(f.backend.openEncounter).mockResolvedValue({ ...f.selected, admissionMetadataSupported: true, sendFreshInitialWindow: fresh });
      f.request.mockImplementation(async (path, body) => {
        if (path.endsWith("capture-admissions")) {
          const metadata = (await (await original("/service/v1/agent/scribe/capture-operations", { ...body, operation: { kind: "preparation_metadata" } })).json()).receipt;
          metadata.encryption_key.public_jwk = publishedJwk;
          const answer: Record<string, unknown> = { contract_version: "1", binding_ref: body.binding_ref, workspace_id: body.workspace_id,
            request_nonce: body.request_nonce, checked_at: new Date().toISOString(), appointment_ref: scope.appointmentRef,
            operation_ref: "scribe_admission_01j00000000000000000000000", consent_record_id: crypto.randomUUID(), session_id: sessionId,
            status: "admitted", configured_capture: body.configured_capture, preparation_metadata: metadata };
          if (mode === "old_reply" || mode === "missing_status") delete answer.status;
          if (mode === "old_reply" || mode === "missing_configuration") delete answer.configured_capture;
          if (mode === "configuration_mismatch") answer.configured_capture = { schema_version: "1.0", language_mode: "es-US" };
          if (mode === "extra_optional_field") answer.unused_extension = true;
          return Response.json(answer);
        }
        const reply = await original(path, body);
        if ((body.operation as { kind?: string }).kind !== "preparation_metadata") return reply;
        const data = await reply.json(); data.receipt.encryption_key.public_jwk = publishedJwk;
        return Response.json(data);
      });
      const connection = f.connect(), opened = await connection.workspace.openEncounter(scope.appointmentRef, new AbortController().signal);
      let injected = false;
      // The captured prototype is explicitly called with each live tested namespace.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const save = DesktopRecordNamespace.prototype.save;
      vi.spyOn(DesktopRecordNamespace.prototype, "save").mockImplementation(async function (this: DesktopRecordNamespace, key, previous, bytes) {
        const revision = await save.call(this, key, previous, bytes);
        const target = mode === "consent_uncertain" ? key.startsWith("provider-workspace-v1:") && previous === null
          : mode === "session_uncertain" ? key.startsWith("provider-workspace-v1:") && previous !== null
          : mode === "input_uncertain" ? key === `audio-mode:${sessionId}`
          : mode === "initial_preparation_uncertain" ? key === "preparation" && previous === null
          : mode === "key_uncertain" ? key === `session:${sessionId}`
          : mode === "recipe_uncertain" ? key === "preparation" && previous !== null : false;
        if (target && !injected) { injected = true; throw new Error("fictional committed-then-thrown write"); }
        return revision;
      });
      const first = opened.journal.save(await opened.journal.load(), { ...progress, sessionId: null });
      if (mode === "consent_uncertain") await expect(first).rejects.toThrow(); else await first;
      expect((await opened.journal.load()).progress?.sessionId).toBeNull();
      const client = new CoreCaptureClient(scope, opened.request, new AbortController().signal);
      expect(await client.admit(progress.admission)).toBe(sessionId);
      const admitted = opened.journal.save(await opened.journal.load(), progress);
      if (mode === "session_uncertain") await expect(admitted).rejects.toThrow(); else await admitted;
      expect((await opened.journal.load()).progress?.sessionId).toBe(sessionId);
      let options!: DesktopProviderRecorderOptions;
      vi.spyOn(DesktopProviderRecorder, "open").mockImplementation(async value => {
        options = value; return { availableForView: true, deactivate: async () => undefined } as unknown as DesktopProviderRecorder;
      });
      const opening = opened.recorder(sessionId, new AbortController().signal);
      if (mode === "input_uncertain") {
        await expect(opening).rejects.toThrow();
        await opened.recorder(sessionId, new AbortController().signal);
      } else await opening;
      expect(await options.authorizePreparation(options.signal)).toEqual({ sessionId, status: "created" });
      const initial: ConfiguredCapturePreparationState = { mode: "configured_core", schemaVersion: 6, channel: "mixed", sessionId,
        startedAt: new Date().toISOString(), completeIdempotencyKey: "complete:" + crypto.randomUUID(), leaseIdempotencyKey: null,
        leaseRequest: null, windowPreparation: null };
      const preparing = options.flowStore.putPreparationState(initial);
      if (mode === "initial_preparation_uncertain") await expect(preparing).rejects.toThrow(); else await preparing;
      expect(await options.flowStore.getPreparationState()).toEqual(initial);
      const bff = options.createBff(options.signal), published = await bff.getAudioEncryptionKey();
      const candidate = await options.createSessionKey(sessionId, published, crypto);
      const state: SessionKeyBindingState = { schemaVersion: 2, sessionId, state: "pending", keyVersion: candidate.keyVersion,
        wrappedDek: candidate.wrappedDek, idempotencyKey: "bind-key:" + crypto.randomUUID() };
      const custody = options.flowStore.putSessionKeyCandidate(state, candidate.key);
      if (mode === "key_uncertain") await expect(custody).rejects.toThrow(); else await custody;
      expect(await options.flowStore.getSessionKeyState(sessionId)).toEqual(state);
      expect(await options.flowStore.getSessionKey(sessionId)).not.toBeNull();
      const recipe: ConfiguredCapturePreparationState = { ...initial, leaseIdempotencyKey: "lease:" + crypto.randomUUID(),
        leaseRequest: { protocol_version: "1.0" }, windowPreparation: { idempotencyKey: "prepare-window:" + crypto.randomUUID(),
          bindIdempotencyKey: state.idempotencyKey, reserveIdempotencyKey: "reserve:" + crypto.randomUUID(), keyVersion: state.keyVersion,
          wrappedDek: state.wrappedDek, reservationCount: 30, aggregatePlaintextBudgetBytes: 67108864 } };
      const savedRecipe = options.flowStore.putPreparationState(recipe);
      if (mode === "recipe_uncertain") await expect(savedRecipe).rejects.toThrow(); else await savedRecipe;
      expect(await options.flowStore.getPreparationState()).toEqual(recipe);
      if (mode === "cancelled") {
        f.authorized.abort(); await expect(bff.prepareRecordingWindow!(sessionId, { schema_version: "1.0",
          binding: { key_version: state.keyVersion, wrapped_dek: state.wrappedDek }, bind_idempotency_key: state.idempotencyKey,
          lease_idempotency_key: recipe.leaseIdempotencyKey!, reserve_idempotency_key: recipe.windowPreparation!.reserveIdempotencyKey,
          channel: "mixed", reservation_count: 30 }, { idempotencyKey: recipe.windowPreparation!.idempotencyKey })).rejects.toThrow();
        expect(fresh).not.toHaveBeenCalled(); return;
      }
      const window = { schema_version: "1.0" as const, binding: { key_version: state.keyVersion, wrapped_dek: state.wrappedDek },
        bind_idempotency_key: state.idempotencyKey, lease_idempotency_key: recipe.leaseIdempotencyKey!,
        reserve_idempotency_key: recipe.windowPreparation!.reserveIdempotencyKey, channel: "mixed" as const, reservation_count: 30 };
      // Explicit continuation after uncertainty preserves the exact durable recipe.
      await bff.prepareRecordingWindow!(sessionId, window, { idempotencyKey: recipe.windowPreparation!.idempotencyKey });
      expect(fresh).toHaveBeenCalledTimes(mode === "fresh" ? 1 : 0);
      expect(await options.flowStore.getSessionKeyState(sessionId)).toEqual(state);
      expect(await options.flowStore.getPreparationState()).toEqual(recipe);
      await bff.prepareRecordingWindow!(sessionId, window, { idempotencyKey: recipe.windowPreparation!.idempotencyKey });
      expect(fresh).toHaveBeenCalledTimes(mode === "fresh" ? 1 : 0);
      expect(f.authorizeStart).not.toHaveBeenCalled(); expect(f.resources.selectWindow).not.toHaveBeenCalled();
    });
  it.each(["fresh", "retained", "cancelled", "cancelled_during_open", "foreign_receipt"])("uses admission metadata only for its current fresh recorder: %s", async mode => {
    const f = await fixture();
    vi.mocked(f.backend.openEncounter).mockResolvedValue({ ...f.selected, admissionMetadataSupported: true });
    const original = f.request.getMockImplementation()!;
    const attempt = new AbortController();
    f.request.mockImplementationOnce(async (_path, body) => {
      expect(body.preparation_metadata).toBe(true);
      const metadata = (await (await original("/service/v1/agent/scribe/capture-operations", { ...body, operation: { kind: "preparation_metadata" } })).json()).receipt;
      return Response.json({ contract_version: "1", binding_ref: body.binding_ref, workspace_id: body.workspace_id,
        request_nonce: mode === "foreign_receipt" ? crypto.randomUUID() : body.request_nonce,
        checked_at: new Date().toISOString(), appointment_ref: scope.appointmentRef, operation_ref: "scribe_admission_01j00000000000000000000000",
        consent_record_id: crypto.randomUUID(), session_id: sessionId, preparation_metadata: metadata });
    });
    const connection = f.connect(), opened = await connection.workspace.openEncounter(scope.appointmentRef, new AbortController().signal);
    const intent = progress.admission;
    await opened.journal.save(await opened.journal.load(), { ...progress, sessionId: null });
    const client = new CoreCaptureClient(scope, opened.request, attempt.signal);
    if (mode === "foreign_receipt") { await expect(client.admit(intent)).rejects.toThrow(); expect(f.request).toHaveBeenCalledOnce(); return; }
    expect(await client.admit(intent)).toBe(sessionId);
    if (mode === "cancelled") attempt.abort();
    await opened.journal.save(await opened.journal.load(), progress);
    let options!: DesktopProviderRecorderOptions;
    vi.spyOn(DesktopProviderRecorder, "open").mockImplementation(async value => {
      options = value; return { availableForView: true, deactivate: async () => undefined } as unknown as DesktopProviderRecorder;
    });
    await opened.recorder(sessionId, new AbortController().signal);
    if (mode === "cancelled_during_open") attempt.abort();
    if (mode === "retained") await options.flowStore.putPreparationState({ mode: "configured_core", schemaVersion: 6, channel: "mixed",
      sessionId, startedAt: new Date().toISOString(), completeIdempotencyKey: "synthetic-complete",
      leaseIdempotencyKey: null, leaseRequest: null, windowPreparation: null });
    expect(await options.authorizePreparation(options.signal)).toEqual({ sessionId, status: "created" });
    expect(f.request.mock.calls).toHaveLength(mode === "fresh" ? 1 : 2);
    if (mode === "fresh") {
      expect(await options.createBff(options.signal).getAudioEncryptionKey()).toMatchObject({ key_version: "synthetic-key" });
      expect(await options.createBff(options.signal).getCapabilities(sessionId)).toMatchObject({ protocol_version: "1.0" });
      expect(f.request).toHaveBeenCalledOnce();
    }
    expect(f.authorizeStart).not.toHaveBeenCalled(); expect(f.resources.selectWindow).not.toHaveBeenCalled();
  });
  it("refuses a renderer-supplied admission option before backend I/O", async () => {
    const f = await fixture(), opened = await f.connect().workspace.openEncounter(scope.appointmentRef, new AbortController().signal);
    await expect(opened.request("/service/v1/agent/scribe/capture-admissions", { preparation_metadata: true }, sessionId, new AbortController().signal)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([false, true])("uses combined metadata only before any encrypted preparation exists: retained=%s", async retained => {
    const f = await fixture(), connection = f.connect();
    const opened = await connection.workspace.openEncounter(scope.appointmentRef, new AbortController().signal);
    await opened.journal.save(await opened.journal.load(), progress);
    let options!: DesktopProviderRecorderOptions;
    vi.spyOn(DesktopProviderRecorder, "open").mockImplementation(async value => {
      options = value;
      return { availableForView: true, deactivate: async () => undefined } as unknown as DesktopProviderRecorder;
    });
    await opened.recorder(sessionId, new AbortController().signal);
    if (retained) await options.flowStore.putPreparationState({ mode: "configured_core", schemaVersion: 6, channel: "mixed",
      sessionId, startedAt: new Date().toISOString(), completeIdempotencyKey: "synthetic-complete",
      leaseIdempotencyKey: null, leaseRequest: null, windowPreparation: null });
    const authorization = vi.spyOn(DesktopPreparationBff.prototype, "authorizePreparation");
    expect(await options.authorizePreparation(options.signal)).toEqual({ sessionId, status: "created" });
    expect(authorization).toHaveBeenCalledWith(!retained);
    expect(f.request.mock.calls.map(call => (call[1].operation as { kind: string }).kind).sort())
      .toEqual(retained ? ["creator_review"] : ["preparation_metadata"]);
    await connection.dispose(); expect(f.release).toHaveBeenCalledOnce();
  });
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
    const f = await fixture(), connection = f.connect({ prepareInBackground: true });
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
    expect(await options.authorizePreparation(options.signal)).toEqual({ sessionId, status: "created" });
    expect(f.request).toHaveBeenCalledWith("/service/v1/agent/scribe/capture-operations",
      expect.objectContaining({ workspace_id: workspaceId, binding_ref: scope.bindingRef, operation: { kind: "preparation_metadata" } }),
      expect.any(String), expect.any(AbortSignal));
    const prepared = { sessionId, captureLeaseId: crypto.randomUUID(), leaseReceiptId: crypto.randomUUID(),
      captureLeaseGeneration: 1, captureAuthorizedUntil: new Date(Date.now() + 60_000).toISOString() };
    await options.authorizeMount(prepared, options.signal);
    expect(f.authorizeRecorder).toHaveBeenCalledWith(prepared, options.signal);
    await options.createBff(options.signal).getCapabilities(sessionId);
    await options.createBff(options.signal).getCapabilities(sessionId);
    expect(f.request).toHaveBeenCalledWith("/service/v1/agent/scribe/capture-operations",
      expect.objectContaining({ workspace_id: workspaceId, binding_ref: scope.bindingRef, operation: { kind: "capabilities" } }),
      expect.any(String), expect.any(AbortSignal));
    expect(options.prepareInBackground).toBe(true);
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

  it("routes native Stop only to the current recorder and closes presentation with its connection", async () => {
    const f = await fixture();
    let listener!: (event: NativePresentationEvent) => void;
    const dispose = vi.fn(async () => undefined), unsubscribe = vi.fn();
    const connection = f.connect({ presentation: { isHealthy: () => true, dispose,
      onEvent: next => { listener = next; return unsubscribe; } } });
    const opened = await connection.workspace.openEncounter(scope.appointmentRef, new AbortController().signal);
    await opened.journal.save(await opened.journal.load(), progress);
    const stopRecording = vi.fn(async () => undefined), deactivate = vi.fn(async () => undefined);
    vi.spyOn(DesktopProviderRecorder, "open").mockResolvedValue({ availableForView: true,
      snapshot: { sessionId }, stopRecording, deactivate } as unknown as DesktopProviderRecorder);
    await opened.recorder(sessionId, new AbortController().signal);
    listener({ kind: "stop_requested", sessionId: crypto.randomUUID() }); expect(stopRecording).not.toHaveBeenCalled();
    listener({ kind: "stop_requested", sessionId }); expect(stopRecording).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    await connection.dispose(); expect(dispose).toHaveBeenCalledAfter(deactivate); expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("closes an idle workspace when its presentation fails so the app can offer connection recovery", async () => {
    const f = await fixture();
    let listener!: (event: NativePresentationEvent) => void, healthy = true;
    const dispose = vi.fn(async () => undefined), unsubscribe = vi.fn();
    const connection = f.connect({ presentation: { isHealthy: () => healthy, dispose,
      onEvent: next => { listener = next; return unsubscribe; } } });
    await connection.workspace.listEncounters(new AbortController().signal);
    listener({ kind: "stop_requested", sessionId });
    expect(connection.workspace.signal.aborted).toBe(false);
    healthy = false; listener({ kind: "failed", sessionId: null });
    expect(connection.workspace.signal.aborted).toBe(true);
    await expect(connection.workspace.listEncounters(new AbortController().signal)).rejects.toThrow();
    await connection.dispose();
    expect(f.backend.listEncounters).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1); expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.disposeBackend).toHaveBeenCalledTimes(1);
    expect(f.resources.openCustody).not.toHaveBeenCalled();
    expect(f.resources.selectWindow).not.toHaveBeenCalled();
  });

  it("revokes capture on presentation failure but retains custody/presentation until source-stop retry succeeds", async () => {
    const f = await fixture();
    let listener!: (event: NativePresentationEvent) => void, healthy = true, refuse = true;
    const dispose = vi.fn(async () => undefined);
    const connection = f.connect({ presentation: { isHealthy: () => healthy, dispose,
      onEvent: next => { listener = next; return () => undefined; } } });
    const opened = await connection.workspace.openEncounter(scope.appointmentRef, new AbortController().signal);
    await opened.journal.save(await opened.journal.load(), progress);
    let options!: DesktopProviderRecorderOptions;
    const deactivate = vi.fn(async () => { if (refuse) throw new Error("invented unconfirmed stop"); });
    vi.spyOn(DesktopProviderRecorder, "open").mockImplementation(async value => {
      options = value; return { availableForView: true, snapshot: { sessionId }, deactivate } as unknown as DesktopProviderRecorder;
    });
    await opened.recorder(sessionId, new AbortController().signal);
    healthy = false; listener({ kind: "failed", sessionId });
    expect(connection.workspace.signal.aborted).toBe(true);
    expect(opened.signal.aborted).toBe(true); expect(options.native.isSessionActive()).toBe(false);
    await expect(connection.dispose()).rejects.toThrow();
    expect(f.release).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
    refuse = false; await connection.dispose();
    expect(f.release).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1);
  });
});

it("preserves the opening timestamp while acquiring existing desktop custody", async () => {
  const f = await fixture(), openingReview = { scope: { ...scope }, receivedAt: Date.now() - 100, view: null };
  vi.mocked(f.backend.openEncounter).mockResolvedValue({ ...f.selected, openingReview, noteOpeningSupported: true });
  const opened = await f.connect().workspace.openEncounter(scope.appointmentRef, new AbortController().signal);
  expect(opened.openingReview).toEqual(openingReview);
  expect(opened.noteOpeningSupported).toBe(true);
  expect(f.authorizeRecorder).not.toHaveBeenCalled();
  expect(f.resources.selectWindow).not.toHaveBeenCalled();
});

it("reauthorizes passage review, refuses a foreign session or segment, and suppresses revoked replies", async () => {
  const f = await fixture(), opened = await f.connect().workspace.openEncounter(scope.appointmentRef, new AbortController().signal);
  await opened.journal.save(await opened.journal.load(), { ...progress, uploaded: true });
  const operation = new AbortController().signal, segment = crypto.randomUUID();
  await expect(opened.playPassage!(crypto.randomUUID(), segment, operation)).rejects.toThrow();
  expect(f.request).not.toHaveBeenCalled();
  expect(await opened.playPassage!(sessionId, segment, operation)).toBeNull();
  expect(f.request).toHaveBeenCalledOnce();
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementationOnce(async (...args) => { const value = await original(...args); f.authorized.abort(); return value; });
  await expect(opened.playPassage!(sessionId, segment, operation)).rejects.toThrow();
});

it.each(["opening", "ready"])("suppresses a delayed passage when a recorder becomes %s", async phase => {
  const f = await fixture(), opened = await f.connect().workspace.openEncounter(scope.appointmentRef, new AbortController().signal);
  await opened.journal.save(await opened.journal.load(), { ...progress, uploaded: true });
  const response = deferred<void>(), reviewing = deferred<void>(), opening = deferred<void>(), prepared = deferred<void>();
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementationOnce(async (...args) => { reviewing.resolve(); await response.promise; return original(...args); });
  vi.spyOn(DesktopProviderRecorder, "open").mockImplementation(async () => {
    opening.resolve(); if (phase === "opening") await prepared.promise;
    return { availableForView: true, snapshot: { desktop: { phase: "ready" } }, deactivate: async () => undefined } as unknown as DesktopProviderRecorder;
  });
  const playback = opened.playPassage!(sessionId, crypto.randomUUID(), new AbortController().signal);
  const rejected = expect(playback).rejects.toThrow(); await reviewing.promise;
  const recorder = opened.recorder(sessionId, new AbortController().signal);
  await opening.promise; if (phase === "ready") await recorder;
  response.resolve(); await rejected; prepared.resolve(); await recorder;
  expect(f.authorizeStart).not.toHaveBeenCalled();
});

it("suppresses a delayed passage if the existing ready recorder starts capturing", async () => {
  const f = await fixture(), opened = await f.connect().workspace.openEncounter(scope.appointmentRef, new AbortController().signal);
  await opened.journal.save(await opened.journal.load(), { ...progress, uploaded: true });
  const snapshot = { desktop: { phase: "ready" } };
  vi.spyOn(DesktopProviderRecorder, "open").mockResolvedValue({ availableForView: true, snapshot,
    deactivate: async () => undefined } as unknown as DesktopProviderRecorder);
  await opened.recorder(sessionId, new AbortController().signal);
  const response = deferred<void>(), reviewing = deferred<void>(), original = f.request.getMockImplementation()!;
  f.request.mockImplementationOnce(async (...args) => { reviewing.resolve(); await response.promise; return original(...args); });
  const playback = opened.playPassage!(sessionId, crypto.randomUUID(), new AbortController().signal);
  const rejected = expect(playback).rejects.toThrow(); await reviewing.promise;
  snapshot.desktop.phase = "recording"; response.resolve(); await rejected;
});
