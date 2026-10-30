import { expect, it, vi } from "vitest";
import { connectDesktopNativeBackend } from "./native-provider-backend.js";
import type { NativeProviderClient } from "./native-provider-client.js";
import type { CreationRecords } from "../../capture/src/provider/encounter-setup.js";

function catalogFixture() {
  const abort = new AbortController(), revision = crypto.randomUUID(), scope = crypto.randomUUID();
  const appointmentRef = "appointment_01j00000000000000000000000";
  const catalog: Record<string, unknown> = { revision, recoveryScope: scope, encounter_creation_v1: true,
    account: { email: "provider@synthetic.invalid" }, environment: "Staging",
    encounters: [{ workspaceId: crypto.randomUUID(), appointmentRef, title: "Synthetic visit", detail: "" }] };
  const key = "provider-hidden-visits-v1:" + scope;
  const records: CreationRecords = { get: vi.fn(async () => ({ key, revision: "1",
    data: btoa(JSON.stringify({ version: 1, recoveryScope: scope, refs: [appointmentRef] })) })),
    create: vi.fn(), compareAndSwap: vi.fn() };
  const request = vi.fn(async (_method: string, payload: Record<string, unknown>) => ({ status: 200,
    body: JSON.stringify(payload.action === "catalog" ? catalog : { revision, recoveryScope: scope,
      account: catalog.account, patients: [], more_results: false }) }));
  const native = { signal: abort.signal, request, isReady: () => !abort.signal.aborted,
    getState: async () => ({ phase: "ready", revision }), addListener: async () => ({ remove: async () => undefined }) } as unknown as NativeProviderClient;
  const open = () => connectDesktopNativeBackend(native, { signal: abort.signal, openCore: async () => undefined,
    uploadTarget: { putCompleteEnvelope: async () => undefined }, creationRecords: async () => ({ records, close: async () => undefined }) });
  return { abort, catalog, scope, records, request, appointmentRef, open };
}

it("keeps hidden visits filtered after current catalog without an additional provider request", async () => {
  const f = catalogFixture(), backend = await f.open();
  try {
    await backend.listEncounters(backend.signal);
    expect(await backend.encounterSetup!.hidden!(backend.signal)).toEqual([f.appointmentRef]);
    await backend.listEncounters(backend.signal);
    expect(await backend.encounterSetup!.hidden!(backend.signal)).toEqual([f.appointmentRef]);
    expect(f.request.mock.calls.map(([, value]) => value.action)).toEqual(["catalog", "catalog"]);
  } finally { await backend.dispose(); }
});

it("uses the original empty-patient fallback only when an older catalog omits its scope", async () => {
  const f = catalogFixture(), backend = await f.open(); delete f.catalog.recoveryScope;
  try {
    await backend.listEncounters(backend.signal);
    expect(await backend.encounterSetup!.hidden!(backend.signal)).toEqual([f.appointmentRef]);
    expect(f.request.mock.calls.map(([, value]) => value.action)).toEqual(["catalog", "encounters"]);
    expect(JSON.parse(f.request.mock.calls[1]![1].body as string)).toMatchObject({ action: "patients", query: "" });
  } finally { await backend.dispose(); }
});

it.each(["scope", "account", "revision", "cancel"])("refuses a changed catalog %s before publishing new account or hidden custody", async change => {
  const f = catalogFixture(), backend = await f.open();
  try {
    await backend.listEncounters(backend.signal);
    if (change === "scope") f.catalog.recoveryScope = crypto.randomUUID();
    if (change === "account") f.catalog.account = { email: "foreign@synthetic.invalid" };
    if (change === "revision") f.catalog.revision = crypto.randomUUID();
    if (change === "cancel") f.abort.abort();
    await expect(backend.listEncounters(backend.signal)).rejects.toThrow();
    expect(backend.account?.email).toBe("provider@synthetic.invalid");
    expect(f.records.get).not.toHaveBeenCalled();
    expect(f.request.mock.calls.every(([, value]) => value.action === "catalog")).toBe(true);
  } finally { await backend.dispose(); }
});

it.each([null, "", "not-a-uuid", 7])("rejects malformed present catalog scope (%s) without patient fallback", async scope => {
  const f = catalogFixture(), backend = await f.open(); f.catalog.recoveryScope = scope;
  try {
    await expect(backend.listEncounters(backend.signal)).rejects.toThrow();
    expect(backend.account).toBeUndefined(); expect(f.records.get).not.toHaveBeenCalled();
    expect(f.request.mock.calls.map(([, value]) => value.action)).toEqual(["catalog"]);
  } finally { await backend.dispose(); }
});

function preparedReply(grant: Record<string, unknown>) {
  return { grant, processFence: { epoch: crypto.randomUUID(), coordinatorDevice: "1",
    coordinatorInode: "2", captureDevice: "1", captureInode: "3" } };
}

it.each([false, true])("keeps admission RPC alive with its key, cancellation and negotiated metadata support (%s)", async supported => {
  const signal = new AbortController().signal, attempt = new AbortController();
  const revision = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const id = "01j" + "0".repeat(23), appointmentRef = "appointment_" + id, bindingRef = "scribe_capture_binding_" + id;
  const encounter = { appointmentRef, title: "Invented visit", detail: "Admission budget fixture" };
  const calls: { payload: Record<string, unknown>; signal: AbortSignal | undefined; timeout: number | undefined }[] = [];
  const request = vi.fn(async (_method: string, payload: Record<string, unknown>, operationSignal?: AbortSignal, timeout?: number) => {
    calls.push({ payload, signal: operationSignal, timeout });
    return { status: 200, body: JSON.stringify(payload.action === "catalog"
      ? { revision, encounters: [{ ...encounter, workspaceId }] }
      : { revision, workspaceId, appointmentRef, bindingRef, encounter: { ...encounter, admission_metadata_v1: supported }, recoveryScope: crypto.randomUUID() }) };
  });
  const native = { signal, request, isReady: () => true, getState: async () => ({ phase: "ready", revision }),
    addListener: async () => ({ remove: async () => undefined }) } as unknown as NativeProviderClient;
  const backend = await connectDesktopNativeBackend(native, { signal, openCore: async () => undefined,
    uploadTarget: { putCompleteEnvelope: async () => undefined } });
  await backend.listEncounters(signal);
  const mount = await backend.openEncounter(appointmentRef, signal);
  expect(mount.admissionMetadataSupported).toBe(supported ? true : undefined);
  const body = { workspace_id: workspaceId, binding_ref: bindingRef, attestation: null };
  await mount.request("/service/v1/agent/scribe/capture-admissions", body, "retained-admission-key", attempt.signal);
  const admission = calls.at(-1)!;
  expect(admission.timeout).toBeGreaterThan(210_000); // Native resource deadline.
  expect(admission.payload.key).toBe("retained-admission-key");
  expect(JSON.parse(admission.payload.body as string)).toEqual(body);
  expect(calls.slice(0, -1).every(call => call.timeout === 35_000)).toBe(true);
  attempt.abort();
  expect(admission.signal?.aborted).toBe(true);
  await expect(mount.request("/service/v1/agent/scribe/capture-admissions", body,
    "retained-admission-key", attempt.signal)).rejects.toThrow();
  expect(calls.filter(call => call.payload.action === "capture-admissions")).toHaveLength(1);
  await mount.release?.(); await backend.dispose();
});

it("retains an unacknowledged preparation until native cleanup confirms it before another attempt", async () => {
  const signal = new AbortController().signal, revision = crypto.randomUUID();
  const workspaceId = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const id = "01j" + "0".repeat(23), appointmentRef = "appointment_" + id, bindingRef = "scribe_capture_binding_" + id;
  const encounter = { appointmentRef, title: "Invented visit", detail: "Preparation recovery fixture" };
  const grant = { captureSessionId: sessionId, actorId: "invented-creator", consentRecordId: crypto.randomUUID(),
    consentStatus: "granted", sessionStatus: "authorized", source: "desktop_companion", sourceLeaseId: crypto.randomUUID() };
  const preparationIds: unknown[] = [], releases: unknown[] = [];
  let lostPreparation = true, lostRetirement = true;
  const request = vi.fn(async (method: string, payload: Record<string, unknown>) => {
    if (method === "providerRequest") return { status: 200, body: JSON.stringify(payload.action === "catalog"
      ? { revision, encounters: [{ ...encounter, workspaceId }] }
      : { revision, workspaceId, appointmentRef, bindingRef, encounter, recoveryScope: crypto.randomUUID() }) };
    if (method === "sourcePrepareForStart") {
      preparationIds.push(payload.preparationId);
      if (lostPreparation) { lostPreparation = false; throw new Error("lost preparation reply"); }
      return preparedReply(grant);
    }
    if (method === "sourcePreparationRelease") {
      releases.push(payload);
      if (lostRetirement) { lostRetirement = false; throw new Error("lost preparation retirement reply"); }
      return null;
    }
    if (method === "sourceStopped") return null;
    throw new Error("Unexpected native request");
  });
  const native = { signal, request, isReady: () => true, getState: async () => ({ phase: "ready", revision }),
    addListener: async () => ({ remove: async () => undefined }) } as unknown as NativeProviderClient;
  const backend = await connectDesktopNativeBackend(native, { signal, openCore: async () => undefined,
    uploadTarget: { putCompleteEnvelope: async () => undefined } });
  await backend.listEncounters(signal);
  const mount = await backend.openEncounter(appointmentRef, signal);
  const prepared = { sessionId, captureLeaseId: crypto.randomUUID(), leaseReceiptId: crypto.randomUUID(),
    captureLeaseGeneration: 1, captureAuthorizedUntil: new Date(Date.now() + 60000).toISOString() };
  await expect(mount.authorizeRecorder(prepared, signal)).rejects.toThrow("lost preparation reply");
  await expect(mount.authorizeRecorder(prepared, signal)).rejects.toThrow("lost preparation retirement reply");
  expect(preparationIds).toHaveLength(1);
  await mount.authorizeRecorder(prepared, signal);
  expect(preparationIds).toHaveLength(2);
  expect(preparationIds[0]).toEqual(expect.any(String)); expect(preparationIds[1]).not.toBe(preparationIds[0]);
  expect(releases).toEqual([{ revision, preparationId: preparationIds[0] }, { revision, preparationId: preparationIds[0] }]);
  await mount.retireSource(); await mount.release?.(); await backend.dispose();
  expect(request.mock.calls.some(([method]) => method === "sourceAuthorize")).toBe(false);
});

it("cleans an unknown native preparation after the recorder request is cancelled", async () => {
  const signal = new AbortController().signal, attempt = new AbortController(), revision = crypto.randomUUID();
  const workspaceId = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const id = "01j" + "0".repeat(23), appointmentRef = "appointment_" + id, bindingRef = "scribe_capture_binding_" + id;
  const encounter = { appointmentRef, title: "Invented visit", detail: "Cancellation fixture" };
  let preparationId: unknown;
  const request = vi.fn(async (method: string, payload: Record<string, unknown>) => {
    if (method === "providerRequest") return { status: 200, body: JSON.stringify(payload.action === "catalog"
      ? { revision, encounters: [{ ...encounter, workspaceId }] }
      : { revision, workspaceId, appointmentRef, bindingRef, encounter, recoveryScope: crypto.randomUUID() }) };
    if (method === "sourcePrepareForStart") { preparationId = payload.preparationId; attempt.abort(); throw new Error("request cancelled"); }
    if (method === "sourcePreparationRelease") return null;
    throw new Error("Unexpected native request");
  });
  const native = { signal, request, isReady: () => true, getState: async () => ({ phase: "ready", revision }),
    addListener: async () => ({ remove: async () => undefined }) } as unknown as NativeProviderClient;
  const backend = await connectDesktopNativeBackend(native, { signal, openCore: async () => undefined,
    uploadTarget: { putCompleteEnvelope: async () => undefined } });
  await backend.listEncounters(signal);
  const mount = await backend.openEncounter(appointmentRef, signal);
  await expect(mount.authorizeRecorder({ sessionId, captureLeaseId: crypto.randomUUID(), leaseReceiptId: crypto.randomUUID(),
    captureLeaseGeneration: 1, captureAuthorizedUntil: new Date(Date.now() + 60000).toISOString() }, attempt.signal)).rejects.toThrow();
  await mount.release?.(); await backend.dispose();
  expect(preparationId).toEqual(expect.any(String));
  expect(request.mock.calls.filter(([method]) => method === "sourcePreparationRelease")).toEqual([
    ["sourcePreparationRelease", { revision, preparationId }],
  ]);
});

it("retains a returned source grant for cleanup when the scope is cancelled with its reply", async () => {
  const signal = new AbortController().signal, attempt = new AbortController(), revision = crypto.randomUUID();
  const workspaceId = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const id = "01j" + "0".repeat(23), appointmentRef = "appointment_" + id, bindingRef = "scribe_capture_binding_" + id;
  const encounter = { appointmentRef, title: "Invented visit", detail: "Late grant fixture" };
  const grant = { captureSessionId: sessionId, actorId: "invented-creator", consentRecordId: crypto.randomUUID(),
    consentStatus: "granted", sessionStatus: "authorized", source: "desktop_companion", sourceLeaseId: crypto.randomUUID() };
  const request = vi.fn(async (method: string, payload: Record<string, unknown>) => {
    if (method === "providerRequest") return { status: 200, body: JSON.stringify(payload.action === "catalog"
      ? { revision, encounters: [{ ...encounter, workspaceId }] }
      : { revision, workspaceId, appointmentRef, bindingRef, encounter, recoveryScope: crypto.randomUUID() }) };
    if (method === "sourcePrepareForStart") { attempt.abort(); return preparedReply(grant); }
    if (method === "sourceRelease") return null;
    throw new Error("Unexpected native request");
  });
  const native = { signal, request, isReady: () => true, getState: async () => ({ phase: "ready", revision }),
    addListener: async () => ({ remove: async () => undefined }) } as unknown as NativeProviderClient;
  const backend = await connectDesktopNativeBackend(native, { signal, openCore: async () => undefined,
    uploadTarget: { putCompleteEnvelope: async () => undefined } });
  await backend.listEncounters(signal);
  const mount = await backend.openEncounter(appointmentRef, signal);
  await expect(mount.authorizeRecorder({ sessionId, captureLeaseId: crypto.randomUUID(), leaseReceiptId: crypto.randomUUID(),
    captureLeaseGeneration: 1, captureAuthorizedUntil: new Date(Date.now() + 60000).toISOString() }, attempt.signal)).rejects.toThrow();
  await mount.release?.(); await backend.dispose();
  expect(request.mock.calls.filter(([method]) => method === "sourceRelease")).toEqual([
    ["sourceRelease", { sourceLeaseId: grant.sourceLeaseId }],
  ]);
  expect(request.mock.calls.some(([method]) => method === "sourceAuthorize")).toBe(false);
});

it("retries the same native desktop source after a lost stop acknowledgement", async () => {
  const signal = new AbortController().signal;
  const revision = crypto.randomUUID(), workspaceId = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const id = "01j" + "0".repeat(23), appointmentRef = "appointment_" + id, bindingRef = "scribe_capture_binding_" + id;
  const encounter = { appointmentRef, title: "Invented visit", detail: "Local stop fixture" };
  const grant = { captureSessionId: sessionId, actorId: "invented-creator", consentRecordId: crypto.randomUUID(),
    consentStatus: "granted", sessionStatus: "authorized", source: "desktop_companion", sourceLeaseId: crypto.randomUUID() };
  let lost = true;
  const request = vi.fn(async (method: string, payload: Record<string, unknown>) => {
    if (method === "providerRequest") return { status: 200, body: JSON.stringify(payload.action === "catalog"
      ? { revision, encounters: [{ ...encounter, workspaceId }] }
      : { revision, workspaceId, appointmentRef, bindingRef, encounter, recoveryScope: crypto.randomUUID() }) };
    if (method === "sourcePrepareForStart") return preparedReply(grant);
    if (method === "sourceStopped") { if (lost) { lost = false; throw new Error("lost stop reply"); } return null; }
    throw new Error("Unexpected native request");
  });
  const native = { signal, request, isReady: () => true, getState: async () => ({ phase: "ready", revision }),
    addListener: async () => ({ remove: async () => undefined }) } as unknown as NativeProviderClient;
  const backend = await connectDesktopNativeBackend(native, { signal, openCore: async () => undefined,
    uploadTarget: { putCompleteEnvelope: async () => undefined } });
  await backend.listEncounters(signal);
  const mount = await backend.openEncounter(appointmentRef, signal);
  await mount.authorizeRecorder({ sessionId, captureLeaseId: crypto.randomUUID(), leaseReceiptId: crypto.randomUUID(),
    captureLeaseGeneration: 1, captureAuthorizedUntil: new Date(Date.now() + 60000).toISOString() }, signal);
  await expect(mount.retireSource()).rejects.toThrow("lost stop reply");
  await mount.retireSource();
  await mount.release?.(); await backend.dispose();
  expect(request.mock.calls.filter(([method]) => method === "sourceStopped")).toEqual([
    ["sourceStopped", { sourceLeaseId: grant.sourceLeaseId }], ["sourceStopped", { sourceLeaseId: grant.sourceLeaseId }],
  ]);
  expect(request.mock.calls.some(([method]) => method === "sourceRelease")).toBe(false);
});

it.each([false, true])("preserves legacy opening and carries a validated combined read (%s)", async supported => {
  const signal = new AbortController().signal, revision = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const id = "01j" + "0".repeat(23), appointmentRef = "appointment_" + id, bindingRef = "scribe_capture_binding_" + id;
  const encounter = { appointmentRef, title: "Invented visit", detail: "Opening fixture" };
  const calls: Record<string, unknown>[] = [];
  const native = { signal, isReady: () => true, getState: async () => ({ phase: "ready", revision }),
    addListener: async () => ({ remove: async () => undefined }),
    request: async (_method: string, payload: Record<string, unknown>) => {
      calls.push(payload);
      const body = JSON.parse(payload.body as string);
      return { status: 200, body: JSON.stringify(payload.action === "catalog"
        ? { revision, encounters: [{ ...encounter, workspaceId }], opening_review_v1: supported }
        : { revision, workspaceId, appointmentRef, bindingRef, encounter, recoveryScope: crypto.randomUUID(),
          ...(supported ? { openingReview: { contract_version: "1", workspace_id: workspaceId, binding_ref: bindingRef,
            request_nonce: body.opening_nonce, checked_at: new Date().toISOString(), operation: "provider_encounter",
            receipt: { schema_version: "1.0", status: "not_prepared", review: null } } } : {}) }) };
    } } as unknown as NativeProviderClient;
  const backend = await connectDesktopNativeBackend(native, { signal, openCore: async () => undefined,
    uploadTarget: { putCompleteEnvelope: async () => undefined } });
  try {
    await backend.listEncounters(signal);
    const mount = await backend.openEncounter(appointmentRef, signal);
    expect(mount.openingReview?.view).toBe(supported ? null : undefined);
    expect(mount.openingReview?.scope).toEqual(supported ? mount.scope : undefined);
    expect(Object.keys(JSON.parse(calls[1]!.body as string)).sort())
      .toEqual(supported ? ["opening_nonce", "workspace_id"] : ["workspace_id"]);
    expect(calls).toHaveLength(2);
  } finally { await backend.dispose(); }
});

it("carries a closed combined-opening recovery without another provider operation", async () => {
  const signal = new AbortController().signal, revision = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const id = "01j" + "0".repeat(23), appointmentRef = "appointment_" + id, bindingRef = "scribe_capture_binding_" + id;
  const encounter = { appointmentRef, title: "Invented visit", detail: "Recovery fixture" };
  const calls: Record<string, unknown>[] = [];
  const native = { signal, isReady: () => true, getState: async () => ({ phase: "ready", revision }),
    addListener: async () => ({ remove: async () => undefined }),
    request: async (_method: string, payload: Record<string, unknown>) => {
      calls.push(payload); const body = JSON.parse(payload.body as string);
      return { status: 200, body: JSON.stringify(payload.action === "catalog"
        ? { revision, encounters: [{ ...encounter, workspaceId }], opening_review_v1: true }
        : { revision, workspaceId, appointmentRef, bindingRef, encounter, recoveryScope: crypto.randomUUID(),
          openingRecovery: { contract_version: "1", workspace_id: workspaceId, binding_ref: bindingRef,
            request_nonce: body.opening_nonce, disposition: "provider_operation_conflict" } }) };
    } } as unknown as NativeProviderClient;
  const backend = await connectDesktopNativeBackend(native, { signal, openCore: async () => undefined,
    uploadTarget: { putCompleteEnvelope: async () => undefined } });
  try {
    await backend.listEncounters(signal);
    const mount = await backend.openEncounter(appointmentRef, signal);
    expect(mount.openingReview).toBeUndefined();
    expect(mount.openingRecovery?.reason).toBe("conflict");
    expect(mount.openingRecovery?.scope).toEqual(mount.scope);
    expect(calls).toHaveLength(2);
  } finally { await backend.dispose(); }
});

it.each([false, true])("gates coordinated notes and preserves its native timeout (%s)", async supported => {
  const signal = new AbortController().signal, revision = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const id = "01j" + "0".repeat(23), appointmentRef = "appointment_" + id, bindingRef = "scribe_capture_binding_" + id;
  const encounter = { appointmentRef, title: "Invented note opening", detail: "Offline fixture" };
  const request = vi.fn(async (_method: string, payload: Record<string, unknown>, _signal?: AbortSignal, _timeout?: number) => {
    expect(_signal?.aborted).toBe(false); expect(_timeout).toBeGreaterThan(0);
    return { status: 200, body: JSON.stringify(payload.action === "catalog"
      ? { revision, encounters: [{ ...encounter, workspaceId }], note_opening_v1: supported }
      : { revision, workspaceId, appointmentRef, bindingRef, encounter, recoveryScope: crypto.randomUUID() }) };
  });
  const native = { signal, request, isReady: () => true, getState: async () => ({ phase: "ready", revision }),
    addListener: async () => ({ remove: async () => undefined }) } as unknown as NativeProviderClient;
  const backend = await connectDesktopNativeBackend(native, { signal, openCore: async () => undefined,
    uploadTarget: { putCompleteEnvelope: async () => undefined } });
  try {
    await backend.listEncounters(signal);
    const mount = await backend.openEncounter(appointmentRef, signal);
    expect(mount.noteOpeningSupported).toBe(supported ? true : undefined);
    const body = { workspace_id: workspaceId, binding_ref: bindingRef,
      expected_session_id: crypto.randomUUID(), request_nonce: crypto.randomUUID() };
    const open = () => mount.request("/service/v1/agent/scribe/note-opening", body, "fresh-note-open", signal);
    if (supported) {
      await open();
      expect(request.mock.calls.at(-1)?.[3]).toBe(125_000);
      expect(JSON.parse(request.mock.calls.at(-1)?.[1].body as string)).toEqual(body);
    } else await expect(async () => open()).rejects.toThrow();
    expect(request.mock.calls.map(([, payload]) => payload.action))
      .toEqual(["catalog", "mount", ...(supported ? ["note-opening"] : [])]);
  } finally { await backend.dispose(); }
});

it("claims only main identity proofs, not serialized requests, and abandons cancelled metadata I/O", async () => {
  const { DesktopInitialWindowOwner } = await import("./desktop-initial-window.js");
  const signal = new AbortController().signal, revision = crypto.randomUUID(), workspaceId = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const id = "01j" + "0".repeat(23), appointmentRef = "appointment_" + id, bindingRef = "scribe_capture_binding_" + id;
  const encounter = { appointmentRef, title: "Fictional visit", detail: "Virtual authority fixture" };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const request = vi.fn(async (method: string, payload: Record<string, unknown>) => {
    if (method === "providerInitialWindowAbandon") return null;
    if (method === "providerInitialWindow") { await gate; return { status: 200, body: "{}" }; }
    return { status: 200, body: JSON.stringify(payload.action === "catalog"
      ? { revision, encounters: [{ ...encounter, workspaceId }] }
      : { revision, workspaceId, appointmentRef, bindingRef, encounter, recoveryScope: crypto.randomUUID() }) };
  });
  const native = { signal, request, isReady: () => true, getState: async () => ({ phase: "ready", revision }),
    addListener: async () => ({ remove: async () => undefined }) } as unknown as NativeProviderClient;
  const backend = await connectDesktopNativeBackend(native, { signal, openCore: async () => undefined,
    uploadTarget: { putCompleteEnvelope: async () => undefined } });
  await backend.listEncounters(signal); const mount = await backend.openEncounter(appointmentRef, signal);
  const abort = new AbortController(), admission = { key: crypto.randomUUID(), nonce: crypto.randomUUID(), receipt: { session_id: sessionId } };
  const owner = new DesktopInitialWindowOwner(mount.scope, admission, abort.signal);
  const initial = { mode: "configured_core" as const, schemaVersion: 6 as const, channel: "mixed" as const, sessionId,
    startedAt: new Date().toISOString(), completeIdempotencyKey: "complete:" + crypto.randomUUID(), leaseIdempotencyKey: null,
    leaseRequest: null, windowPreparation: null };
  const key = { schemaVersion: 2 as const, sessionId, state: "pending" as const, keyVersion: "fixture", wrappedDek: "a".repeat(512),
    idempotencyKey: "bind-key:" + crypto.randomUUID() };
  const recipe = { ...initial, leaseIdempotencyKey: "lease:" + crypto.randomUUID(), leaseRequest: { protocol_version: "1.0" as const },
    windowPreparation: { idempotencyKey: "prepare-window:" + crypto.randomUUID(), bindIdempotencyKey: key.idempotencyKey,
      reserveIdempotencyKey: "reserve:" + crypto.randomUUID(), keyVersion: key.keyVersion, wrappedDek: key.wrappedDek,
      reservationCount: 30, aggregatePlaintextBudgetBytes: 67108864 } };
  owner.preparation(null, initial); owner.newKey(key); owner.preparation(initial, recipe);
  const body = { workspace_id: workspaceId, binding_ref: bindingRef, request_nonce: crypto.randomUUID(),
    operation: { kind: "prepare_recording_window", payload: { schema_version: "1.0", binding: { key_version: key.keyVersion,
      wrapped_dek: key.wrappedDek }, bind_idempotency_key: key.idempotencyKey, lease_idempotency_key: recipe.leaseIdempotencyKey,
      reserve_idempotency_key: recipe.windowPreparation.reserveIdempotencyKey, channel: "mixed", reservation_count: 30 } } };
  const proof = owner.take(body, recipe.windowPreparation.idempotencyKey)!;
  expect(() => mount.sendFreshInitialWindow!(JSON.parse(JSON.stringify(proof)), body,
    recipe.windowPreparation.idempotencyKey, abort.signal)).toThrow();
  expect(request.mock.calls.some(([method]) => method === "providerInitialWindow")).toBe(false);
  const pending = mount.sendFreshInitialWindow!(proof, body, recipe.windowPreparation.idempotencyKey, abort.signal);
  const rejected = expect(pending).rejects.toThrow();
  expect(() => mount.sendFreshInitialWindow!(proof, body, recipe.windowPreparation.idempotencyKey, abort.signal)).toThrow();
  expect(request.mock.calls.filter(([method]) => method === "providerInitialWindow")).toHaveLength(1);
  const sent = request.mock.calls.find(([method]) => method === "providerInitialWindow")![1];
  expect(Object.keys(sent).sort()).toEqual(["admissionKey", "admissionNonce", "admissionReceipt", "body", "key", "revision"]);
  expect(sent.admissionReceipt).toEqual(admission.receipt); expect(JSON.parse(sent.body as string)).toEqual(body);
  abort.abort();
  expect(request.mock.calls.some(([method]) => method === "providerInitialWindowAbandon")).toBe(true);
  release(); await rejected;
  expect(request.mock.calls.filter(([method]) => method === "providerInitialWindow")).toHaveLength(1);
  await mount.release?.(); await backend.dispose();
});

it("does not add an idle metadata-abandon reply wait to encounter release", async () => {
  const signal = new AbortController().signal, revision = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const id = "01j" + "0".repeat(23), appointmentRef = "appointment_" + id, bindingRef = "scribe_capture_binding_" + id;
  const encounter = { appointmentRef, title: "Fictional visit", detail: "Virtual cleanup fixture" };
  let acknowledge!: () => void;
  const gate = new Promise<void>(resolve => { acknowledge = resolve; });
  const request = vi.fn(async (method: string, payload: Record<string, unknown>) => {
    if (method === "providerInitialWindowAbandon") { await gate; return null; }
    return { status: 200, body: JSON.stringify(payload.action === "catalog"
      ? { revision, encounters: [{ ...encounter, workspaceId }] }
      : { revision, workspaceId, appointmentRef, bindingRef, encounter, recoveryScope: crypto.randomUUID() }) };
  });
  const native = { signal, request, isReady: () => true, getState: async () => ({ phase: "ready", revision }),
    addListener: async () => ({ remove: async () => undefined }) } as unknown as NativeProviderClient;
  const backend = await connectDesktopNativeBackend(native, { signal, openCore: async () => undefined,
    uploadTarget: { putCompleteEnvelope: async () => undefined } });
  await backend.listEncounters(signal); const mount = await backend.openEncounter(appointmentRef, signal);
  try {
    await mount.release?.();
    expect(request.mock.calls.filter(([method]) => method === "providerInitialWindowAbandon")).toHaveLength(1);
    expect(request.mock.calls.some(([method]) => method.startsWith("source"))).toBe(false);
  } finally { acknowledge(); await backend.dispose(); }
});


it("binds desktop setup auth to the native version and current mount, with no source/admission call", async () => {
  const host = new AbortController(), revision = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const suffix = "01j" + "0".repeat(23), appointmentRef = "appointment_" + suffix, bindingRef = "scribe_capture_binding_" + suffix;
  const encounter = { appointmentRef, title: "Invented visit", detail: "Metadata-only setup" };
  const request = vi.fn(async (method: string, payload: Record<string, unknown>) => {
    if (method === "providerRequest") return { status: 200, body: JSON.stringify(payload.action === "catalog"
      ? { revision, encounters: [{ ...encounter, workspaceId }] }
      : { revision, workspaceId, appointmentRef, bindingRef, encounter, recoveryScope: crypto.randomUUID() }) };
    if (method === "prepareProviderSignIn") return { revision };
    if (method === "abandonProviderSignIn" || method === "providerInitialWindowAbandon") return null;
    throw new Error("Unexpected source or recording request");
  });
  const native = { signal: host.signal, request, isReady: () => true,
    getState: async () => ({ phase: "ready", revision, recordingSignInPreparationVersion: 1 }),
    addListener: async () => ({ remove: async () => undefined }) } as unknown as NativeProviderClient;
  const backend = await connectDesktopNativeBackend(native, { signal: host.signal, openCore: async () => undefined,
    uploadTarget: { putCompleteEnvelope: async () => undefined } });
  await backend.listEncounters(host.signal); const mount = await backend.openEncounter(appointmentRef, host.signal);
  const action = new AbortController(); await mount.signInPreparation!.prepare(action.signal);
  const payload = request.mock.calls.find(([method]) => method === "prepareProviderSignIn")![1];
  expect(payload).toEqual({ preparationId: expect.any(String), revision, workspaceId, bindingRef });
  expect(request.mock.calls.filter(([method]) => method === "providerRequest").map(([, payload]) => payload.action)).toEqual(["catalog", "mount"]);
  action.abort(); await vi.waitFor(() => expect(request).toHaveBeenCalledWith("abandonProviderSignIn", { preparationId: payload.preparationId }));
  host.abort(); expect(() => mount.signInPreparation!.prepare(new AbortController().signal)).toThrow();
  await backend.dispose();
});

async function readySourceFixture() {
  const abort = new AbortController(), revision = crypto.randomUUID(), workspaceId = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const suffix = "01j" + "0".repeat(23), appointmentRef = "appointment_" + suffix, bindingRef = "scribe_capture_binding_" + suffix;
  const encounter = { appointmentRef, title: "Invented visit", detail: "Unissued preparation fixture" };
  const prepared = { sessionId, captureLeaseId: crypto.randomUUID(), leaseReceiptId: crypto.randomUUID(),
    captureLeaseGeneration: 1, captureAuthorizedUntil: new Date(Date.now() + 900_000).toISOString() };
  let expiry = Date.now() + 120_000, losePrepare = false, loseRelease = false;
  const owners = new Map<string, Record<string, unknown>>();
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const request = vi.fn(async (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    if (method === "providerRequest") return { status: 200, body: JSON.stringify(payload.action === "catalog"
      ? { revision, encounters: [{ ...encounter, workspaceId }] }
      : { revision, workspaceId, appointmentRef, bindingRef, encounter, recoveryScope: crypto.randomUUID() }) };
    if (method === "sourcePrepare" || method === "sourcePrepareForStart") {
      expect(owners.size).toBe(0);
      const grant = { captureSessionId: sessionId, actorId: "invented-creator", consentRecordId: crypto.randomUUID(),
        consentStatus: "granted", sessionStatus: "authorized", source: "desktop_companion", sourceLeaseId: crypto.randomUUID() };
      owners.set(payload.preparationId as string, grant);
      if (losePrepare) { losePrepare = false; throw new Error("lost prepare"); }
      return { ...preparedReply(grant), ...(method === "sourcePrepare" ? { preparationExpiresAt: new Date(expiry).toISOString() } : {}) };
    }
    if (method === "sourcePreparationRelease") {
      if (loseRelease) { loseRelease = false; throw new Error("lost release"); }
      owners.delete(payload.preparationId as string); return null;
    }
    if (method === "sourceRelease" || method === "sourceStopped") {
      for (const [id, grant] of owners) if (grant.sourceLeaseId === payload.sourceLeaseId) owners.delete(id);
      return null;
    }
    if (method === "sourceAuthorize") return { decision: "synthetic remote authorization" };
    throw new Error("Unexpected native request");
  });
  const native = { signal: new AbortController().signal, request, isReady: () => true,
    getState: async () => ({ phase: "ready", revision, desktopSourcePreparationVersion: 1 }),
    addListener: async () => ({ remove: async () => undefined }) } as unknown as NativeProviderClient;
  const backend = await connectDesktopNativeBackend(native, { signal: abort.signal, openCore: async () => undefined,
    uploadTarget: { putCompleteEnvelope: async () => undefined } });
  await backend.listEncounters(abort.signal);
  const mount = await backend.openEncounter(appointmentRef, abort.signal);
  return { abort, prepared, mount, calls, owners,
    expiry: (value: number) => { expiry = value; }, losePrepare: () => { losePrepare = true; }, loseRelease: () => { loseRelease = true; },
    close: async () => { await mount.release?.(); await backend.dispose(); } };
}

it("prepares without authority in Ready and reuses that exact grant/fence for one real Record authorization", async () => {
  const f = await readySourceFixture();
  try {
    const ready = await f.mount.readySourcePreparation!.prepare(f.prepared, f.abort.signal);
    expect(Date.parse(ready.expiresAt)).toBeGreaterThan(Date.now());
    await f.mount.readySourcePreparation!.prepare(f.prepared, f.abort.signal);
    expect(f.calls.filter(call => call.method.startsWith("source")).map(call => call.method)).toEqual(["sourcePrepare"]);
    const original = [...f.owners.values()][0];
    const { grant } = await f.mount.authorizeRecorder(f.prepared, f.abort.signal);
    expect(grant).toEqual(original); expect(f.mount.processFence!()).toBeDefined();
    expect(f.calls.some(call => call.method === "sourceAuthorize" || call.method === "sourcePrepareForStart")).toBe(false);
    await f.mount.authority.authorizeStart(grant as Parameters<typeof f.mount.authority.authorizeStart>[0], f.abort.signal);
    expect(f.calls.filter(call => call.method.startsWith("source")).map(call => call.method)).toEqual(["sourcePrepare", "sourceAuthorize"]);
    await f.mount.readySourcePreparation!.release(); // Claimed owner is no longer preparation-only custody.
    expect(f.owners.size).toBe(1);
    await f.mount.retireSource();
  } finally { await f.close(); }
});

it("retires the expired original owner before a fresh Ready proof and blocks replacement on a lost retirement", async () => {
  const f = await readySourceFixture();
  let now = Date.now(); const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    await f.mount.readySourcePreparation!.prepare(f.prepared, f.abort.signal);
    const original = f.calls.find(call => call.method === "sourcePrepare")!.payload.preparationId;
    now += 120_001; f.expiry(now + 120_000); f.loseRelease();
    await expect(f.mount.readySourcePreparation!.prepare(f.prepared, f.abort.signal)).rejects.toThrow("lost release");
    expect(f.calls.filter(call => call.method === "sourcePrepare")).toHaveLength(1);
    await f.mount.readySourcePreparation!.prepare(f.prepared, f.abort.signal);
    const sourceCalls = f.calls.filter(call => call.method.startsWith("source"));
    expect(sourceCalls.map(call => call.method)).toEqual(["sourcePrepare", "sourcePreparationRelease", "sourcePreparationRelease", "sourcePrepare"]);
    expect(sourceCalls[1]!.payload.preparationId).toBe(original); expect(sourceCalls[2]!.payload.preparationId).toBe(original);
    expect(sourceCalls[3]!.payload.preparationId).not.toBe(original);
  } finally { clock.mockRestore(); await f.close(); }
});

it("uses the combined Record fallback only after confirmed cleanup of an ambiguous Ready dispatch", async () => {
  const f = await readySourceFixture();
  try {
    f.losePrepare();
    await expect(f.mount.readySourcePreparation!.prepare(f.prepared, f.abort.signal)).rejects.toThrow("lost prepare");
    f.loseRelease();
    await expect(f.mount.authorizeRecorder(f.prepared, f.abort.signal)).rejects.toThrow("lost release");
    expect(f.calls.some(call => call.method === "sourcePrepareForStart")).toBe(false);
    await f.mount.authorizeRecorder(f.prepared, f.abort.signal);
    expect(f.calls.filter(call => call.method.startsWith("source")).map(call => call.method)).toEqual([
      "sourcePrepare", "sourcePreparationRelease", "sourcePreparationRelease", "sourcePrepareForStart",
    ]);
  } finally { await f.close(); }
});

it("cancels the unissued owner on scope closure and never prepares a recorded continuation in Ready", async () => {
  const f = await readySourceFixture();
  try {
    await expect(f.mount.readySourcePreparation!.prepare({ ...f.prepared, firstSequenceNumber: 1 }, f.abort.signal)).rejects.toThrow();
    await expect(f.mount.readySourcePreparation!.prepare({ ...f.prepared, captureLeaseGeneration: 2 }, f.abort.signal)).rejects.toThrow();
    await f.mount.readySourcePreparation!.prepare(f.prepared, f.abort.signal);
    f.abort.abort();
    await expect(f.mount.authorizeRecorder(f.prepared, f.abort.signal)).rejects.toThrow();
    await f.mount.readySourcePreparation!.release();
    expect(f.owners.size).toBe(0); expect(f.calls.some(call => call.method === "sourceAuthorize")).toBe(false);
  } finally { await f.close(); }
});
