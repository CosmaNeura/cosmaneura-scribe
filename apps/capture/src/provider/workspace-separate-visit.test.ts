import { afterEach, expect, it, vi } from "vitest";
import { Surface } from "./test-workspace-surface";
import { mountProviderWorkspace, type AuthorizedProviderEncounter, type ProviderWorkspaceHost } from "./workspace";
import { parseCreatorReview } from "../../../review-ui/src/creator-review-api";
import { CaptureDeviceCustodyError } from "../capture/device-custody";
import type { EncounterDraft, EncounterSetupState, ProviderEncounterSetup } from "./encounter-setup";
import type { JournalSnapshot } from "./workspace-journal";

vi.mock("../capture-app", () => ({}));
vi.mock("../../../review-ui/src/creator-review-panel", () => ({ mountCreatorReview: vi.fn() }));
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
  state?: () => Promise<EncounterSetupState>; inaccessibleJournal?: boolean } = {}) {
  vi.stubGlobal("Element", Surface);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
  const root = new Surface(), abort = new AbortController();
  const oldEncounter = { appointmentRef: oldRef, title: "Synthetic patient", detail: "Synthetic visit",
    ...(options.patientRef === null ? {} : { patientRef: options.patientRef ?? patientRef }) };
  const newEncounter = { ...oldEncounter, appointmentRef: newRef };
  const request = vi.fn(async () => { throw Error("No capture or note request expected"); });
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
      openingReview: { scope, receivedAt: Date.now(), view: fresh ? null : view }, recorder,
      reviewJournal: () => ({ load: async () => null, save: vi.fn(), clear: vi.fn() }), openInCore: vi.fn() };
  };
  const setup = { state: vi.fn<ProviderEncounterSetup["state"]>(options.state ?? (async () => ({
    account: account.email, patients: [], moreResults: false, pending: null,
  }))), search: vi.fn<ProviderEncounterSetup["search"]>(),
    submit: vi.fn<ProviderEncounterSetup["submit"]>(async () => newEncounter) } satisfies ProviderEncounterSetup;
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
