import { afterEach, expect, it, vi } from "vitest";
import { Surface } from "./test-workspace-surface";
import { mountProviderWorkspace, type AuthorizedProviderEncounter, type ProviderWorkspaceHost } from "./workspace";
import { parseCreatorReview } from "../../../review-ui/src/creator-review-api";
import { CaptureDeviceCustodyError } from "../capture/device-custody";
import type { EncounterDraft, EncounterSetupState, ProviderEncounterSetup } from "./encounter-setup";
import type { JournalSnapshot } from "./workspace-journal";
import { mountPatientMatch } from "./patient-match-view";
import type { PatientIdentity } from "./visit-features";

vi.mock("../capture-app", () => ({}));
vi.mock("../../../review-ui/src/creator-review-panel", () => ({ mountCreatorReview: vi.fn() }));
vi.mock("./patient-match-view", () => ({ mountPatientMatch: vi.fn(() => vi.fn()) }));
// This fixture exercises the real workspace, not the unrelated microphone chooser DOM.
vi.mock("./preparation-controls", () => ({ bindPreparationControls: () => ({
  ready: () => false, snapshot: () => null, close: async () => undefined,
}) }));

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const suffix = "01j" + "0".repeat(23), patientRef = "patient_" + suffix;
const oldRef = "appointment_" + suffix, newRef = oldRef.slice(0, -1) + "1";
const account = { email: "synthetic@example.test", environment: "Staging" };
const empty = (): JournalSnapshot => ({ revision: null, progress: null });
const pending: EncounterDraft = { creationKey: id(9), patient: { kind: "existing", patientRef },
  appointmentAt: "2026-10-27T12:00:00Z", title: "Visit" };
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); vi.unstubAllGlobals(); });

function fixture(options: { status?: "created" | "capturing"; patientRef?: string | null; setup?: boolean;
  state?: () => Promise<EncounterSetupState>; inaccessibleJournal?: boolean; identity?: PatientIdentity;
  operationFailure?: "unavailable" | "conflict" | "generic";
  prefetchedFailure?: "unavailable" | "conflict" } = {}) {
  vi.stubGlobal("Element", Surface);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
  const root = new Surface(), abort = new AbortController();
  const oldEncounter = { appointmentRef: oldRef, title: "Synthetic patient", detail: "Synthetic visit",
    ...(options.identity ? { identity: options.identity } : {}),
    ...(options.patientRef === null ? {} : { patientRef: options.patientRef ?? patientRef }) };
  const newEncounter = { ...oldEncounter, appointmentRef: newRef,
    ...(options.identity && options.identity.state !== "provisional" ? { patientRef: options.identity.canonicalPatientRef } : {}) };
  const request = vi.fn(async () => {
    if (options.operationFailure) return Response.json({ detail: options.operationFailure === "generic"
      ? "provider_request_unconfirmed" : `provider_operation_${options.operationFailure}` }, { status: 409 });
    throw Error("No capture or note request expected");
  });
  const recorder = vi.fn(async () => { throw Error("No recorder expected"); });
  const journal = { load: vi.fn(async () => {
    if (options.inaccessibleJournal) throw new CaptureDeviceCustodyError();
    return empty();
  }), save: vi.fn() };
  const newJournal = { load: vi.fn(async () => empty()), save: vi.fn() };
  const view = parseCreatorReview({ schema_version: "1.0", session_id: id(2), status: options.status ?? "created",
    source: null, working: null, review_queue: null }, id(2));
  const mounted = (fresh: boolean): AuthorizedProviderEncounter => {
    const encounter = fresh ? newEncounter : oldEncounter;
    const scope = { appointmentRef: encounter.appointmentRef, bindingRef: "scribe_capture_binding_" + suffix,
      workspaceId: fresh ? id(3) : id(1) };
    return { encounter, scope, request, signal: abort.signal, journal: fresh ? newJournal : journal,
      ...(!fresh && options.operationFailure ? {} : !fresh && options.prefetchedFailure
        ? { openingRecovery: { scope, receivedAt: Date.now(), reason: options.prefetchedFailure } }
        : { openingReview: { scope, receivedAt: Date.now(), view: fresh ? null : view } }), recorder,
      reviewJournal: () => ({ load: async () => null, save: vi.fn(), clear: vi.fn() }), openInCore: vi.fn() };
  };
  const setup = { state: vi.fn<ProviderEncounterSetup["state"]>(options.state ?? (async () => ({
    account: account.email, patients: [], moreResults: false, pending: null,
  }))), search: vi.fn<ProviderEncounterSetup["search"]>(),
    submit: vi.fn<ProviderEncounterSetup["submit"]>(async () => newEncounter),
    patientMatchJournal: vi.fn(async () => ({ local: () => null, retain: vi.fn(async () => undefined) })),
    patientCandidates: vi.fn(), matchPatient: vi.fn(),
  } satisfies ProviderEncounterSetup;
  const host: ProviderWorkspaceHost = { signal: abort.signal, account,
    listEncounters: vi.fn(async () => [oldEncounter]), createEncounter: vi.fn(),
    openEncounter: vi.fn(async ref => mounted(ref === newRef)),
    ...(options.setup === false ? {} : { encounterSetup: setup }) };
  disposers.push(mountProviderWorkspace(root as unknown as HTMLElement, host));
  const content = root.querySelector("[data-workspace-content]")!;
  const click = async (action: string, retained?: Surface): Promise<void> => {
    await vi.waitFor(() => expect(root.attributes.has("aria-busy")).toBe(false));
    const button = retained ?? content.querySelector(`[data-workspace-action="${action}"]`) ?? new Surface();
    button.dataset.workspaceAction = action; button.dataset.appointment = oldRef;
    const event = new Event("click"); Object.defineProperty(event, "target", { value: button }); root.dispatchEvent(event);
    await vi.waitFor(() => expect(root.attributes.has("aria-busy")).toBe(false));
  };
  return { root, content, click, host, setup, request, recorder, journal, newJournal, abort };
}

it.each(["unavailable", "conflict"] as const)("offers explicit separate-visit recovery for a closed %s disposition", async operationFailure => {
  const f = fixture({ operationFailure }); await f.click("open");
  expect(f.content.innerHTML).toContain("Start a separate visit");
  expect(f.content.innerHTML).toContain("saved work remains unchanged");
  expect(f.setup.submit).not.toHaveBeenCalled(); expect(f.journal.save).not.toHaveBeenCalled();
  await f.click("new-visit-same-patient");
  expect(f.setup.submit).toHaveBeenCalledOnce();
  expect(f.content.innerHTML).toContain('name="consent"');
  expect(f.recorder).not.toHaveBeenCalled(); expect(f.journal.save).not.toHaveBeenCalled();
});

it.each(["unavailable", "conflict"] as const)("uses an independently mounted prefetched %s recovery without retrying the operation", async prefetchedFailure => {
  const f = fixture({ prefetchedFailure }); await f.click("open");
  expect(f.content.innerHTML).toContain("Start a separate visit");
  expect(f.content.innerHTML).toContain("saved work remains unchanged");
  expect(f.request).not.toHaveBeenCalled();
  expect(f.setup.submit).not.toHaveBeenCalled(); expect(f.journal.save).not.toHaveBeenCalled();
  await f.click("new-visit-same-patient");
  expect(f.request).not.toHaveBeenCalled(); expect(f.setup.submit).toHaveBeenCalledOnce();
  expect(f.content.innerHTML).toContain('name="consent"');
  expect(f.recorder).not.toHaveBeenCalled(); expect(f.journal.save).not.toHaveBeenCalled();
});

it("does not offer separate-visit recovery for a generic 409", async () => {
  const f = fixture({ operationFailure: "generic" }); await f.click("open");
  expect(f.content.innerHTML).toContain("Visit could not open");
  expect(f.content.innerHTML).not.toContain('data-workspace-action="new-visit-same-patient"');
  expect(f.setup.submit).not.toHaveBeenCalled(); expect(f.journal.save).not.toHaveBeenCalled();
});

it.each(["created", "capturing"] as const)("creates a separate visit for the same patient only after explicit choice from %s", async status => {
  const f = fixture({ status }); await f.click("open");
  expect(f.content.innerHTML).toContain("Recording access needed on this device");
  expect(f.content.innerHTML).toContain("earlier visit and its saved work will stay unchanged");
  expect(f.setup.submit).not.toHaveBeenCalled();
  const button = f.content.querySelector('[data-workspace-action="new-visit-same-patient"]')!;
  await f.click("new-visit-same-patient", button);
  expect(f.setup.state).toHaveBeenCalledOnce(); expect(f.setup.submit).toHaveBeenCalledOnce();
  expect(vi.mocked(f.setup.submit).mock.calls[0]![0]).toEqual({ creationKey: expect.any(String),
    patient: { kind: "existing", patientRef }, appointmentAt: expect.any(String), title: "Visit" });
  expect(f.host.openEncounter).toHaveBeenLastCalledWith(newRef, expect.any(AbortSignal));
  expect(f.content.innerHTML).toContain('name="consent"');
  expect(f.content.innerHTML).toContain('data-workspace-action="prepare"');
  expect(f.recorder).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  expect(f.journal.save).not.toHaveBeenCalled(); expect(f.newJournal.save).not.toHaveBeenCalled();
  // A retained button cannot create another visit after its screen is replaced.
  await f.click("new-visit-same-patient", button); expect(f.setup.submit).toHaveBeenCalledOnce();
});

it("does not replace or automatically resubmit a pending creation request", async () => {
  const f = fixture({ state: async () => ({ account: account.email, patients: [], moreResults: false, pending }) });
  await f.click("open"); await f.click("new-visit-same-patient");
  expect(f.setup.submit).not.toHaveBeenCalled(); expect(f.host.openEncounter).toHaveBeenCalledOnce();
  expect(f.content.innerHTML).toContain('data-workspace-action="retry-creation"');
  expect(f.journal.save).not.toHaveBeenCalled();
});

it.each(["journal", "patient", "setup"])("does not offer a new-visit shortcut when %s authority is missing", async missing => {
  const f = fixture({ inaccessibleJournal: missing === "journal", patientRef: missing === "patient" ? null : patientRef,
    setup: missing !== "setup" });
  await f.click("open");
  expect(f.content.innerHTML).not.toContain('data-workspace-action="new-visit-same-patient"');
  await f.click("new-visit-same-patient"); expect(f.setup.submit).not.toHaveBeenCalled();
  expect(f.journal.save).not.toHaveBeenCalled(); expect(f.recorder).not.toHaveBeenCalled();
});

it("refuses a changed account before creating the separate visit", async () => {
  const f = fixture({ state: async () => ({ account: "different@example.test", patients: [], moreResults: false, pending: null }) });
  await f.click("open"); await f.click("new-visit-same-patient");
  expect(f.setup.submit).not.toHaveBeenCalled(); expect(f.host.openEncounter).toHaveBeenCalledOnce();
  expect(f.journal.save).not.toHaveBeenCalled();
});

it("does not create after authorization ends during setup", async () => {
  let resolve!: (state: EncounterSetupState) => void;
  const f = fixture({ state: () => new Promise(done => { resolve = done; }) });
  await f.click("open"); const click = f.click("new-visit-same-patient");
  await vi.waitFor(() => expect(f.setup.state).toHaveBeenCalledOnce()); f.abort.abort();
  resolve({ account: account.email, patients: [], moreResults: false, pending: null }); await click;
  expect(f.setup.submit).not.toHaveBeenCalled(); expect(f.journal.save).not.toHaveBeenCalled();
});

const provisional: PatientIdentity = { state: "provisional", version: 0, canonicalPatientRef: patientRef, name: "Synthetic patient", dateOfBirth: null };
it("requires explicit provisional confirmation, then creates only after the separate new-visit choice", async () => {
  const f = fixture({ identity: provisional }); await f.click("open");
  expect(f.content.innerHTML).toContain('data-workspace-action="confirm-patient-for-new-visit"');
  expect(f.content.innerHTML).not.toContain('data-workspace-action="new-visit-same-patient"');
  await f.click("new-visit-same-patient"); expect(f.setup.submit).not.toHaveBeenCalled();
  await f.click("confirm-patient-for-new-visit");
  const options = vi.mocked(mountPatientMatch).mock.calls.at(-1)![1];
  expect(f.setup.patientMatchJournal).toHaveBeenCalledOnce(); expect(f.journal.save).not.toHaveBeenCalled();
  options.updated({ ...provisional, state: "confirmed", version: 1 });
  await vi.waitFor(() => expect(f.content.innerHTML).toContain('data-workspace-action="new-visit-same-patient"'));
  expect(f.setup.submit).not.toHaveBeenCalled();
  await f.click("new-visit-same-patient");
  expect(f.setup.submit.mock.calls[0]![0]?.patient).toEqual({ kind: "existing", patientRef });
  expect(f.content.innerHTML).toContain('name="consent"'); expect(f.recorder).not.toHaveBeenCalled(); expect(f.journal.save).not.toHaveBeenCalled();
});

it("uses the authorized canonical patient after matching, not the provisional source", async () => {
  const canonical = patientRef.slice(0, -1) + "2";
  const f = fixture({ identity: { ...provisional, state: "matched", version: 1, canonicalPatientRef: canonical } });
  await f.click("open"); await f.click("new-visit-same-patient");
  expect(f.setup.submit.mock.calls[0]![0]?.patient).toEqual({ kind: "existing", patientRef: canonical });
  expect(f.content.innerHTML).toContain('name="consent"');
});

it("retains the original pending creation after confirmation and requires its explicit result check", async () => {
  const f = fixture({ identity: provisional, state: async () => ({ account: account.email, patients: [], moreResults: false, pending }) });
  await f.click("open"); await f.click("confirm-patient-for-new-visit");
  vi.mocked(mountPatientMatch).mock.calls.at(-1)![1].updated({ ...provisional, state: "confirmed", version: 1 });
  await vi.waitFor(() => expect(f.content.innerHTML).toContain('data-workspace-action="new-visit-same-patient"'));
  await f.click("new-visit-same-patient"); expect(f.setup.submit).not.toHaveBeenCalled();
  expect(f.content.innerHTML).toContain('data-workspace-action="retry-creation"');
  await f.click("retry-creation"); expect(f.setup.submit).toHaveBeenCalledWith(pending, expect.any(AbortSignal));
  expect(f.journal.save).not.toHaveBeenCalled();
});

it("ignores confirmation that arrives after account closure", async () => {
  const f = fixture({ identity: provisional }); await f.click("open"); await f.click("confirm-patient-for-new-visit");
  const options = vi.mocked(mountPatientMatch).mock.calls.at(-1)![1]; f.abort.abort();
  options.updated({ ...provisional, state: "confirmed", version: 1 }); await Promise.resolve();
  expect(f.setup.submit).not.toHaveBeenCalled(); expect(f.journal.save).not.toHaveBeenCalled();
});

it("does not replace an older pending creation with a different matched canonical patient", async () => {
  const canonical = patientRef.slice(0, -1) + "2";
  const f = fixture({ identity: { ...provisional, state: "matched", version: 1, canonicalPatientRef: canonical },
    state: async () => ({ account: account.email, patients: [], moreResults: false, pending }) });
  await f.click("open"); await f.click("new-visit-same-patient");
  expect(f.setup.submit).not.toHaveBeenCalled();
  expect(f.content.innerHTML).toContain("previous creation request is saved securely");
  expect(pending.patient).toEqual({ kind: "existing", patientRef });
});
