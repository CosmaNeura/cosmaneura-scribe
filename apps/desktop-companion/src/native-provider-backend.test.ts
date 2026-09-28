import { expect, it, vi } from "vitest";
import { connectDesktopNativeBackend } from "./native-provider-backend.js";
import type { NativeProviderClient } from "./native-provider-client.js";

function preparedReply(grant: Record<string, unknown>) {
  return { grant, processFence: { epoch: crypto.randomUUID(), coordinatorDevice: "1",
    coordinatorInode: "2", captureDevice: "1", captureInode: "3" } };
}

it("keeps admission RPC alive beyond native HTTP while retaining its key and cancellation", async () => {
  const signal = new AbortController().signal, attempt = new AbortController();
  const revision = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const id = "01j" + "0".repeat(23), appointmentRef = "appointment_" + id, bindingRef = "scribe_capture_binding_" + id;
  const encounter = { appointmentRef, title: "Invented visit", detail: "Admission budget fixture" };
  const calls: { payload: Record<string, unknown>; signal: AbortSignal | undefined; timeout: number | undefined }[] = [];
  const request = vi.fn(async (_method: string, payload: Record<string, unknown>, operationSignal?: AbortSignal, timeout?: number) => {
    calls.push({ payload, signal: operationSignal, timeout });
    return { status: 200, body: JSON.stringify(payload.action === "catalog"
      ? { revision, encounters: [{ ...encounter, workspaceId }] }
      : { revision, workspaceId, appointmentRef, bindingRef, encounter, recoveryScope: crypto.randomUUID() }) };
  });
  const native = { signal, request, isReady: () => true, getState: async () => ({ phase: "ready", revision }),
    addListener: async () => ({ remove: async () => undefined }) } as unknown as NativeProviderClient;
  const backend = await connectDesktopNativeBackend(native, { signal, openCore: async () => undefined,
    uploadTarget: { putCompleteEnvelope: async () => undefined } });
  await backend.listEncounters(signal);
  const mount = await backend.openEncounter(appointmentRef, signal);
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
    if (method === "sourcePrepare") {
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
    if (method === "sourcePrepare") { preparationId = payload.preparationId; attempt.abort(); throw new Error("request cancelled"); }
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
    if (method === "sourcePrepare") { attempt.abort(); return preparedReply(grant); }
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
    if (method === "sourcePrepare") return preparedReply(grant);
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
