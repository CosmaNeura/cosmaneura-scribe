import { Surface } from "./test-workspace-surface";
import { afterEach, expect, it, vi } from "vitest";
import { parseCaptureContinuity, parseCreatorReview, type CreatorReviewView } from "../../../review-ui/src/creator-review-api";
import { mountCreatorReview } from "../../../review-ui/src/creator-review-panel";
import type { CreatorReviewOptions } from "../../../review-ui/src/creator-review-panel";
import type * as CreatorPanel from "../../../review-ui/src/creator-review-panel";
import { mountProviderWorkspace, type AuthorizedProviderEncounter, type ProviderWorkspaceHost, type ProviderEncounter } from "./workspace";
import { appendNotePreparationSuccessor, assertProgress, MAX_NOTE_PREPARATION_SUCCESSORS, NativeProviderWorkspaceJournal, type JournalSnapshot, type ProviderProgress } from "./workspace-journal";
import type { AuthorizedCoreRequest } from "./core-client";
import { canonical, pendingSave, parseDraft, reviewedSource, sha256 } from "./core-notes";

// Only unused recording registration, transcript tools/navigation and review mount are replaced.
// The provider's real event handlers, scope checks, journal recovery and Core wire parser run.
// The actual mounted review controller is covered in creator-review-initial-action.test.ts.
vi.mock("../capture-app", () => ({}));
vi.mock("../../../review-ui/src/creator-review-panel", async () => ({
  ...await vi.importActual<typeof CreatorPanel>("../../../review-ui/src/creator-review-panel"),
  mountCreatorReview: vi.fn(() => vi.fn()), bindTranscriptTools: () => vi.fn(),
}));
vi.mock("./note-source-navigation", () => ({ bindNoteSourceNavigation: () => ({ refresh: vi.fn(), dispose: vi.fn() }) }));
const mounted = vi.mocked(mountCreatorReview);
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const suffix = "01j" + "0".repeat(23), ref = "appointment_" + suffix;
const scope = { appointmentRef: ref, bindingRef: "scribe_capture_binding_" + suffix, workspaceId: id(1) };
const encounter: ProviderEncounter = { appointmentRef: ref, title: "Invented visit", detail: "Synthetic fixture", status: "draft_ready" };
const ready = (version = 4, workingId = id(4)) => parseCreatorReview({ schema_version: "1.0", session_id: id(2), status: "transcript_ready",
  source: { source_transcript_version: 1, segments: [{ source_segment_id: id(3), source_segment_version: 1,
    source_locale: "en-US", speaker_role: "unknown", content: "Invented source.", start_ms: 0, end_ms: 1000 }] },
  working: { source_transcript_version: 1, working_transcript_id: workingId, working_transcript_version: version,
    note_ready: true, blockers: [], segments: [{ source_segment_id: id(3), source_segment_version: 1,
      resolution: "english_source", content: "Invented source." }] },
  review_queue: { schema_version: "1.0", session_id: id(2), source_transcript_version: 1,
    working_transcript_id: workingId, working_transcript_version: version, status: "complete", items: [] },
}, id(2));
const saved = (): JournalSnapshot => ({ revision: "1", progress: { admission: null, sessionId: id(2), uploaded: true, pendingSave: null } });
function optionsJournal(initial: JournalSnapshot) {
  let progress = structuredClone(initial.progress), revision = Number(initial.revision);
  const data = () => btoa(JSON.stringify({ version: 2, recoveryScope: id(5), scope, progress }));
  const plugin = {
    get: vi.fn(async () => ({ key: `provider-workspace-v1:${id(5)}:${scope.workspaceId}`, revision: String(revision), data: data() })),
    create: vi.fn(),
    compareAndSwap: vi.fn(async (request: { expectedRevision: string; data: string }) => {
      if (request.expectedRevision !== String(revision)) throw new Error("Synthetic CAS conflict");
      const decoded = JSON.parse(atob(request.data)) as { progress: ProviderProgress };
      progress = decoded.progress; revision += 1;
      return { revision: String(revision) };
    }),
  };
  const journal = new NativeProviderWorkspaceJournal(plugin, id(5), scope);
  return { load: vi.fn(() => journal.load()), save: vi.fn((previous: JournalSnapshot, next: ProviderProgress) => journal.save(previous, next)),
    plugin, snapshot: (): JournalSnapshot => ({ revision: String(revision), progress: structuredClone(progress) }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function mount(options: { catalog?: ProviderEncounter[]; snapshot?: JournalSnapshot; view?: CreatorReviewView | null;
  receivedAt?: number; request?: AuthorizedCoreRequest; denied?: boolean } = {}) {
  vi.stubGlobal("Element", Surface);
  vi.stubGlobal("HTMLTextAreaElement", class extends Surface {});
  vi.stubGlobal("window", { scrollX: 0, scrollY: 0, scrollTo: vi.fn(), matchMedia: () => ({ matches: false }) });
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
  const root = new Surface(), abort = new AbortController();
  const request = vi.fn<AuthorizedCoreRequest>(options.request ?? (async (_path, body) => Response.json({ ...body,
    contract_version: "1", checked_at: new Date().toISOString(), operation: "creator_review", receipt: options.view ?? ready() })));
  const journal = optionsJournal(options.snapshot ?? saved());
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
    const button = content.querySelector(`[data-workspace-action="${action}"]`) ?? new Surface(); button.dataset.workspaceAction = action; button.dataset.appointment = appointment;
    const event = new Event("click"); Object.defineProperty(event, "target", { value: button }); root.dispatchEvent(event);
    await vi.waitFor(() => expect(root.attributes.has("aria-busy")).toBe(false));
  };
  return { root, content, notice, host, request, journal, recorder, click, abort, dispose };
}
const lastOptions = (): CreatorReviewOptions => mounted.mock.lastCall![2]!;

const schema = "doctor_note_schema_" + suffix;
const noteValue = async (draft = false, view = ready(), text = "No plan discussed.") => ({
  session_id: id(2), scribe_source_id: view.working!.working_transcript_id, source_sha256: "a".repeat(64), schema_ref: schema,
  transcript_ref: draft ? "ai_visit_transcript_" + suffix : null, note_ref: draft ? "visit_note_" + suffix : null,
  status: draft ? "draft" : "not_prepared", note_type: "Synthetic SOAP", fields: draft ? { Plan: text } : null,
  field_order: draft ? ["Plan"] : null, note_sha256: draft ? await sha256(JSON.stringify([["Plan", text]])) : null,
  created_at: draft ? new Date().toISOString() : null, review_required: true, reviewed_source: reviewedSource(view),
});

const original = () => ({ state: "submitted" as const, key: id(6), schema, source: reviewedSource(ready(1)) });
const retained = (): JournalSnapshot => ({ revision: "1", progress: { ...saved().progress!, notePreparation: original() } });
function wire(onPrepare?: (key: string, body: Readonly<Record<string, unknown>>) => Promise<Response>) {
  const preparations: string[] = [];
  let current = ready(), draft = false;
  const request: AuthorizedCoreRequest = async (_path, body, key) => {
    const response = (receipt: unknown) => Response.json({ ...body, contract_version: "1", checked_at: new Date().toISOString(),
      ...(body.operation ? { operation: "creator_review" } : { action: body.action }), receipt });
    if (body.operation) return response(current);
    if (body.action === "templates") return response({ session_id: id(2), templates: [{ schema_ref: schema, note_type: "Synthetic SOAP", field_names: ["Plan"] }] });
    if (body.action === "prepare") {
      preparations.push(key);
      if (onPrepare) return onPrepare(key, body);
      draft = true;
    }
    return response(await noteValue(draft, current));
  };
  return { request, preparations, advance: (view: CreatorReviewView) => { current = view; }, setDraft: () => { draft = true; } };
}
async function openUpdated(f: ReturnType<typeof mount>, view = ready()) {
  await f.click("open"); await lastOptions().continueToNote!(view);
  expect(f.content.innerHTML).toContain("Transcript updated");
}

it("appends an explicit v4 preparation, preserves the original key/source and shows only the current reviewed draft", async () => {
  const w = wire(), f = mount({ snapshot: retained(), request: w.request });
  await openUpdated(f);
  expect(w.preparations).toEqual([]);
  await f.click("prepare-updated-note");
  expect(w.preparations).toHaveLength(1); expect(w.preparations[0]).not.toBe(id(6));
  const next = await f.journal.load();
  expect(next.progress?.notePreparation).toEqual(original());
  expect(next.progress?.notePreparationSuccessors).toEqual([{ state: "submitted", key: w.preparations[0], schema, source: reviewedSource(ready()) }]);
  expect(f.content.innerHTML).toContain("Clinical review is still required.");
  expect(f.recorder).not.toHaveBeenCalled();
});

it("a CAS loser sends no prepare and preserves the previous submitted request", async () => {
  const w = wire(), f = mount({ snapshot: retained(), request: w.request });
  await openUpdated(f);
  vi.mocked(f.journal.save).mockRejectedValueOnce(new Error("Synthetic CAS loser"));
  await f.click("prepare-updated-note");
  expect(w.preparations).toEqual([]); expect((await f.journal.load()).progress?.notePreparation).toEqual(original());
});

it("rejects a source advance before append or a foreign working transcript", async () => {
  const w = wire(), f = mount({ snapshot: retained(), request: w.request });
  await openUpdated(f); w.advance(ready(5));
  await f.click("prepare-updated-note"); expect(w.preparations).toEqual([]);
  expect((await f.journal.load()).progress?.notePreparationSuccessors).toBeUndefined();
  await expect(lastOptions().continueToNote!(ready(4, id(9)))).rejects.toThrow();
});

it("rejects a source advance between append and the prepare reply, retaining both request identities", async () => {
  const w = wire(async (_key, body) => {
    w.advance(ready(5));
    return Response.json({ ...body, contract_version: "1", checked_at: new Date().toISOString(), action: "prepare", receipt: await noteValue(true, ready(5)) });
  });
  const f = mount({ snapshot: retained(), request: w.request }); await openUpdated(f); await f.click("prepare-updated-note");
  expect(w.preparations).toHaveLength(1);
  expect((await f.journal.load()).progress?.notePreparationSuccessors?.[0]?.source.working_version).toBe(4);
  expect(f.content.innerHTML).not.toContain("Clinical review is still required.");
  expect(f.content.querySelector('[data-workspace-action="retry-updated-note"]')?.disabled).toBe(true);
});

it("uncertain preparation recovers by reads and suppresses a duplicate explicit click", async () => {
  const pending = deferred<Response>(); const w = wire(() => pending.promise);
  const f = mount({ snapshot: retained(), request: w.request }); await openUpdated(f);
  const flight = f.click("prepare-updated-note");
  await vi.waitFor(() => expect(w.preparations).toHaveLength(1));
  const second = f.content.querySelector('[data-workspace-action="prepare-updated-note"]') ?? new Surface();
  second.dataset.workspaceAction = "prepare-updated-note";
  const event = new Event("click"); Object.defineProperty(event, "target", { value: second }); f.root.dispatchEvent(event);
  pending.resolve(Response.json({}, { status: 503 })); await flight;
  await vi.waitFor(() => expect(f.content.querySelector("[data-note-readiness]")?.textContent).toContain("No updated draft is confirmed."));
  expect(w.preparations).toHaveLength(1);
  const key = w.preparations[0]; w.setDraft(); await f.click("check-note");
  await vi.waitFor(() => expect(f.content.innerHTML).toContain("Clinical review is still required."));
  expect(w.preparations).toEqual([key]);
});

it("reopens a CAS-before-send successor and explicitly retries only its retained key after paired current reads", async () => {
  const progress = appendNotePreparationSuccessor(retained().progress!, reviewedSource(ready()), id(7));
  const w = wire(), f = mount({ snapshot: { revision: "2", progress }, request: w.request });
  await f.click("open"); await lastOptions().continueToNote!(ready());
  await vi.waitFor(() => expect(f.content.querySelector("[data-note-readiness]")?.textContent).toContain("No updated draft is confirmed."));
  expect(w.preparations).toEqual([]);
  await f.click("retry-updated-note");
  expect(w.preparations).toEqual([id(7)]);
  expect((await f.journal.load()).progress).toEqual(progress);
  expect(f.content.innerHTML).toContain("Clinical review is still required.");
});

it("manual recovery does not prepare if the same current draft already finished", async () => {
  const progress = appendNotePreparationSuccessor(retained().progress!, reviewedSource(ready()), id(7));
  const w = wire(), f = mount({ snapshot: { revision: "2", progress }, request: w.request });
  await f.click("open"); await lastOptions().continueToNote!(ready());
  await vi.waitFor(() => expect(f.content.querySelector("[data-note-readiness]")?.textContent).toContain("No updated draft is confirmed."));
  w.setDraft(); await f.click("retry-updated-note");
  expect(w.preparations).toEqual([]); expect(f.content.innerHTML).toContain("Clinical review is still required.");
});


it("preserves an uncertain committed CAS and reopens it without automatically preparing", async () => {
  const w = wire(), f = mount({ snapshot: retained(), request: w.request }); await openUpdated(f);
  const save = f.journal.save.getMockImplementation()!;
  f.journal.save.mockImplementationOnce(async (previous, next) => { await save(previous, next); throw new Error("Synthetic lost CAS response"); });
  await f.click("prepare-updated-note");
  expect(w.preparations).toEqual([]);
  const committed = await f.journal.load();
  expect(committed.progress?.notePreparation).toEqual(original());
  expect(committed.progress?.notePreparationSuccessors).toHaveLength(1);
  await f.dispose();
  const reopened = mount({ snapshot: committed, request: w.request });
  await reopened.click("open"); await lastOptions().continueToNote!(ready());
  await vi.waitFor(() => expect(reopened.content.querySelector("[data-note-readiness]")?.textContent).toContain("No updated draft is confirmed."));
  expect(w.preparations).toEqual([]);
  await reopened.click("retry-updated-note");
  expect(w.preparations).toEqual([committed.progress!.notePreparationSuccessors![0]!.key]);
});

it("serializes rapid clicks while CAS is unresolved and submits only after confirmation", async () => {
  const w = wire(), f = mount({ snapshot: retained(), request: w.request }); await openUpdated(f);
  const gate = deferred<void>(), save = f.journal.save.getMockImplementation()!;
  f.journal.save.mockImplementationOnce(async (previous, next) => { await gate.promise; return save(previous, next); });
  const flight = f.click("prepare-updated-note");
  await vi.waitFor(() => expect(f.journal.save).toHaveBeenCalled());
  const button = new Surface(); button.dataset.workspaceAction = "prepare-updated-note";
  const event = new Event("click"); Object.defineProperty(event, "target", { value: button }); f.root.dispatchEvent(event);
  expect(w.preparations).toEqual([]); gate.resolve(); await flight;
  expect(w.preparations).toHaveLength(1); expect(f.journal.save).toHaveBeenCalledTimes(1);
});

it("retains old unsaved edits on Keep and clears only that buffer after explicit discard", async () => {
  const oldDraft = await parseDraft(await noteValue(true, ready(1)), id(2), schema, reviewedSource(ready(1)));
  const edits = pendingSave(oldDraft, { Plan: "Synthetic retained <unsaved> correction." });
  const prior = { ...retained().progress!, queuedNoteEdits: edits };
  const w = wire(), f = mount({ snapshot: { revision: "1", progress: prior }, request: w.request }); await openUpdated(f);
  expect(f.content.querySelector('[data-workspace-action="prepare-updated-note"]')).toBeNull();
  await f.click("review-retained-edits"); expect(f.content.innerHTML).toContain("&lt;unsaved&gt;");
  await f.click("keep-retained-edits"); expect((await f.journal.load()).progress).toEqual(prior); expect(w.preparations).toEqual([]);
  await f.click("review-retained-edits"); await f.click("discard-retained-edits");
  expect((await f.journal.load()).progress).toEqual({ ...prior, queuedNoteEdits: null }); expect(w.preparations).toEqual([]);
  await f.click("prepare-updated-note"); expect(w.preparations).toHaveLength(1);
  expect((await f.journal.load()).progress?.notePreparation).toEqual(original());
});

it("an unresolved older save remains retained and cannot be rebased onto the correction", async () => {
  const oldDraft = await parseDraft(await noteValue(true, ready(1)), id(2), schema, reviewedSource(ready(1)));
  const edits = pendingSave(oldDraft, { Plan: "Synthetic pending save." });
  const prior = { ...retained().progress!, pendingSave: edits };
  const w = wire(), f = mount({ snapshot: { revision: "1", progress: prior }, request: w.request }); await f.click("open");
  expect(f.content.innerHTML).toContain("Confirm your previous save");
  expect(f.content.querySelector('[data-workspace-action="prepare-updated-note"]')).toBeNull();
  const stale = new Surface(); stale.dataset.workspaceAction = "prepare-updated-note";
  const event = new Event("click"); Object.defineProperty(event, "target", { value: stale }); f.root.dispatchEvent(event);
  expect(w.preparations).toEqual([]); expect((await f.journal.load()).progress).toEqual(prior);
});

it("retains prior successor identities while advancing again and accepts legacy journals", async () => {
  const root = retained().progress!, first = appendNotePreparationSuccessor(root, reviewedSource(ready(4)), id(7));
  const second = appendNotePreparationSuccessor(first, reviewedSource(ready(7)), id(8));
  const journal = optionsJournal({ revision: "2", progress: first });
  const loaded = await journal.load(); await journal.save(loaded, second);
  expect((await journal.load()).progress).toEqual(second);
  expect(second.notePreparation).toEqual(root.notePreparation);
  expect(second.notePreparationSuccessors?.[0]).toEqual(first.notePreparationSuccessors?.[0]);
  expect(await optionsJournal(retained()).load()).toEqual(retained());
});

it("rejects malformed, duplicate, reordered and rewritten history without CAS dispatch", async () => {
  const root = retained().progress!, first = appendNotePreparationSuccessor(root, reviewedSource(ready(4)), id(7));
  const second = appendNotePreparationSuccessor(first, reviewedSource(ready(7)), id(8));
  for (const history of [null, "history", [{ ...first.notePreparationSuccessors![0], extra: true }],
    [first.notePreparationSuccessors![0], first.notePreparationSuccessors![0]],
    [...second.notePreparationSuccessors!].reverse(), [{ ...first.notePreparationSuccessors![0], schema: "foreign" }],
    [{ ...first.notePreparationSuccessors![0], source: reviewedSource(ready(4, id(9))) }]]) {
    expect(() => assertProgress({ ...root, notePreparationSuccessors: history })).toThrow();
  }
  const journal = optionsJournal({ revision: "3", progress: second });
  const loaded = await journal.load();
  for (const changed of [{ ...second, notePreparationSuccessors: [] }, { ...second, notePreparation: null },
    { ...second, notePreparationSuccessors: [{ ...second.notePreparationSuccessors![0]!, key: id(10) }, second.notePreparationSuccessors![1]!] }]) {
    await expect(journal.save(loaded, changed)).rejects.toThrow();
  }
  expect(journal.plugin.compareAndSwap).not.toHaveBeenCalled();
});

it("bounds history without truncation and rejects foreign session, raw source or continuity", async () => {
  let full = retained().progress!;
  for (let n = 0; n < MAX_NOTE_PREPARATION_SUCCESSORS; n++) full = appendNotePreparationSuccessor(full, reviewedSource(ready(n + 2)), id(n + 20));
  expect(() => appendNotePreparationSuccessor(full, reviewedSource(ready(30)), id(50))).toThrow();
  expect(full.notePreparationSuccessors).toHaveLength(16); expect(full.notePreparation).toEqual(original());
  const journal = optionsJournal(retained()), loaded = await journal.load();
  await expect(journal.save(loaded, { ...loaded.progress!, sessionId: id(99) })).rejects.toThrow();
  expect(() => appendNotePreparationSuccessor(retained().progress!, { ...reviewedSource(ready()), source_version: 2 }, id(7))).toThrow();
  const continuity = parseCaptureContinuity({ schema_version: "1.0", continuity: "interrupted_or_unconfirmed", missing_audio: "unknown",
    starts: [{ source_start_id: id(60), first_sequence_number: 0 }, { source_start_id: id(61), first_sequence_number: 2 }] });
  const prior = { ...retained().progress!, notePreparation: { ...original(), source: { ...original().source, capture_continuity: continuity } } };
  expect(() => appendNotePreparationSuccessor(prior, { ...reviewedSource(ready()), capture_continuity: continuity }, id(7))).not.toThrow();
  const changed = parseCaptureContinuity({ ...continuity, starts: [...continuity.starts.slice(0, 1), { source_start_id: id(62), first_sequence_number: 2 }] });
  expect(() => appendNotePreparationSuccessor(prior, { ...reviewedSource(ready()), capture_continuity: changed }, id(7))).toThrow();
});


it("a newer v7 successor ignores a late v4 read in the same visit and preserves both entries", async () => {
  const initial = appendNotePreparationSuccessor(retained().progress!, reviewedSource(ready()), id(7));
  const late = deferred<Response>(), w = wire(); let reads = 0;
  let lateBody: Readonly<Record<string, unknown>> = {};
  const request: AuthorizedCoreRequest = async (path, body, key, signal) => {
    if (body.action === "read" && ++reads === 2) { lateBody = body; return late.promise; }
    return w.request(path, body, key, signal);
  };
  const f = mount({ snapshot: { revision: "2", progress: initial }, request });
  await f.click("open"); await lastOptions().continueToNote!(ready());
  await vi.waitFor(() => expect(reads).toBe(2));
  await f.click("review"); w.advance(ready(7)); await lastOptions().continueToNote!(ready(7));
  await f.click("prepare-updated-note");
  expect(w.preparations).toHaveLength(1);
  late.resolve(Response.json({ ...lateBody, action: "read", contract_version: "1",
    checked_at: new Date().toISOString(), receipt: await noteValue(true, ready(), "Old synthetic draft.") }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.content.innerHTML).toContain("Clinical review is still required.");
  expect(f.content.innerHTML).not.toContain("Old synthetic draft.");
  const progress = (await f.journal.load()).progress!;
  expect(progress.notePreparation).toEqual(original()); expect(progress.notePreparationSuccessors?.[0]).toEqual(initial.notePreparationSuccessors![0]);
  expect(progress.notePreparationSuccessors?.[1]?.source.working_version).toBe(7);
});

it("old root-only uncertainty remains read-only and offers no updated retry", async () => {
  const prior = { ...retained().progress!, notePreparation: { ...original(), source: reviewedSource(ready()) } };
  const w = wire(), f = mount({ snapshot: { revision: "1", progress: prior }, request: w.request });
  await f.click("open"); await lastOptions().continueToNote!(ready()); await f.click("check-note");
  expect(w.preparations).toEqual([]); expect(f.content.querySelector('[data-workspace-action="retry-updated-note"]')).toBeNull();
  expect((await f.journal.load()).progress).toEqual(prior);
});

it("a retry remains disabled until a fresh pair settles and cannot replay through an old button", async () => {
  const initial = appendNotePreparationSuccessor(retained().progress!, reviewedSource(ready()), id(7));
  const gate = deferred<Response>(), w = wire(); let hold = false;
  const request: AuthorizedCoreRequest = async (path, body, key, signal) => hold && body.action === "read" ? gate.promise : w.request(path, body, key, signal);
  const f = mount({ snapshot: { revision: "2", progress: initial }, request });
  await f.click("open"); await lastOptions().continueToNote!(ready());
  await vi.waitFor(() => expect(f.content.querySelector("[data-note-readiness]")?.textContent).toContain("No updated draft is confirmed."));
  const old = f.content.querySelector('[data-workspace-action="retry-updated-note"]')!;
  hold = true; await f.click("check-note"); expect(old.disabled).toBe(true);
  const event = new Event("click"); Object.defineProperty(event, "target", { value: old }); f.root.dispatchEvent(event);
  expect(w.preparations).toEqual([]); f.abort.abort();
  gate.resolve(Response.json({}, { status: 503 }));
  await new Promise(resolve => setTimeout(resolve, 20)); expect(w.preparations).toEqual([]);
});

it("a pending preparation reply cannot attach after encounter access ends", async () => {
  const pending = deferred<Response>(), w = wire(() => pending.promise);
  const f = mount({ snapshot: retained(), request: w.request }); await openUpdated(f);
  const flight = f.click("prepare-updated-note"); await vi.waitFor(() => expect(w.preparations).toHaveLength(1));
  f.abort.abort(); pending.resolve(Response.json({}, { status: 503 })); await flight;
  expect(f.content.innerHTML).not.toContain("Clinical review is still required.");
  expect(f.content.querySelector('[data-workspace-action="retry-updated-note"]')).toBeNull();
});


it("manual retry refuses a newly advanced source without changing its retained key", async () => {
  const initial = appendNotePreparationSuccessor(retained().progress!, reviewedSource(ready()), id(7));
  const w = wire(), f = mount({ snapshot: { revision: "2", progress: initial }, request: w.request });
  await f.click("open"); await lastOptions().continueToNote!(ready());
  await vi.waitFor(() => expect(f.content.querySelector("[data-note-readiness]")?.textContent).toContain("No updated draft is confirmed."));
  w.advance(ready(5)); await f.click("retry-updated-note");
  expect(w.preparations).toEqual([]); expect((await f.journal.load()).progress).toEqual(initial);
  expect(f.content.innerHTML).not.toContain("Clinical review is still required.");
});

it("the full history gives a dashboard continuation without dropping any entries", async () => {
  let progress = retained().progress!;
  for (let n = 0; n < MAX_NOTE_PREPARATION_SUCCESSORS; n++) progress = appendNotePreparationSuccessor(progress, reviewedSource(ready(n + 2)), id(n + 20));
  const w = wire(), f = mount({ snapshot: { revision: "17", progress }, request: w.request, view: ready(30) });
  await f.click("open"); await lastOptions().continueToNote!(ready(30));
  expect(f.content.innerHTML).toContain("Open the dashboard to review saved notes and continue there.");
  expect(f.content.querySelector('[data-workspace-action="prepare-updated-note"]')).toBeNull();
  expect((await f.journal.load()).progress).toEqual(progress); expect(w.preparations).toEqual([]);
});

it.each(["fresh review", "CAS"])("keeps a genuinely viewed v1 draft closed after correction and failed %s", async failure => {
  const w = wire(); w.advance(ready(1)); w.setDraft();
  const f = mount({ snapshot: retained(), request: w.request, view: ready(1) });
  await f.click("open"); await lastOptions().continueToNote!(ready(1));
  expect(f.content.innerHTML).toContain("Clinical review is still required.");
  expect(f.content.innerHTML).toContain("No plan discussed.");
  await f.click("review"); w.advance(ready()); await lastOptions().continueToNote!(ready());
  expect(f.content.innerHTML).toContain("Transcript updated");
  expect(f.content.innerHTML).not.toContain("No plan discussed.");
  if (failure === "CAS") f.journal.save.mockRejectedValueOnce(new Error("Synthetic CAS conflict"));
  else f.request.mockRejectedValueOnce(new Error("Synthetic fresh review unavailable"));
  await f.click("prepare-updated-note");
  expect(f.content.innerHTML).toContain("Transcript updated");
  expect(f.content.innerHTML).not.toContain("Clinical review is still required.");
  expect(f.content.innerHTML).not.toContain("No plan discussed.");
  expect(f.content.innerHTML).not.toContain("data-note-field");
  await f.click("save");
  expect(f.request.mock.calls.some(([, body]) => body.action === "save")).toBe(false);
  expect(w.preparations).toEqual([]);
  expect((await f.journal.load()).progress).toEqual(retained().progress);
});

async function terminalSaveFixture(outcome: "saved" | "closed", mode: "automatic" | "manual", queued = false) {
  const priorDraft = await parseDraft(await noteValue(true, ready(1)), id(2), schema, reviewedSource(ready(1)));
  const pending = pendingSave(priorDraft, { Plan: "Synthetic submitted old-source edits." });
  const buffer = queued ? pendingSave(priorDraft, { Plan: "Synthetic later unsaved old-source edits." }) : undefined;
  const progress: ProviderProgress = { ...retained().progress!, pendingSave: pending, ...(buffer ? { queuedNoteEdits: buffer } : {}) };
  let review = ready(), note = await noteValue(false, review), patch: Record<string, unknown> = {};
  const calls: string[] = [];
  const request: AuthorizedCoreRequest = async (_path, body, key) => {
    const response = (receipt: unknown) => Response.json({ ...body, contract_version: "1", checked_at: new Date().toISOString(),
      ...(body.operation ? { operation: "creator_review" } : { action: body.action }), receipt });
    calls.push(body.operation ? "review" : String(body.action));
    if (body.operation) return response(review);
    if (body.action === "read") return response(note);
    if (body.action === "templates") return response({ session_id: id(2), templates: [{ schema_ref: schema, note_type: "Synthetic SOAP", field_names: ["Plan"] }] });
    if (body.action === "save_status" || body.action === "resolve") {
      expect(key).toBe(pending.edit.client_key); expect(body.edit).toEqual(pending.edit);
      const status = mode === "manual" && body.action === "save_status" ? "pending" : outcome;
      return response({ session_id: id(2), schema_ref: schema, client_key: pending.edit.client_key,
        request_sha256: await sha256(canonical({ edit: pending.edit, schema, session: id(2), workspace: scope.workspaceId })),
        status, result_note_ref: status === "saved" ? "visit_note_" + suffix.slice(0, -1) + "1" : null,
        result_sha256: status === "saved" ? await sha256(JSON.stringify(pending.fieldOrder.map(field => [field, pending.edit.fields[field]]))) : null,
        ...patch });
    }
    throw new Error("No save, prepare or recording is allowed during terminal reconciliation.");
  };
  return { request, progress, pending, buffer, calls,
    change: (next: { review?: CreatorReviewView; note?: Awaited<ReturnType<typeof noteValue>>; patch?: Record<string, unknown> }) => {
      if (next.review) review = next.review; if (next.note) note = next.note; if (next.patch) patch = next.patch;
    } };
}

it.each([
  ["automatic", "saved"], ["automatic", "closed"], ["manual", "saved"], ["manual", "closed"],
] as const)("reconciles an exact older %s %s outcome without displaying or rebasing its old draft", async (mode, outcome) => {
  const t = await terminalSaveFixture(outcome, mode), f = mount({ snapshot: { revision: "1", progress: t.progress }, request: t.request });
  await f.click("open"); if (mode === "manual") await f.click("resolve");
  await vi.waitFor(async () => expect((await f.journal.load()).progress?.pendingSave, JSON.stringify({ calls: t.calls, notice: f.notice.textContent })).toBeNull());
  const next = (await f.journal.load()).progress!;
  expect(next.notePreparation).toEqual(original()); expect(next.notePreparationSuccessors).toBeUndefined();
  expect(next.queuedNoteEdits ?? null).toEqual(outcome === "closed" ? t.pending : null);
  expect(f.content.innerHTML).toContain("Transcript updated");
  expect(f.content.innerHTML).not.toContain("Clinical review is still required.");
  expect(f.content.innerHTML).not.toContain("Synthetic submitted old-source edits.");
  expect(t.calls).not.toContain("save"); expect(t.calls).not.toContain("prepare");
  if (outcome === "closed") expect(f.content.querySelector('[data-workspace-action="prepare-updated-note"]')).toBeNull();
});


it.each(["saved", "closed"] as const)("preserves later old-source unsaved fields exactly after terminal %s", async outcome => {
  const t = await terminalSaveFixture(outcome, "automatic", true), f = mount({ snapshot: { revision: "1", progress: t.progress }, request: t.request });
  await f.click("open"); await vi.waitFor(async () => expect((await f.journal.load()).progress?.pendingSave).toBeNull());
  expect((await f.journal.load()).progress?.queuedNoteEdits).toEqual(t.buffer);
  expect(f.content.querySelector('[data-workspace-action="prepare-updated-note"]')).toBeNull();
  await f.click("review-retained-edits"); expect(f.content.innerHTML).toContain("Synthetic later unsaved old-source edits.");
  await f.click("keep-retained-edits"); expect((await f.journal.load()).progress?.queuedNoteEdits).toEqual(t.buffer);
  expect(t.calls).not.toContain("save"); expect(t.calls).not.toContain("prepare");
});

it.each(["saved", "closed"] as const)("legacy no-preparation journals retain/discard old edits after %s without replay", async outcome => {
  const t = await terminalSaveFixture(outcome, "automatic", true);
  const prior = { ...t.progress, notePreparation: null };
  const f = mount({ snapshot: { revision: "1", progress: prior }, request: t.request });
  await f.click("open"); await vi.waitFor(async () => expect((await f.journal.load()).progress?.pendingSave).toBeNull());
  expect((await f.journal.load()).progress?.notePreparation).toBeNull();
  await f.click("review-retained-edits"); await f.click("discard-retained-edits");
  expect((await f.journal.load()).progress).toEqual({ ...prior, pendingSave: null, queuedNoteEdits: null });
  expect(f.content.innerHTML).toContain("Write visit note");
  expect(t.calls).not.toContain("save"); expect(t.calls).not.toContain("prepare");
});

it.each(["saved", "closed"] as const)("terminal %s with a mismatched old edit buffer never clears it", async outcome => {
  const t = await terminalSaveFixture(outcome, "automatic", true);
  const foreign = { ...t.buffer!, edit: { ...t.buffer!.edit, expected_source_sha256: "b".repeat(64) } };
  const prior = { ...t.progress, queuedNoteEdits: foreign };
  const f = mount({ snapshot: { revision: "1", progress: prior }, request: t.request });
  await f.click("open"); await vi.waitFor(() => expect(t.calls).toContain("read"));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect((await f.journal.load()).progress).toEqual(prior); expect(f.journal.save).not.toHaveBeenCalled();
  expect(t.calls).not.toContain("save"); expect(t.calls).not.toContain("prepare");
});

it.each(["foreign working", "new raw source", "unready", "pair drift"])("rejects terminal saved recovery for %s current evidence", async kind => {
  const t = await terminalSaveFixture("saved", "automatic");
  if (kind === "foreign working") t.change({ review: ready(4, id(9)), note: await noteValue(false, ready(4, id(9))) });
  else if (kind === "new raw source") {
    const changed = { ...ready(), source: { ...ready().source!, source_transcript_version: 2 } };
    t.change({ review: changed, note: { ...await noteValue(false), reviewed_source: { ...reviewedSource(ready()), source_version: 2 } } });
  } else if (kind === "unready") t.change({ review: { ...ready(), working: { ...ready().working!, note_ready: false } } });
  else t.change({ note: await noteValue(false, ready(5)) });
  const f = mount({ snapshot: { revision: "1", progress: t.progress }, request: t.request });
  await f.click("open"); await vi.waitFor(() => expect(t.calls).toContain("read"));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect((await f.journal.load()).progress).toEqual(t.progress); expect(f.journal.save).not.toHaveBeenCalled();
});

it.each(["wrong session", "wrong key", "wrong request", "wrong result", "pending", "malformed closed"])("retains uncertainty for %s terminal metadata", async kind => {
  const t = await terminalSaveFixture("saved", "automatic");
  const patch = kind === "wrong session" ? { session_id: id(9) } : kind === "wrong key" ? { client_key: id(9) }
    : kind === "wrong request" ? { request_sha256: "b".repeat(64) } : kind === "wrong result" ? { result_sha256: "b".repeat(64) }
      : kind === "pending" ? { status: "pending", result_note_ref: null, result_sha256: null } : { status: "closed" };
  t.change({ patch });
  const f = mount({ snapshot: { revision: "1", progress: t.progress }, request: t.request });
  await f.click("open"); await new Promise(resolve => setTimeout(resolve, 30));
  expect((await f.journal.load()).progress).toEqual(t.progress); expect(f.journal.save).not.toHaveBeenCalled();
  expect(t.calls).not.toContain("read");
});

it("a terminal older receipt cannot clear a later retained request after an independent CAS writer", async () => {
  const t = await terminalSaveFixture("saved", "automatic"), gate = deferred<Response>();
  let heldBody: Readonly<Record<string, unknown>> = {};
  const request: AuthorizedCoreRequest = async (path, body, key, signal) => {
    if (body.action === "read") { heldBody = body; return gate.promise; }
    return t.request(path, body, key, signal);
  };
  const f = mount({ snapshot: { revision: "1", progress: t.progress }, request });
  await f.click("open"); await vi.waitFor(() => expect(Object.keys(heldBody).length).toBeGreaterThan(0));
  const previous = await f.journal.load();
  const cleared = await f.journal.save(previous, { ...previous.progress!, pendingSave: null });
  const newer = { ...t.pending, edit: { ...t.pending.edit, fields: { Plan: "Different retained request under the same key." } } };
  await f.journal.save(cleared, { ...cleared.progress!, pendingSave: newer });
  gate.resolve(Response.json({ ...heldBody, contract_version: "1", checked_at: new Date().toISOString(), action: "read", receipt: await noteValue(false) }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect((await f.journal.load()).progress?.pendingSave).toEqual(newer);
  expect(t.calls).not.toContain("save"); expect(t.calls).not.toContain("prepare");
});

it.each(["saved", "closed"] as const)("lost reconciliation CAS reply reopens exact terminal %s state without replay", async outcome => {
  const t = await terminalSaveFixture(outcome, "automatic"), f = mount({ snapshot: { revision: "1", progress: t.progress }, request: t.request });
  const save = f.journal.save.getMockImplementation()!;
  f.journal.save.mockImplementationOnce(async (previous, next) => { await save(previous, next); throw new Error("Synthetic lost reconciliation reply"); });
  await f.click("open"); await vi.waitFor(async () => expect((await f.journal.load()).progress?.pendingSave).toBeNull());
  const committed = await f.journal.load(); await f.dispose();
  const reopened = mount({ snapshot: committed, request: t.request });
  await reopened.click("open"); await lastOptions().continueToNote!(ready());
  expect((await reopened.journal.load()).progress).toEqual(committed.progress);
  expect(t.calls).not.toContain("save"); expect(t.calls).not.toContain("prepare");
});

it.each(["saved", "closed"] as const)("preserves the existing same-source manual %s behavior", async outcome => {
  const t = await terminalSaveFixture(outcome, "manual");
  const text = outcome === "saved" ? t.pending.edit.fields.Plan! : "No plan discussed.";
  const note = await noteValue(true, ready(1), text);
  if (outcome === "saved") note.note_ref = "visit_note_" + suffix.slice(0, -1) + "1";
  t.change({ review: ready(1), note });
  const f = mount({ snapshot: { revision: "1", progress: t.progress }, request: t.request, view: ready(1) });
  await f.click("open"); await f.click("resolve");
  expect((await f.journal.load()).progress?.pendingSave).toBeNull();
  expect(f.content.innerHTML).toContain("Clinical review is still required.");
  expect(t.calls).not.toContain("save"); expect(t.calls).not.toContain("prepare");
});

// Controlled textarea/timers exercise real handlers; this is not browser DOM acceptance.
it.each([
  ["saved", "latest"], ["closed", "latest"], ["saved", "submitted"], ["closed", "submitted"],
  ["saved", "reverted"], ["closed", "reverted"], ["saved", "mismatched buffer"], ["closed", "mismatched buffer"],
  ["saved", "restored submitted"], ["closed", "restored submitted"],
] as const)("terminal %s fences old-source editor fields: %s", async (outcome, variation) => {
  let current = ready(1), edit: Record<string, unknown> | null = null;
  const saveResponse = deferred<Response>();
  const request: AuthorizedCoreRequest = async (_path, body) => {
    const response = (receipt: unknown) => Response.json({ ...body, contract_version: "1", checked_at: new Date().toISOString(),
      ...(body.operation ? { operation: "creator_review" } : { action: body.action }), receipt });
    if (body.operation) return response(current);
    if (body.action === "read") return response(await noteValue(current.working!.working_transcript_version === 1, current));
    if (body.action === "save") { edit = body.edit as Record<string, unknown>; return saveResponse.promise; }
    if (body.action === "save_status") {
      expect(edit).not.toBeNull();
      return response({ session_id: id(2), schema_ref: schema, client_key: edit!.client_key,
        request_sha256: await sha256(canonical({ edit, schema, session: id(2), workspace: scope.workspaceId })),
        status: outcome, result_note_ref: outcome === "saved" ? "visit_note_" + suffix.slice(0, -1) + "1" : null,
        result_sha256: outcome === "saved" ? await sha256(JSON.stringify([["Plan", (edit!.fields as Record<string,string>).Plan]])) : null });
    }
    throw new Error("No unexpected action permitted");
  };
  const f=mount({snapshot:retained(),request,view:ready(1)});
  Object.assign(document, { createElement: () => new Surface() });
  await f.click("open"); await lastOptions().continueToNote!(ready(1));
  expect(f.content.innerHTML).toContain("Clinical review is still required.");
  const field = new HTMLTextAreaElement() as unknown as Surface & {value:string;defaultValue:string;readOnly:boolean;hasAttribute(name:string):boolean};
  field.value="Synthetic first submitted edit.";field.defaultValue="No plan discussed.";field.readOnly=false;
  field.hasAttribute=(name:string)=>name==="data-note-field";
  const originalQueryAll=f.content.querySelectorAll.bind(f.content);
  f.content.querySelectorAll=((selector:string)=>selector==="textarea[data-note-field]" && f.content.innerHTML.includes("data-note-field")?[field]:originalQueryAll(selector));
  f.content.nodes.set('[name="note-0"]',field);
  f.content.nodes.set('textarea[data-note-field]',field);
  if (variation === "mismatched buffer") {
    const save = f.journal.save.getMockImplementation()!;
    f.journal.save.mockImplementationOnce(async (previous, next) => {
      const pending = next.pendingSave!;
      return save(previous, { ...next, queuedNoteEdits: { ...pending, edit: { ...pending.edit, expected_source_sha256: "b".repeat(64) } } });
    });
  }
  vi.useFakeTimers();
  const flight=f.click("save");
  await vi.waitFor(()=>expect(edit).not.toBeNull());
  const type = (value: string) => {
    field.value = value;
    const event = new Event("input"); Object.defineProperty(event, "target", { value: field }); f.content.dispatchEvent(event);
  };
  if (variation !== "submitted") type("Synthetic latest unstaged edit.");
  if (variation === "reverted" || variation === "restored submitted") {
    await vi.advanceTimersByTimeAsync(150);
    expect((await f.journal.load()).progress?.queuedNoteEdits?.edit.fields.Plan).toBe("Synthetic latest unstaged edit.");
    type(variation === "reverted" ? "No plan discussed." : "Synthetic first submitted edit.");
  }
  current=ready(4);saveResponse.resolve(Response.json({}, {status:503}));
  await flight;
  if (variation === "mismatched buffer") {
    await vi.advanceTimersByTimeAsync(50);
    expect((await f.journal.load()).progress?.pendingSave).not.toBeNull();
    expect((await f.journal.load()).progress?.queuedNoteEdits?.edit.expected_source_sha256).toBe("b".repeat(64));
    expect(f.content.innerHTML).not.toContain("Transcript updated");
  } else {
    await vi.waitFor(async()=>expect((await f.journal.load()).progress?.pendingSave).toBeNull());
    expect(f.content.innerHTML).toContain("Transcript updated");
    const expected = variation === "latest" ? "Synthetic latest unstaged edit." : variation === "reverted" ? "No plan discussed."
      : outcome === "closed" ? "Synthetic first submitted edit." : undefined;
    expect((await f.journal.load()).progress?.queuedNoteEdits?.edit.fields.Plan).toBe(expected);
  }
});


it.each(["saved", "closed"] as const)("preserves the existing same-source automatic %s behavior", async outcome => {
  const t = await terminalSaveFixture(outcome, "automatic");
  const text = outcome === "saved" ? t.pending.edit.fields.Plan! : "No plan discussed.";
  const note = await noteValue(true, ready(1), text);
  if (outcome === "saved") note.note_ref = "visit_note_" + suffix.slice(0, -1) + "1";
  t.change({ review: ready(1), note });
  const f = mount({ snapshot: { revision: "1", progress: t.progress }, request: t.request, view: ready(1) });
  await f.click("open");
  if (outcome === "saved") {
    await vi.waitFor(async () => expect((await f.journal.load()).progress?.pendingSave).toBeNull());
    expect(f.content.innerHTML).toContain("Clinical review is still required.");
  } else {
    await vi.waitFor(() => expect(t.calls).toContain("read"));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await f.journal.load()).progress).toEqual(t.progress);
    expect(f.content.innerHTML).toContain("Confirm your previous save");
  }
  expect(t.calls).not.toContain("save"); expect(t.calls).not.toContain("prepare");
});


it("access loss during the current pair cannot clear an older terminal request", async () => {
  const t = await terminalSaveFixture("saved", "automatic"), gate = deferred<Response>();
  let held: Readonly<Record<string, unknown>> = {};
  const request: AuthorizedCoreRequest = async (path, body, key, signal) => {
    if (body.action === "read") { held = body; return gate.promise; }
    return t.request(path, body, key, signal);
  };
  const f = mount({ snapshot: { revision: "1", progress: t.progress }, request });
  await f.click("open"); await vi.waitFor(() => expect(Object.keys(held).length).toBeGreaterThan(0));
  f.abort.abort();
  gate.resolve(Response.json({ ...held, contract_version: "1", checked_at: new Date().toISOString(), action: "read", receipt: await noteValue(false) }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect((await f.journal.load()).progress).toEqual(t.progress); expect(f.journal.save).not.toHaveBeenCalled();
  expect(t.calls).not.toContain("save"); expect(t.calls).not.toContain("prepare");
});

it("opens current transcript review from a saved note without editing or preparing, then preserves the prior note for an explicit successor", async () => {
  const w = wire(); w.setDraft();
  const prior = { ...original(), source: reviewedSource(ready()) };
  const f = mount({ snapshot: { revision: "1", progress: { ...saved().progress!, notePreparation: prior } }, request: w.request });
  await f.click("open-draft"); await lastOptions().continueToNote!(ready());
  const link = f.content.querySelector('[data-workspace-action="review"]');
  expect(link).not.toBeNull();
  expect(f.content.innerHTML).toContain('data-workspace-action="review">Speakers');
  const before = f.journal.snapshot();
  const mountCount = mounted.mock.calls.length;
  await f.click("review");
  expect(mounted.mock.calls.length).toBe(mountCount + 1);
  expect(f.journal.snapshot()).toEqual(before);
  expect(w.preparations).toEqual([]);
  expect(f.recorder).not.toHaveBeenCalled();
  const current = ready(5); w.advance(current);
  await lastOptions().continueToNote!(current);
  expect(f.content.innerHTML).toContain("Transcript updated");
  expect(f.content.innerHTML).toContain("Previous drafts and saved notes are retained.");
  expect(w.preparations).toEqual([]);
  await f.click("prepare-updated-note");
  expect(w.preparations).toHaveLength(1);
  const after = f.journal.snapshot().progress!;
  expect(after.notePreparation).toEqual(prior);
  expect(after.notePreparationSuccessors).toHaveLength(1);
  expect(after.notePreparationSuccessors![0]!.source).toEqual(reviewedSource(current));
});

it("does not navigate the new saved-note review action after the encounter is revoked", async () => {
  const w = wire(); w.setDraft();
  const f = mount({ request: w.request });
  await f.click("open-draft"); await lastOptions().continueToNote!(ready());
  expect(f.content.innerHTML).toContain('data-workspace-action="review">Speakers');
  const mountCount = mounted.mock.calls.length;
  f.abort.abort();
  await f.click("review");
  expect(mounted.mock.calls.length).toBe(mountCount);
  expect(w.preparations).toEqual([]);
  expect(f.recorder).not.toHaveBeenCalled();
});

it.each(["unknown", "patient"] as const)("uses current working speaker roles for the saved-note %s guidance", async role => {
  const old = ready();
  const current = parseCreatorReview({ ...old, working: { ...old.working,
    segments: old.working!.segments.map(segment => ({ ...segment, speaker_role: role })) } }, id(2));
  const w = wire(); w.setDraft(); w.advance(current);
  const f = mount({ request: w.request, view: current });
  await f.click("open-draft"); await lastOptions().continueToNote!(current);
  // The immutable original remains unknown even after a working role correction.
  expect(current.source!.segments[0]!.speaker_role).toBe("unknown");
  expect(f.content.innerHTML.includes("Use Speakers to identify the patient and clinician.")).toBe(role === "unknown");
  expect(w.preparations).toEqual([]);
});

it("keeps unsaved note words behind the existing navigation confirmation before transcript review", async () => {
  const w = wire(); w.setDraft();
  const f = mount({ request: w.request });
  await f.click("open-draft"); await lastOptions().continueToNote!(ready());
  const field = new HTMLTextAreaElement() as unknown as Surface & { value: string; defaultValue: string };
  field.value = "Synthetic unsaved note edit."; field.defaultValue = "No plan discussed.";
  const originalQueryAll = f.content.querySelectorAll.bind(f.content);
  f.content.querySelectorAll = selector => selector === "textarea[data-note-field]" ? [field] : originalQueryAll(selector);
  f.content.nodes.set('[name="note-0"]', field);
  const navigation = f.root.querySelector('[data-workspace-navigation]')!;
  const dialog = Object.assign(new Surface(), { showModal: vi.fn() });
  const originalQuery = navigation.querySelector.bind(navigation);
  navigation.querySelector = selector => selector === "dialog" ? dialog : originalQuery(selector);
  const before = f.journal.snapshot(), mountCount = mounted.mock.calls.length;
  await f.click("review");
  expect(dialog.showModal).toHaveBeenCalledOnce();
  expect(navigation.innerHTML).toContain("Keep your note edits?");
  expect(mounted.mock.calls.length).toBe(mountCount);
  expect(field.value).toBe("Synthetic unsaved note edit.");
  expect(f.journal.snapshot()).toEqual(before);
  expect(w.preparations).toEqual([]);
});
