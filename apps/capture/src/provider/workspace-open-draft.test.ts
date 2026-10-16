import { Surface } from "./test-workspace-surface";
import { afterEach, expect, it, vi } from "vitest";
import { parseCreatorReview, type CreatorReviewView } from "../../../review-ui/src/creator-review-api";
import { mountCreatorReview } from "../../../review-ui/src/creator-review-panel";
import type { CreatorReviewOptions } from "../../../review-ui/src/creator-review-panel";
import { mountProviderWorkspace, type AuthorizedProviderEncounter, type ProviderWorkspaceHost, type ProviderEncounter } from "./workspace";
import type { JournalSnapshot } from "./workspace-journal";
import type { AuthorizedCoreRequest } from "./core-client";

// Only the unused recording element registration and review mount boundary are replaced.
// The provider's real event handlers, scope checks, journal recovery and Core wire parser run.
// The actual mounted review controller is covered in creator-review-initial-action.test.ts.
vi.mock("../capture-app", () => ({}));
vi.mock("../../../review-ui/src/creator-review-panel", () => ({ mountCreatorReview: vi.fn(() => vi.fn()) }));
const mounted = vi.mocked(mountCreatorReview);
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const suffix = "01j" + "0".repeat(23), ref = "appointment_" + suffix;
const scope = { appointmentRef: ref, bindingRef: "scribe_capture_binding_" + suffix, workspaceId: id(1) };
const encounter: ProviderEncounter = { appointmentRef: ref, title: "Invented visit", detail: "Synthetic fixture", status: "draft_ready" };
const ready = () => parseCreatorReview({ schema_version: "1.0", session_id: id(2), status: "transcript_ready",
  source: { source_transcript_version: 1, segments: [{ source_segment_id: id(3), source_segment_version: 1,
    source_locale: "en-US", speaker_role: "unknown", content: "Invented source.", start_ms: 0, end_ms: 1000 }] },
  working: { source_transcript_version: 1, working_transcript_id: id(4), working_transcript_version: 1,
    note_ready: true, blockers: [], segments: [{ source_segment_id: id(3), source_segment_version: 1,
      resolution: "english_source", content: "Invented source." }] },
  review_queue: { schema_version: "1.0", session_id: id(2), source_transcript_version: 1,
    working_transcript_id: id(4), working_transcript_version: 1, status: "complete", items: [] },
}, id(2));
const saved = (): JournalSnapshot => ({ revision: "1", progress: { admission: null, sessionId: id(2), uploaded: true, pendingSave: null } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function mount(options: { catalog?: ProviderEncounter[]; snapshot?: JournalSnapshot; view?: CreatorReviewView | null;
  load?: () => Promise<JournalSnapshot>; receivedAt?: number; request?: AuthorizedCoreRequest; denied?: boolean } = {}) {
  vi.stubGlobal("Element", Surface);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
  const root = new Surface(), abort = new AbortController();
  const request = vi.fn<AuthorizedCoreRequest>(options.request ?? (async (_path, body) => Response.json({ ...body,
    contract_version: "1", checked_at: new Date().toISOString(), operation: "creator_review", receipt: options.view ?? ready() })));
  const journal = { load: vi.fn(options.load ?? (async () => options.snapshot ?? saved())),
    save: vi.fn(async (_previous, progress) => ({ revision: "2", progress })) };
  const recorder = vi.fn(async () => { throw new Error("No recorder may be acquired by Open draft"); });
  const active: AuthorizedProviderEncounter = { encounter, scope, request, signal: abort.signal, journal,
    openingReview: { scope, receivedAt: options.receivedAt ?? Date.now(), view: options.view === undefined ? ready() : options.view },
    reviewJournal: () => ({ load: async () => null, save: vi.fn(), clear: vi.fn() }), recorder, openInCore: vi.fn() };
  const host: ProviderWorkspaceHost = { signal: abort.signal,
    listEncounters: vi.fn(async () => options.catalog ?? [encounter]),
    openEncounter: vi.fn(async () => { if (options.denied) throw new Error("Synthetic denied mount"); return active; }), createEncounter: vi.fn() };
  const dispose = mountProviderWorkspace(root as unknown as HTMLElement, host); disposers.push(dispose);
  const content = root.querySelector("[data-workspace-content]")!, notice = root.querySelector("[data-workspace-notice]")!;
  const click = async (action: string, appointment = ref): Promise<void> => {
    await vi.waitFor(() => expect(root.attributes.has("aria-busy")).toBe(false));
    const button = new Surface(); button.dataset.workspaceAction = action; button.dataset.appointment = appointment;
    const event = new Event("click"); Object.defineProperty(event, "target", { value: button }); root.dispatchEvent(event);
    await vi.waitFor(() => expect(root.attributes.has("aria-busy")).toBe(false));
  };
  return { root, content, notice, host, request, journal, recorder, click, abort, dispose };
}
const lastOptions = (): CreatorReviewOptions => mounted.mock.lastCall![2]!;

it.each(["open-draft", "open"])("propagates only the explicit %s intent after authorized mount and saved journal", async action => {
  const f = mount(); await vi.waitFor(() => expect(f.content.innerHTML).toContain("Open note"));
  await f.click(action);
  expect(f.host.openEncounter).toHaveBeenCalledOnce(); expect(f.journal.load).toHaveBeenCalledOnce();
  expect(mounted).toHaveBeenCalledOnce(); expect(lastOptions().initialAction).toBe(action === "open-draft" ? action : undefined);
  expect(f.recorder).not.toHaveBeenCalled(); expect(f.journal.save).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled(); // Current host read reused only before the later fresh note-opening check.
});
it("refreshes the same authorized visit without admission, recorder acquisition, or replaying a save", async () => {
  const f = mount(); await vi.waitFor(() => expect(f.content.innerHTML).toContain("Open note"));
  await f.click("open");
  await f.click("refresh-visit");
  expect(f.host.openEncounter).toHaveBeenCalledTimes(2);
  expect(f.host.openEncounter).toHaveBeenLastCalledWith(ref, expect.any(AbortSignal));
  expect(f.journal.load).toHaveBeenCalledTimes(2);
  expect(f.recorder).not.toHaveBeenCalled();
  expect(f.journal.save).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
});
it.each(["ready", "recording_saved", "processing", undefined])("does not expose or honor a shortcut for catalog status %s", async status => {
  const f = mount({ catalog: [{ appointmentRef: ref, title: "Invented", detail: "Fixture", ...(status ? { status: status as NonNullable<ProviderEncounter["status"]> } : {}) }] });
  await vi.waitFor(() => expect(f.content.innerHTML).toContain("Authorized encounters"));
  expect(f.content.innerHTML).not.toContain('data-workspace-action="open-draft"');
  await f.click("open-draft"); expect(f.host.openEncounter).not.toHaveBeenCalled(); expect(mounted).not.toHaveBeenCalled();
});
it.each(["created", "capturing"])("never acquires or starts recording when the fresh visit is %s", async status => {
  const view = parseCreatorReview({ schema_version: "1.0", session_id: id(2), status, source: null, working: null, review_queue: null }, id(2));
  const f = mount({ view }); await f.click("open-draft");
  expect(mounted).toHaveBeenCalledOnce(); expect(lastOptions().initialAction).toBeUndefined();
  expect(f.recorder).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  expect(f.notice.textContent).toContain("saved draft is not available");
});
it("does not revive a consumed catalog action while a review is displayed", async () => {
  const f = mount(); await f.click("open-draft"); await f.click("open-draft");
  expect(f.host.openEncounter).toHaveBeenCalledOnce(); expect(mounted).toHaveBeenCalledOnce();
});
it("loads the workspace journal before consuming any review action", async () => {
  const gate = deferred<JournalSnapshot>(); const f = mount({ load: () => gate.promise });
  const click = f.click("open-draft"); await vi.waitFor(() => expect(f.journal.load).toHaveBeenCalledOnce());
  expect(mounted).not.toHaveBeenCalled(); gate.resolve(saved()); await click;
  expect(lastOptions().initialAction).toBe("open-draft");
});
it("keeps a pending note save in explicit recovery without opening or writing", async () => {
  const snapshot = saved();
  const pending = { schema: "doctor_note_schema_" + suffix,
    source: { kind: "reviewed_english" as const, source_version: 1, working_transcript_id: id(4), working_version: 1 }, fieldOrder: ["Plan"],
    edit: { client_key: id(5), expected_note_ref: "visit_note_" + suffix, expected_note_sha256: "a".repeat(64), expected_source_sha256: "b".repeat(64), fields: { Plan: "Invented edit" } } };
  const f = mount({ snapshot: { ...snapshot, progress: { ...snapshot.progress!, pendingSave: pending } },
    request: async () => new Response(null, { status: 403 }) });
  await f.click("open-draft"); expect(f.content.innerHTML).toContain("Confirm your previous save");
  expect(mounted).not.toHaveBeenCalled(); expect(f.recorder).not.toHaveBeenCalled(); expect(f.journal.save).not.toHaveBeenCalled();
  expect(f.request.mock.calls.every(([, body]) => body.action === "save_status")).toBe(true);
});
it.each(["mount-denied", "journal-denied"])("does not retain draft intent after %s recovery", async kind => {
  const load = vi.fn(async () => { if (kind === "journal-denied") throw new Error("Synthetic unavailable journal"); return saved(); });
  const f = mount({ denied: kind === "mount-denied", load }); await f.click("open-draft");
  expect(mounted).not.toHaveBeenCalled(); expect(f.recorder).not.toHaveBeenCalled();
  expect(f.content.innerHTML).toContain('data-workspace-action="open"'); // Recovery remains ordinary open, never deferred intent.
});
it("rejects a late journal result after disposal", async () => {
  const gate = deferred<JournalSnapshot>(), f = mount({ load: () => gate.promise });
  const click = f.click("open-draft"); await vi.waitFor(() => expect(f.journal.load).toHaveBeenCalledOnce());
  await f.dispose(); gate.resolve(saved()); await click;
  expect(mounted).not.toHaveBeenCalled(); expect(f.recorder).not.toHaveBeenCalled();
});
it("refreshes stale opening status before passing the shortcut to review", async () => {
  const f = mount({ receivedAt: Date.now() - 6000 }); await f.click("open-draft");
  expect(f.request).toHaveBeenCalledOnce(); expect(f.request.mock.calls[0]![1].operation).toEqual({ kind: "creator_review" });
  expect(lastOptions().initialAction).toBe("open-draft"); expect(f.recorder).not.toHaveBeenCalled();
});
it.each(["missing", "created", "capturing", "transcript_ready"])("handles %s discovery on a new device without recording custody", async status => {
  const view = status === "missing" ? null : status === "transcript_ready" ? ready()
    : parseCreatorReview({ schema_version: "1.0", session_id: id(2), status, source: null, working: null, review_queue: null }, id(2));
  const f = mount({ snapshot: { revision: null, progress: null }, view }); await f.click("open-draft");
  expect(f.recorder).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  if (status === "transcript_ready") {
    expect(f.journal.save).toHaveBeenCalledOnce(); expect(lastOptions().initialAction).toBe("open-draft");
  } else {
    expect(mounted).not.toHaveBeenCalled(); expect(f.journal.save).not.toHaveBeenCalled();
    expect(f.content.innerHTML).toContain(status === "missing" ? "Draft not available" : "Recording access needed");
    expect(f.content.innerHTML).not.toContain('data-workspace-action="prepare"');
  }
});
it("adds a shortcut only when a pending row receives fresh authorized draft evidence", async () => {
  vi.useFakeTimers(); const f = mount({ catalog: [{ ...encounter, status: "processing" }] });
  await vi.waitFor(() => expect(f.content.innerHTML).toContain("Authorized encounters"));
  const list = f.content.querySelector(".provider-encounters")!, row = list.rows[0]!;
  vi.mocked(f.host.listEncounters).mockResolvedValueOnce([encounter]);
  await vi.advanceTimersByTimeAsync(3000);
  expect(row.innerHTML).toContain("Open note");
  await f.click("open-draft"); expect(lastOptions().initialAction).toBe("open-draft");
});
it("removes an unauthorized pending row and rejects removed or forged shortcut references", async () => {
  vi.useFakeTimers(); const f = mount({ catalog: [{ ...encounter, status: "processing" }] });
  await vi.waitFor(() => expect(f.content.innerHTML).toContain("Authorized encounters"));
  const row = f.content.querySelector(".provider-encounters")!.rows[0]!;
  vi.mocked(f.host.listEncounters).mockResolvedValueOnce([]);
  await vi.advanceTimersByTimeAsync(3000); expect(row.isConnected).toBe(false);
  await f.click("open-draft"); await f.click("open-draft", ref.slice(0, -1) + "9");
  expect(f.host.openEncounter).not.toHaveBeenCalled(); expect(mounted).not.toHaveBeenCalled();
});
it.each([0, 2])("preserves explicit normal note flow for %s templates and never generates", async count => {
  const f = mount({ request: async (_path, body) => Response.json({ ...body, contract_version: "1", checked_at: new Date().toISOString(), action: "templates",
    receipt: { session_id: id(2), templates: Array.from({ length: count }, (_, i) => ({ schema_ref: "doctor_note_schema_" + suffix.slice(0, -1) + i, note_type: "Synthetic SOAP", field_names: ["Plan"] })) } }) });
  await f.click("open-draft"); await lastOptions().continueToNote!(ready());
  expect(f.content.innerHTML).toContain(count === 0 ? "No templates are available" : "Choose your note template");
  expect(f.request).toHaveBeenCalledOnce(); expect(f.request.mock.calls[0]![1].action).toBe("templates");
  expect(f.recorder).not.toHaveBeenCalled();
});
