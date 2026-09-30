import { describe, expect, it, vi } from "vitest";
import { registerPlugin } from "@capacitor/core";
import { createEncounterSetup, parseEncounterDraft, type CreationRecords, type EncounterDraft } from "./encounter-setup";

const patientRef = "patient_01j00000000000000000000000";
const appointmentRef = "appointment_01j00000000000000000000000";
const initial: EncounterDraft = { creationKey: crypto.randomUUID(), patient: { kind: "new", name: "Synthetic Patient", dateOfBirth: "1980-01-02" }, appointmentAt: "2026-09-29T12:00:00Z", title: "Visit" };
function records() {
  const data = new Map<string, { key: string; data: string; revision: string }>();
  const write = (input: { key: string; data: string }, previous: string | null) => {
    if ((data.get(input.key)?.revision ?? null) !== previous) throw new Error("conflict");
    const revision = String(Number(previous ?? 0) + 1); data.set(input.key, { ...input, revision }); return { revision };
  };
  const store: CreationRecords = {
    get: vi.fn(async ({ key }) => { const value = data.get(key); if (!value) throw Object.assign(new Error("missing"), { code: "SECURE_QUEUE_NOT_FOUND" }); return value; }),
    create: vi.fn(async input => write(input, null)),
    compareAndSwap: vi.fn(async input => write(input, input.expectedRevision)),
  };
  return { store, data };
}
function fixture(capacitorProxy = false) {
  const disk = records(), scope = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  // Capacitor exposes every property as a method, including `then`. Reject
  // assimilation explicitly so this regression fails without hanging the suite.
  const assimilated = vi.fn();
  const store = capacitorProxy ? new Proxy(registerPlugin<CreationRecords>(`CreationTest${scope}`, {
    web: disk.store,
  }), { get: (target, property, receiver): unknown => {
    if (property === "then") {
      assimilated();
      throw new Error("Capacitor storage proxy must not be awaited");
    }
    return Reflect.get(target, property, receiver);
  } }) : disk.store;
  const response = (action: unknown) => ({ action, recoveryScope: scope, account: { email: "provider@synthetic.invalid" } });
  const request = vi.fn(async (body: Record<string, unknown>, _key: string, _signal: AbortSignal): Promise<Record<string, unknown>> => { void _key; void _signal; return body.action === "patients"
    ? { ...response(body.action), patients: [{ patient_ref: patientRef, name: "Synthetic Patient", date_of_birth: "1980-01-02" }], more_results: false }
    : { ...response(body.action), creation_key: body.creation_key, encounter: { workspace_id: workspaceId, appointment_ref: appointmentRef,
      patient_name: "Synthetic Patient", title: "Visit", appointment_at: "2026-09-29T12:00:00Z" } }; });
  const openStore = vi.fn(async () => ({ records: store, close: vi.fn(async () => undefined) }));
  const created = vi.fn(), abort = new AbortController();
  const newOwner = () => createEncounterSetup({ request, records: openStore, created, current: signal => { if (abort.signal.aborted || signal?.aborted) throw new Error("closed"); } });
  return { ...disk, scope, request, created, abort, openStore, newOwner, assimilated, signal: abort.signal };
}
describe("shared mobile/desktop encounter creation", () => {
  it.each([false, true])("loads patients and retains an uncertain request across restart with Capacitor proxy=%s", async capacitorProxy => {
    const f = fixture(capacitorProxy), first = f.newOwner();
    expect((await first.state(f.signal)).pending).toBeNull();
    f.request.mockRejectedValueOnce(new Error("lost response after server commit"));
    await expect(first.submit(initial, f.signal)).rejects.toThrow();
    expect(f.store.create).toHaveBeenCalledTimes(1); expect(f.created).not.toHaveBeenCalled();
    await first.dispose();
    const second = f.newOwner();
    expect((await second.state(f.signal)).pending).toEqual(initial);
    const reopened = await second.submit(null, f.signal);
    expect(reopened.appointmentRef).toBe(appointmentRef);
    const creations = f.request.mock.calls.filter(([body]) => body.action === "create");
    expect(creations).toHaveLength(2);
    expect(creations.map(([, key]) => key)).toEqual([initial.creationKey, initial.creationKey]);
    expect(creations[0]![0].patient).toEqual(creations[1]![0].patient);
    expect((await second.state(f.signal)).pending).toBeNull();
    expect(f.assimilated).not.toHaveBeenCalled();
    await second.dispose();
  });
  it("serializes double clicks and refuses a different intent while the first result is unknown", async () => {
    const f = fixture(), owner = f.newOwner(); await owner.state(f.signal);
    let reject!: (error: Error) => void;
    f.request.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }));
    const first = owner.submit(initial, f.signal); void first.catch(() => undefined);
    await vi.waitFor(() => expect(f.store.create).toHaveBeenCalledTimes(1));
    await expect(owner.submit(initial, f.signal)).rejects.toThrow();
    reject(new Error("uncertain")); await expect(first).rejects.toThrow();
    await expect(owner.submit({ ...initial, creationKey: crypto.randomUUID() }, f.signal)).rejects.toThrow();
    expect(f.request.mock.calls.filter(([b]) => b.action === "create")).toHaveLength(1);
    await owner.dispose();
  });
  it("canonicalizes property order and keeps three successive intents separate", async () => {
    const f = fixture(), owner = f.newOwner(); await owner.state(f.signal);
    const reordered = { title: initial.title, patient: { dateOfBirth: "1980-01-02", name: "Synthetic Patient", kind: "new" }, appointmentAt: initial.appointmentAt, creationKey: initial.creationKey };
    expect(parseEncounterDraft(reordered)).toEqual(initial);
    for (let i = 0; i < 3; i++) await owner.submit({ ...initial, creationKey: crypto.randomUUID(), patient: { kind: "existing", patientRef } }, f.signal);
    expect(new Set(f.request.mock.calls.filter(([b]) => b.action === "create").map(([, key]) => key)).size).toBe(3);
    expect(f.created).toHaveBeenCalledTimes(3); expect((await owner.state(f.signal)).pending).toBeNull();
    await owner.dispose();
  });
  it("does not submit when durable storage fails, and does not reveal a reply after account revocation", async () => {
    const f = fixture(), owner = f.newOwner(); await owner.state(f.signal);
    vi.mocked(f.store.create).mockRejectedValueOnce(new Error("disk full"));
    await expect(owner.submit(initial, f.signal)).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(1);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementationOnce(async (...args) => { const value = await original(...args); f.abort.abort(); return value; });
    await expect(owner.submit(initial, f.signal)).rejects.toThrow();
    expect(f.created).not.toHaveBeenCalled(); await owner.dispose();
  });
  it.each(["recoveryScope", "account", "creation_key"])("retains the intent when Core returns a different %s", async field => {
    const f = fixture(), owner = f.newOwner(); await owner.state(f.signal);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementationOnce(async (...args) => ({ ...await original(...args), [field]: field === "account" ? { email: "foreign@synthetic.invalid" } : crypto.randomUUID() }));
    await expect(owner.submit(initial, f.signal)).rejects.toThrow();
    expect(f.created).not.toHaveBeenCalled(); expect((await owner.state(f.signal)).pending).toEqual(initial); await owner.dispose();
  });
  it.each([
    { ...initial, patient: { kind: "existing", patientRef: "patient-name" } },
    { ...initial, patient: { kind: "new", name: " ", dateOfBirth: "1980-01-02" } },
    { ...initial, expected_actor_ref: "caller-selected" },
    { ...initial, appointmentAt: "2026-09-29T12:00:00" },
  ])("rejects ambiguous or extra encounter intent", value => expect(() => parseEncounterDraft(value)).toThrow());
});
