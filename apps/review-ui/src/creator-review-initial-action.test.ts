import { afterEach, expect, it, vi } from "vitest";
import { HttpCreatorReviewApi, parseCreatorReview, type AuthorizedReviewRequest } from "./creator-review-api";
import { mountCreatorReview, type CreatorReviewOptions } from "./creator-review-panel";

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ready = (version = 2) => parseCreatorReview({ schema_version: "1.0", session_id: id(1), status: "transcript_ready",
  source: { source_transcript_version: 1, segments: [{ source_segment_id: id(2), source_segment_version: 1,
    source_locale: "en-US", speaker_role: "unknown", content: "Invented source.", start_ms: 0, end_ms: 1000 }] },
  working: { source_transcript_version: 1, working_transcript_id: id(3), working_transcript_version: version,
    note_ready: true, blockers: [], segments: [{ source_segment_id: id(2), source_segment_version: 1,
      resolution: "english_source", content: "Invented source." }] },
  review_queue: { schema_version: "1.0", session_id: id(1), source_transcript_version: 1,
    working_transcript_id: id(3), working_transcript_version: version, status: "complete", items: [] },
}, id(1));
const waiting = () => parseCreatorReview({ schema_version: "1.0", session_id: id(1), status: "processing",
  source: null, working: null, review_queue: null }, id(1));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// The mounted controller/HTTP parser execute; this minimal event surface is not a browser.
class Surface extends EventTarget {
  innerHTML = "";
  readonly dataset: Record<string, string> = {};
  disabled = false;
  textContent = "";
  closest(selector: string): Surface | null { return selector === "button[data-review-action]" ? this : null; }
  contains(value: unknown): boolean { return value instanceof Surface; }
  querySelector(): Surface { return this; }
  append(): void {}
  replaceChildren(): void { this.innerHTML = ""; }
}
afterEach(() => vi.unstubAllGlobals());
function mount(options: CreatorReviewOptions = {}, request?: AuthorizedReviewRequest, direct = true) {
  vi.stubGlobal("Element", Surface);
  vi.stubGlobal("document", Object.assign(new EventTarget(), {
    visibilityState: "visible", createElement: () => new Surface(),
  }));
  const root = new Surface();
  const transport = vi.fn<AuthorizedReviewRequest>(request ?? (async () => Response.json(ready())));
  const api = new HttpCreatorReviewApi(id(1), transport);
  const open = vi.fn(async () => {});
  const dispose = mountCreatorReview(root as unknown as HTMLElement, api, { ...(direct ? { initialAction: "open-draft" as const } : {}), continueToNote: open, ...options });
  const click = (action: string): void => {
    const button = new Surface(); button.dataset.reviewAction = action;
    const event = new Event("click"); Object.defineProperty(event, "target", { value: button }); root.dispatchEvent(event);
  };
  return { root, transport, api, open, dispose, click };
}

it("waits for both recovery journals, then uses the existing fresh opening exactly once", async () => {
  const review = deferred<null>(), edit = deferred<null>(), fresh = vi.fn(async () => ({ view: ready(), open: opened }));
  const opened = vi.fn(async () => {});
  const journal = { load: vi.fn(() => review.promise), save: vi.fn(), clear: vi.fn() };
  const editJournal = { load: vi.fn(() => edit.promise), save: vi.fn(), clear: vi.fn() };
  const f = mount({ journal, editJournal, prepareNoteOpening: fresh });
  try {
    await vi.waitFor(() => expect(journal.load).toHaveBeenCalledOnce()); expect(fresh).not.toHaveBeenCalled();
    review.resolve(null);
    await vi.waitFor(() => expect(editJournal.load).toHaveBeenCalledOnce()); expect(fresh).not.toHaveBeenCalled();
    edit.resolve(null);
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    expect(f.open).not.toHaveBeenCalled(); expect(fresh).toHaveBeenCalledOnce();
    f.click("refresh"); await vi.waitFor(() => expect(f.transport).toHaveBeenCalledTimes(2));
    expect(fresh).toHaveBeenCalledOnce(); expect(opened).toHaveBeenCalledOnce();
    expect(f.transport.mock.calls.every(([, request]) => request.method === "GET")).toBe(true);
    expect(journal.save).not.toHaveBeenCalled(); expect(editJournal.save).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});

it("does not open a draft on ordinary review mounting", async () => {
  const f = mount({}, undefined, false);
  try { await vi.waitFor(() => expect(f.root.innerHTML).toContain("English transcript ready")); expect(f.open).not.toHaveBeenCalled(); }
  finally { f.dispose(); }
});

it.each(["initial-read-denied", "journal-failed", "initial-not-ready"])("consumes intent on %s and does not revive it after a status refresh", async failure => {
  let attempt = 0;
  const journal = { load: vi.fn(async () => { if (failure === "journal-failed" && attempt === 1) throw new Error("Synthetic journal unavailable"); return null; }), save: vi.fn(), clear: vi.fn() };
  const f = mount({ journal }, async () => {
    attempt += 1;
    if (attempt === 1 && failure === "initial-read-denied") return new Response(null, { status: 403 });
    return Response.json(attempt === 1 && failure === "initial-not-ready" ? waiting() : ready());
  });
  try {
    await vi.waitFor(() => expect(f.root.innerHTML).toContain(failure === "initial-not-ready" ? "saved draft is not available" : "recording is unavailable"));
    f.click("refresh"); await vi.waitFor(() => expect(f.root.innerHTML).toContain("English transcript ready"));
    expect(f.open).not.toHaveBeenCalled();
    expect(f.transport.mock.calls.every(([, request]) => request.method === "GET")).toBe(true);
  } finally { f.dispose(); }
});

it.each(["review", "edit"])("lets a pending %s win and does not open after explicit recovery", async kind => {
  const pendingReview = { key: "review-fixture", request: { schema_version: "1.0" as const, source_segment_id: id(2),
    expected_source_segment_version: 1, expected_source_transcript_version: 1, translation_id: id(4), expected_translation_version: 1, decision: "accepted" as const } };
  const pendingEdit = { key: "edit-fixture", request: { schema_version: "1.0" as const, expected_source_transcript_version: 1,
    expected_working_transcript_id: id(3), expected_working_transcript_version: 1,
    corrections: [{ source_segment_id: id(2), expected_source_segment_version: 1, content: "Invented correction." }], speakers: [] } };
  const journal = { load: vi.fn(async () => kind === "review" ? pendingReview : null), save: vi.fn(), clear: vi.fn() };
  const editJournal = { load: vi.fn(async () => kind === "edit" ? pendingEdit : null), save: vi.fn(), clear: vi.fn() };
  const f = mount({ journal, editJournal }, async (path, request) => request.method === "GET" ? Response.json(ready())
    : Response.json(path.endsWith("/edit") ? { schema_version: "1.0", session_id: id(1), saved: true, edit_id: id(5), working_transcript_id: id(3), working_transcript_version: 2 }
      : { schema_version: "1.0", session_id: id(1), saved: true, review_id: id(5) }));
  try {
    await vi.waitFor(() => expect(f.root.innerHTML).toContain(kind === "review" ? "previous decision needs confirmation" : "correction needs confirmation"));
    expect(f.open).not.toHaveBeenCalled(); expect(f.transport).toHaveBeenCalledOnce();
    f.click(kind === "review" ? "retry" : "retry-edit");
    await vi.waitFor(() => expect(f.root.innerHTML).toContain("English transcript ready"));
    expect(f.open).not.toHaveBeenCalled();
    expect(f.transport.mock.calls.filter(([, request]) => request.method === "POST")).toHaveLength(1);
  } finally { f.dispose(); }
});

it.each(["denied", "wrong-session", "older-version", "working-id"])("rejects the fresh opening %s without opening or writing", async failure => {
  let read = 0;
  const f = mount({}, async () => {
    read += 1;
    if (read === 1) return Response.json(ready());
    return failure === "denied" ? new Response(null, { status: 403 })
      : Response.json(failure === "wrong-session" ? { ...ready(), session_id: id(9) } : failure === "working-id"
        ? { ...ready(), working: { ...ready().working, working_transcript_id: id(8) },
          review_queue: { ...ready().review_queue, working_transcript_id: id(8) } } : ready(1));
  });
  try {
    await vi.waitFor(() => expect(f.root.innerHTML).toContain("note could not be opened"));
    expect(f.open).not.toHaveBeenCalled(); expect(f.transport).toHaveBeenCalledTimes(2);
    expect(f.transport.mock.calls.every(([, request]) => request.method === "GET")).toBe(true);
  } finally { f.dispose(); }
});

it("allows a genuinely newer source through the existing fresh note flow", async () => {
  const view = ready();
  const newer = parseCreatorReview({ ...view,
    source: { ...view.source, source_transcript_version: 2 },
    working: { ...view.working, source_transcript_version: 2, working_transcript_id: id(8) },
    review_queue: { ...view.review_queue, source_transcript_version: 2, working_transcript_id: id(8) },
  }, id(1));
  const opened = vi.fn(async () => {}), f = mount({ prepareNoteOpening: async () => ({ view: newer, open: opened }) });
  try { await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce()); }
  finally { f.dispose(); }
});

it.each(["initial-read", "journal", "fresh-opening"])("disposal during %s prevents every late opening", async stage => {
  const gate = deferred<void>(), opened = vi.fn(async () => {});
  const journal = { load: vi.fn(async () => { if (stage === "journal") await gate.promise; return null; }), save: vi.fn(), clear: vi.fn() };
  const fresh = vi.fn(async () => { if (stage === "fresh-opening") await gate.promise; return { view: ready(), open: opened }; });
  const f = mount({ journal, prepareNoteOpening: fresh }, async () => { if (stage === "initial-read") await gate.promise; return Response.json(ready()); });
  await vi.waitFor(() => expect(stage === "fresh-opening" ? fresh : stage === "journal" ? journal.load : f.transport).toHaveBeenCalledOnce());
  f.dispose(); gate.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(opened).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  expect(f.root.innerHTML).toBe("");
});

it("leaves the current review visible when the fresh opening loses readiness", async () => {
  const view = ready();
  const unready = parseCreatorReview({ ...view, status: "translation_pending", working: { ...view.working,
    note_ready: false, blockers: [{ source_segment_id: id(2), code: "translation_failed" }] },
    review_queue: { ...view.review_queue, status: "not_ready" } }, id(1));
  const opened = vi.fn(async () => {});
  const f = mount({ prepareNoteOpening: async () => ({ view: unready, open: opened }) });
  try {
    await vi.waitFor(() => expect(f.root.innerHTML).toContain("Complete its current review"));
    expect(opened).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
    expect(f.transport.mock.calls.every(([, request]) => request.method === "GET")).toBe(true);
  } finally { f.dispose(); }
});
