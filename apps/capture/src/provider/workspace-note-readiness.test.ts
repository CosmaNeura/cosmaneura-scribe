import { afterEach, expect, it, vi } from "vitest";
import { parseCreatorReview, type CreatorReviewView } from "../../../review-ui/src/creator-review-api";
import { mountCreatorReview } from "../../../review-ui/src/creator-review-panel";
import type { CreatorReviewOptions } from "../../../review-ui/src/creator-review-panel";
import type * as CreatorPanel from "../../../review-ui/src/creator-review-panel";
import { mountProviderWorkspace, type AuthorizedProviderEncounter, type ProviderWorkspaceHost, type ProviderEncounter } from "./workspace";
import type { JournalSnapshot } from "./workspace-journal";
import type { AuthorizedCoreRequest } from "./core-client";
import { reviewedSource, sha256 } from "./core-notes";

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

// Minimal event tree, not a browser/layout or assistive-technology simulation.
class Surface extends EventTarget {
  private markup = "";
  readonly nodes = new Map<string, Surface>();
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Set<string>();
  readonly classList = { add: vi.fn() };
  readonly style = { setProperty: vi.fn() };
  buttons: Surface[] = [];
  parent: Surface | null = null;
  textContent = "";
  hidden = false;
  disabled = false;
  isConnected = true;
  get innerHTML(): string { return this.markup; }
  set innerHTML(value: string) {
    this.markup = value; this.nodes.clear(); this.buttons = [];
    for (const key of ["data-workspace-content", "data-workspace-notice", "data-workspace-progress", "data-workspace-navigation",
      "data-provider-encounter", "data-provider-account", "data-provider-patient-detail", "data-encounter-progress", "data-note-readiness", "data-note-wait-time"]) {
      if (value.includes(key)) this.nodes.set(`[${key}]`, new Surface());
    }
    if (value.includes('class="provider-note-options"')) this.nodes.set(".provider-note-options", new Surface());
    if (value.includes('data-workspace-action="check-note"')) {
      const button = new Surface(); button.dataset.workspaceAction = "check-note";
      this.nodes.set('[data-workspace-action="check-note"]', button);
    }
    if (value.includes('class="provider-header"')) this.nodes.set(".provider-header", new Surface());
    if (value.includes('class="provider-encounters"')) {
      const list = new Surface(); this.nodes.set(".provider-encounters", list);
      for (const match of value.matchAll(/<li><button data-workspace-action="open" data-appointment="([^"]+)"/gu)) {
        const button = new Surface(), row = new Surface(); button.dataset.appointment = match[1]!;
        button.dataset.workspaceAction = "open"; button.parent = row; row.nodes.set("[data-draft-action]", new Surface());
        button.nodes.set(".provider-visit-status", new Surface()); list.buttons.push(button);
      }
    }
  }
  querySelector(selector: string): Surface | null { return this.nodes.get(selector) ?? null; }
  querySelectorAll(selector: string): Surface[] { return selector === '[data-workspace-action="open"]' ? this.buttons : []; }
  append(): void {}
  contains(value: unknown): boolean { return value instanceof Surface && value.isConnected; }
  closest(selector: string): Surface | null { return selector === "li" ? this.parent : selector === "button[data-workspace-action]" ? this : null; }
  setAttribute(name: string): void { this.attributes.add(name); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  getBoundingClientRect(): { height: number } { return { height: 0 }; }
  remove(): void { this.isConnected = false; }
  replaceChildren(): void { this.innerHTML = ""; }
  close(): void {}
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
    const button = content.querySelector(`[data-workspace-action="${action}"]`) ?? new Surface(); button.dataset.workspaceAction = action; button.dataset.appointment = appointment;
    const event = new Event("click"); Object.defineProperty(event, "target", { value: button }); root.dispatchEvent(event);
    await vi.waitFor(() => expect(root.attributes.has("aria-busy")).toBe(false));
  };
  return { root, content, notice, host, request, journal, recorder, click, abort, dispose };
}
const lastOptions = (): CreatorReviewOptions => mounted.mock.lastCall![2]!;

const schema = "doctor_note_schema_" + suffix;
const noteValue = async (draft = false, view = ready()) => ({
  session_id: id(2), scribe_source_id: view.working!.working_transcript_id, source_sha256: "a".repeat(64), schema_ref: schema,
  transcript_ref: draft ? "ai_visit_transcript_" + suffix : null, note_ref: draft ? "visit_note_" + suffix : null,
  status: draft ? "draft" : "not_prepared", note_type: "Synthetic SOAP", fields: draft ? { Plan: "No plan discussed." } : null,
  field_order: draft ? ["Plan"] : null, note_sha256: draft ? await sha256(JSON.stringify([["Plan", "No plan discussed."]])) : null,
  created_at: draft ? new Date().toISOString() : null, review_required: true, reviewed_source: reviewedSource(view),
});
type Poll = { readonly body: Readonly<Record<string, unknown>>; readonly signal: AbortSignal; readonly start: number;
  readonly complete: (value?: unknown, status?: number) => Promise<void> };
async function waiting() {
  const polls: Poll[] = []; let preparing = false, prepareCount = 0;
  const request: AuthorizedCoreRequest = async (_path, body, _key, signal) => {
    const response = (receipt: unknown, status = 200): Response => Response.json({ ...body,
      contract_version: "1", checked_at: new Date().toISOString(),
      ...(body.operation ? { operation: "creator_review" } : { action: body.action }), receipt,
    }, { status });
    if (body.action === "templates") return response({ session_id: id(2), templates: [{ schema_ref: schema, note_type: "Synthetic SOAP", field_names: ["Plan"] }] });
    if (body.action === "prepare") { prepareCount += 1; preparing = true; return response(await noteValue()); }
    if (!preparing) return response(body.operation ? ready() : await noteValue());
    const pending = deferred<Response>();
    polls.push({ body, signal, start: performance.now(), complete: async (value, status = 200) => {
      pending.resolve(response(value ?? (body.operation ? ready() : await noteValue()), status));
    } });
    return pending.promise; // Deliberately ignores abort, simulating late native I/O.
  };
  const f = mount({ request });
  await f.click("open"); await lastOptions().continueToNote!(ready());
  vi.useFakeTimers();
  await f.click("generate");
  expect(f.content.innerHTML).toContain("Waiting for your draft note");
  expect(polls).toHaveLength(2);
  return { ...f, polls, prepareCount: () => prepareCount,
    visibility: (value: string) => { Object.assign(document, { visibilityState: value }); document.dispatchEvent(new Event("visibilitychange")); },
  };
}
async function settle(polls: Poll[], offset = 0, draft = false) {
  const pair = polls.slice(offset, offset + 2);
  for (const poll of pair) await poll.complete(poll.body.operation ? ready() : await noteValue(draft));
  await vi.advanceTimersByTimeAsync(0);
}

it("uses a monotonic three-second start cadence and displays an exact fresh draft without another prepare", async () => {
  const f = await waiting(), first = f.polls[0]!.start;
  await vi.advanceTimersByTimeAsync(1200); await settle(f.polls);
  vi.setSystemTime(Date.now() + 86_400_000);
  await vi.advanceTimersByTimeAsync(2999 - (performance.now() - first)); expect(f.polls).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1); expect(f.polls).toHaveLength(4);
  expect(f.polls[2]!.start - first).toBe(3000);
  await settle(f.polls, 2, true);
  await vi.waitFor(() => expect(f.content.innerHTML).toContain("Saved · Not clinically reviewed"));
  await vi.advanceTimersByTimeAsync(10_000); expect(f.polls).toHaveLength(4);
  expect(f.prepareCount()).toBe(1); expect(f.recorder).not.toHaveBeenCalled();
});

it("never overlaps a pair slower than the interval and waits for its later GET", async () => {
  const f = await waiting(), first = f.polls[0]!.start;
  await vi.advanceTimersByTimeAsync(4500); await f.polls[0]!.complete(); await vi.advanceTimersByTimeAsync(0);
  expect(f.polls).toHaveLength(2);
  await f.polls[1]!.complete(); await vi.advanceTimersByTimeAsync(1);
  expect(f.polls).toHaveLength(4); expect(f.polls[2]!.start - first).toBeGreaterThanOrEqual(4500);
});

it.each([0, 1])("halts on early authorization failure from GET %s until the other GET settles", async failed => {
  const f = await waiting();
  await f.polls[failed]!.complete({}, 401); await vi.advanceTimersByTimeAsync(0);
  expect(f.content.querySelector("[data-note-readiness]")!.textContent).toContain("could not be confirmed");
  await f.click("check-note"); await vi.advanceTimersByTimeAsync(10_000); expect(f.polls).toHaveLength(2);
  await f.polls[1 - failed]!.complete(); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(10_000); expect(f.polls).toHaveLength(2);
  await f.click("check-note"); expect(f.polls).toHaveLength(4);
  expect(f.prepareCount()).toBe(1); expect(f.recorder).not.toHaveBeenCalled();
});

it("aborts the bounded thirty-second pair without overlapping its late I/O", async () => {
  const f = await waiting(), start = f.polls[0]!.start;
  await vi.advanceTimersByTimeAsync(30_000 - (performance.now() - start));
  expect(f.polls.every(poll => poll.signal.aborted)).toBe(true);
  await f.click("check-note"); await vi.advanceTimersByTimeAsync(30_000); expect(f.polls).toHaveLength(2);
  await settle(f.polls); await vi.advanceTimersByTimeAsync(3000); expect(f.polls).toHaveLength(2);
  await f.click("check-note"); expect(f.polls).toHaveLength(4); expect(f.prepareCount()).toBe(1);
});

it("does not overlap hidden aborted requests or apply their late responses", async () => {
  const f = await waiting(); f.visibility("hidden"); await vi.advanceTimersByTimeAsync(3500);
  expect(f.polls.every(poll => poll.signal.aborted)).toBe(true);
  f.visibility("visible"); await vi.advanceTimersByTimeAsync(0); expect(f.polls).toHaveLength(2);
  await settle(f.polls, 0, true); await vi.advanceTimersByTimeAsync(1);
  expect(f.content.innerHTML).toContain("Waiting for your draft note"); expect(f.polls).toHaveLength(4);
});

it("discards late draft responses after navigation and disposal", async () => {
  const f = await waiting(); await f.click("encounters");
  expect(f.content.innerHTML).toContain("Your encounters");
  await settle(f.polls, 0, true); await vi.advanceTimersByTimeAsync(10_000);
  expect(f.content.innerHTML).toContain("Your encounters"); expect(f.polls).toHaveLength(2);
  await f.dispose(); expect(f.root.innerHTML).toBe("");
});

it("aborts both reads on disposal and ignores their late replies", async () => {
  const f = await waiting(); await f.dispose();
  expect(f.polls.every(poll => poll.signal.aborted)).toBe(true);
  await settle(f.polls, 0, true); await vi.advanceTimersByTimeAsync(30_000);
  expect(f.root.innerHTML).toBe(""); expect(f.polls).toHaveLength(2);
});

it("aborts both reads when the authorized host expires and never checks again", async () => {
  const f = await waiting(); f.abort.abort(); await vi.advanceTimersByTimeAsync(0);
  expect(f.polls.every(poll => poll.signal.aborted)).toBe(true);
  await settle(f.polls, 0, true); await vi.advanceTimersByTimeAsync(30_000);
  expect(f.polls).toHaveLength(2); expect(f.content.innerHTML).not.toContain("Saved · Not clinically reviewed");
});

it("rejects a stale reviewed source instead of displaying or automatically retrying", async () => {
  const f = await waiting(), stale = ready();
  stale.working!.working_transcript_version += 1;
  await f.polls[0]!.complete(stale); await f.polls[1]!.complete(await noteValue()); await vi.advanceTimersByTimeAsync(0);
  expect(f.content.innerHTML).toContain("Waiting for your draft note");
  expect(f.content.querySelector("[data-note-readiness]")!.textContent).toContain("could not be confirmed");
  await vi.advanceTimersByTimeAsync(30_000); expect(f.polls).toHaveLength(2);
});

it("retains the original five-minute budget across wall-clock changes and aborts its last pair", async () => {
  const f = await waiting(), start = f.polls[0]!.start;
  await settle(f.polls); f.visibility("hidden"); vi.setSystemTime(Date.now() - 86_400_000);
  await vi.advanceTimersByTimeAsync(297_000 - (performance.now() - start)); f.visibility("visible"); await vi.advanceTimersByTimeAsync(0);
  expect(f.polls).toHaveLength(4); expect(f.polls[2]!.start - start).toBe(297_000);
  await vi.advanceTimersByTimeAsync(2999); expect(f.polls[2]!.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(f.polls[2]!.signal.aborted).toBe(true);
  expect(f.content.querySelector("[data-note-wait-time]")!.textContent).toBe("Automatic checking paused.");
  await settle(f.polls, 2, true); await vi.advanceTimersByTimeAsync(30_000);
  expect(f.content.innerHTML).toContain("Waiting for your draft note"); expect(f.polls).toHaveLength(4);
});
