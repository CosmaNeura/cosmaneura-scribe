import { webcrypto } from "node:crypto";
import { Capacitor } from "@capacitor/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectNativeProviderIOSBackend, type ProviderNativePlugin } from "./native-backend";

const disk = vi.hoisted(() => new Map<string, { key: string; data: string; revision: string }>());
vi.mock("@cosmaneura-scribe/capacitor-secure-queue", () => ({ SecureQueue: {
  get: async ({ key }: { key: string }) => {
    const value = disk.get(key);
    if (!value) throw Object.assign(new Error("missing"), { code: "SECURE_QUEUE_NOT_FOUND" });
    return value;
  },
  create: async (value: { key: string; data: string }) => {
    if (disk.has(value.key)) throw Error("conflict");
    disk.set(value.key, { ...value, revision: "1" }); return { revision: "1" };
  },
  compareAndSwap: async (value: { key: string; data: string; expectedRevision: string }) => {
    if (disk.get(value.key)?.revision !== value.expectedRevision) throw Error("conflict");
    const revision = String(Number(value.expectedRevision) + 1);
    disk.set(value.key, { key: value.key, data: value.data, revision }); return { revision };
  },
} }));
beforeEach(() => {
  disk.clear(); vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
  vi.spyOn(Capacitor, "getPlatform").mockReturnValue("ios");
  vi.spyOn(Capacitor, "isPluginAvailable").mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture(combined = true, fault = "none") {
  const workspace = crypto.randomUUID(), recovery = crypto.randomUUID(), revision = crypto.randomUUID();
  const appointment = "appointment_01j00000000000000000000000", patient = "patient_01j00000000000000000000000";
  const binding = "scribe_capture_binding_01j00000000000000000000000";
  const encounter = { appointmentRef: appointment, patientRef: patient, title: "Synthetic patient", patientName: "Synthetic patient", detail: "Visit" };
  const opening = (nonce: string) => ({ revision, workspaceId: workspace, recoveryScope: recovery,
    appointmentRef: appointment, bindingRef: binding, encounter,
    openingRecovery: { contract_version: "1", workspace_id: workspace, binding_ref: binding,
      request_nonce: nonce, disposition: "provider_operation_unavailable" } });
  const entry = vi.fn(async () => undefined);
  const request = vi.fn<ProviderNativePlugin["providerRequest"]>(async value => {
    const body = JSON.parse(value.body);
    let result: Record<string, unknown>;
    if (value.action === "catalog") result = { revision, encounters: [], opening_review_v1: true,
      encounter_creation_v1: true, existing_patient_visits_v1: true, native_visit_actions_v2: true,
      ...(combined ? { native_create_opening_v1: true } : {}), environment: "Staging", recoveryScope: recovery,
      account: { email: "provider@synthetic.invalid" } };
    else if (value.action === "mount") result = opening(body.opening_nonce);
    else {
      const mounted = opening(body.opening_nonce);
      if (fault === "patient") mounted.encounter = { ...encounter, patientRef: "patient_01j00000000000000000000001" };
      if (fault === "revision") mounted.revision = crypto.randomUUID();
      if (fault === "nonce") mounted.openingRecovery.request_nonce = crypto.randomUUID();
      result = { revision, version: "2", action: "create", request_nonce: body.request_nonce,
        creation_key: body.creation_key, recoveryScope: recovery, account: { email: "provider@synthetic.invalid" },
        encounter: { workspace_id: workspace, appointment_ref: appointment, patient_ref: patient,
          patient_name: "Synthetic patient", title: "Visit", appointment_at: "2026-11-09T12:00:00Z" },
        ...(body.opening_nonce || fault === "unsolicited" ? { opening: mounted } : {}) };
    }
    return { requestId: value.requestId, revision, status: 200, body: JSON.stringify(result) };
  });
  const plugin: ProviderNativePlugin = { getProviderState: async () => ({ phase: "ready", providerReady: true, revision }),
    addListener: async () => ({ remove: async () => undefined }), providerRequest: request,
    cancelProviderRequest: async () => undefined, prepareProviderSource: async value => ({ revision, sessionId: value.sessionId }),
    closeProviderSource: async () => undefined, recordProviderEntryTiming: entry };
  const signal = new AbortController().signal;
  const backend = await connectNativeProviderIOSBackend({ signal, profile: "core-staging-personal-v1",
    uploadTarget: { putCompleteEnvelope: async () => undefined },
    core: { createEncounter: async () => undefined, openEncounter: async () => undefined } }, plugin);
  await backend.listEncounters(signal);
  const draft = { creationKey: crypto.randomUUID(), patient: { kind: "new" as const, name: "Synthetic patient", dateOfBirth: null },
    appointmentAt: "2026-11-09T12:00:00Z", title: "Visit", openAfterCreation: true };
  return { backend, signal, request, draft, appointment, entry, revision };
}

it.each([false, true])("uses the negotiated create opening and keeps the older receiver compatible (%s)", async combined => {
  const f = await fixture(combined);
  try {
    await f.backend.encounterSetup!.submit(f.draft, f.signal);
    await f.backend.openEncounter(f.appointment, f.signal);
    expect(f.request.mock.calls.map(([value]) => value.action)).toEqual(combined ? ["catalog", "encounters"] : ["catalog", "encounters", "mount"]);
    const body = JSON.parse(f.request.mock.calls[1]![0].body);
    expect(body.opening_nonce).toBe(combined ? f.draft.creationKey : undefined);
    expect(JSON.parse(atob([...disk.values()][0]!.data)).pending).toBeNull();
    await f.backend.openEncounter(f.appointment, f.signal);
    expect(f.request.mock.calls.at(-1)![0].action).toBe("mount");
  } finally { await f.backend.dispose(); }
});
it("discards an opening older than five seconds and mounts afresh", async () => {
  const f = await fixture();
  try {
    await f.backend.encounterSetup!.submit(f.draft, f.signal);
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 6000);
    await f.backend.openEncounter(f.appointment, f.signal);
    expect(f.request.mock.calls.at(-1)![0].action).toBe("mount");
  } finally { await f.backend.dispose(); }
});
it.each(["patient", "revision", "nonce", "unsolicited"])("rejects a mismatched %s opening and keeps the original retry key", async fault => {
  const f = await fixture(fault !== "unsolicited", fault);
  try {
    await expect(f.backend.encounterSetup!.submit(f.draft, f.signal)).rejects.toThrow();
    expect(JSON.parse(atob([...disk.values()][0]!.data)).pending.creationKey).toBe(f.draft.creationKey);
    await expect(f.backend.openEncounter(f.appointment, f.signal)).rejects.toThrow();
    expect(f.request.mock.calls.map(([value]) => value.action)).toEqual(["catalog", "encounters"]);
  } finally { await f.backend.dispose(); }
});
it("sends only bounded numeric entry diagnostics tied to the current native revision", async () => {
  const f = await fixture();
  try {
    for (const duration of [NaN, Infinity, -1, 600001]) f.backend.entryTiming!("patient-to-consent", duration);
    expect(f.entry).not.toHaveBeenCalled();
    f.backend.entryTiming!("patient-to-consent", 42);
    expect(f.entry).toHaveBeenCalledWith({ phase: "patient-to-consent", durationMs: 42, revision: f.revision });
    await f.backend.dispose();
    f.backend.entryTiming!("patient-to-consent", 43);
    expect(f.entry).toHaveBeenCalledOnce();
  } finally { await f.backend.dispose(); }
});
