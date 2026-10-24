import { afterEach, expect, it, vi } from "vitest";
import { Surface } from "./test-workspace-surface";
import { mountProviderWorkspace, type AuthorizedProviderEncounter, type ProviderWorkspaceHost } from "./workspace";
import { parseCreatorReview } from "../../../review-ui/src/creator-review-api";
import { mountCreatorReview } from "../../../review-ui/src/creator-review-panel";
import type * as CreatorPanel from "../../../review-ui/src/creator-review-panel";
import { bindTranscriptPlayback } from "../../../review-ui/src/passage-playback";
import { canonical, reviewedSource, sha256, type PendingNoteSave } from "./core-notes";
import type { AuthorizedCoreRequest } from "./core-client";
import type { JournalSnapshot } from "./workspace-journal";

// Real workspace mounting, note rendering, view toggling and lifetime checks run.
// Player lifecycle/audio are tested by passage-playback.test.ts; this boundary spy
// verifies the note supplies the existing capability and invokes stop/disposal.
vi.mock("../capture-app", () => ({}));
vi.mock("../../../review-ui/src/creator-review-panel", async () => ({
  ...await vi.importActual<typeof CreatorPanel>("../../../review-ui/src/creator-review-panel"),
  mountCreatorReview: vi.fn(() => vi.fn()), bindTranscriptTools: () => vi.fn(),
}));
vi.mock("../../../review-ui/src/passage-playback", () => ({ bindTranscriptPlayback: vi.fn(() => ({ render: vi.fn(), stop: vi.fn(), dispose: vi.fn() })) }));
vi.mock("./note-source-navigation", () => ({ bindNoteSourceNavigation: () => ({ refresh: vi.fn(), dispose: vi.fn() }) }));
const mounted = vi.mocked(mountCreatorReview), bound = vi.mocked(bindTranscriptPlayback);
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const suffix = "01j" + "0".repeat(23), ref = "appointment_" + suffix, schema = "doctor_note_schema_" + suffix;
const scope = { appointmentRef: ref, bindingRef: "scribe_capture_binding_" + suffix, workspaceId: id(1) };
const ready = () => parseCreatorReview({ schema_version: "1.0", session_id: id(2), status: "transcript_ready",
  source: { source_transcript_version: 1, segments: [{ source_segment_id: id(3), source_segment_version: 1,
    source_locale: "en-US", speaker_role: "unknown", content: "Invented passage.", start_ms: 0, end_ms: 1000 }] },
  working: { source_transcript_version: 1, working_transcript_id: id(4), working_transcript_version: 1,
    note_ready: true, blockers: [], segments: [{ source_segment_id: id(3), source_segment_version: 1,
      resolution: "english_source", content: "Invented passage." }] },
  review_queue: { schema_version: "1.0", session_id: id(2), source_transcript_version: 1,
    working_transcript_id: id(4), working_transcript_version: 1, status: "complete", items: [] },
}, id(2));
class TextArea extends Surface {
  value = "Unsaved invented clinical text";
  defaultValue = "Saved invented clinical text";
  selectionStart = 3;
  selectionEnd = 8;
  selectionDirection = "backward";
  scrollTop = 17;
  scrollLeft = 0;
  readOnly = true;
  parentElement: Surface | null = null;
  readonly focus = vi.fn();
  setSelectionRange(start: number, end: number, direction?: string): void { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction ?? "none"; }
}
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); vi.unstubAllGlobals(); });
async function mount(capability = true) {
  vi.stubGlobal("Element", Surface); vi.stubGlobal("HTMLTextAreaElement", TextArea);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible", activeElement: null }));
  vi.stubGlobal("window", { scrollX: 0, scrollY: 710, scrollTo: vi.fn(), matchMedia: () => ({ matches: false }) });
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
  const root = new Surface(), abort = new AbortController(), view = ready();
  const encounter = { appointmentRef: ref, title: "Invented visit", detail: "Synthetic fixture", status: "draft_ready" as const };
  const draft = { session_id: id(2), scribe_source_id: id(4), source_sha256: "a".repeat(64), schema_ref: schema,
    transcript_ref: "ai_visit_transcript_" + suffix, note_ref: "visit_note_" + suffix, status: "draft", note_type: "Synthetic SOAP",
    fields: { Plan: "Invented plan." }, field_order: ["Plan"], note_sha256: await sha256(JSON.stringify([["Plan", "Invented plan."]])),
    created_at: new Date().toISOString(), review_required: true, reviewed_source: reviewedSource(view) };
  const request = vi.fn<AuthorizedCoreRequest>(async (_path, body) => Response.json({ ...body, contract_version: "1", checked_at: new Date().toISOString(),
    ...(body.operation ? { operation: "creator_review" } : { action: body.action }),
    receipt: body.operation ? view : body.action === "templates" ? { session_id: id(2), templates: [{ schema_ref: schema, note_type: "Synthetic SOAP", field_names: ["Plan"] }] } : draft }));
  let snapshot: JournalSnapshot = { revision: "1", progress: { admission: null, sessionId: id(2), uploaded: true, pendingSave: null } };
  const journal = { load: vi.fn(async () => snapshot), save: vi.fn(async (_previous, progress) => { snapshot = { revision: "2", progress }; return snapshot; }) };
  const playPassage = vi.fn<NonNullable<AuthorizedProviderEncounter["playPassage"]>>(async () => null), recorder = vi.fn(async () => { throw new Error("Recording must stay closed"); });
  const active: AuthorizedProviderEncounter = { encounter, scope, request, signal: abort.signal, journal,
    openingReview: { scope, receivedAt: Date.now(), view }, ...(capability ? { playPassage } : {}),
    reviewJournal: () => ({ load: async () => null, save: vi.fn(), clear: vi.fn() }), recorder, openInCore: vi.fn() };
  const host: ProviderWorkspaceHost = { signal: abort.signal, listEncounters: vi.fn(async () => [encounter]), openEncounter: vi.fn(async () => active), createEncounter: vi.fn() };
  const dispose = mountProviderWorkspace(root as unknown as HTMLElement, host); disposers.push(dispose);
  const content = root.querySelector("[data-workspace-content]")!;
  const click = async (action: string): Promise<void> => {
    await vi.waitFor(() => expect(root.attributes.has("aria-busy")).toBe(false));
    const button = new Surface(); button.dataset.workspaceAction = action; button.dataset.appointment = ref;
    const event = new Event("click"); Object.defineProperty(event, "target", { value: button }); root.dispatchEvent(event);
    await vi.waitFor(() => expect(root.attributes.has("aria-busy")).toBe(false));
  };
  await click("open"); await mounted.mock.lastCall![2]!.continueToNote!(view);
  expect(content.innerHTML).toContain('class="provider-note"');
  const options = bound.mock.lastCall![1], player = bound.mock.results.at(-1)!.value as ReturnType<typeof bindTranscriptPlayback>;
  return { root, content, view, options, player, playPassage, recorder, abort, dispose, click, request, journal, draft };
}

it("binds the authorized saved-note transcript to its existing passage capability and live encounter signal", async () => {
  const f = await mount();
  expect(bound).toHaveBeenCalledOnce(); expect(bound.mock.lastCall![0]).toBe(f.content);
  expect(f.options.current()).toEqual(f.view); expect(f.options.playPassage).toBe(f.playPassage);
  expect(f.options.signal?.aborted).toBe(false); expect(f.player.render).toHaveBeenCalledOnce();
  await f.options.playPassage!(id(2), id(3), new AbortController().signal);
  expect(f.playPassage).toHaveBeenCalledWith(id(2), id(3), expect.any(AbortSignal));
  expect(f.recorder).not.toHaveBeenCalled();
  await f.click("encounters");
  expect(f.options.current()).toBeNull(); expect(f.options.signal?.aborted).toBe(true); expect(f.player.dispose).toHaveBeenCalledOnce();
});

it("keeps the capability absent on devices that do not supply passage playback", async () => {
  const f = await mount(false); expect(f.options.playPassage).toBeUndefined(); expect(f.playPassage).not.toHaveBeenCalled();
});

it("stops playback on conversation hide without rerendering note text or losing its editing position", async () => {
  const f = await mount(); const markup = f.content.innerHTML;
  const note = Object.assign(new Surface(), { scrollIntoView: vi.fn(), scrollTop: 0, scrollLeft: 0, parentElement: null });
  note.dataset.conversation = "hidden";
  const evidence = new Surface(), details = Object.assign(new Surface(), { open: false }), back = Object.assign(new Surface(), { focus: vi.fn() }), toggle = Object.assign(new Surface(), { focus: vi.fn() });
  note.nodes.set(".provider-note-evidence", evidence); note.nodes.set('[data-workspace-action="transcript-view"]', toggle);
  evidence.nodes.set("details", details); evidence.nodes.set("[data-note-back]", back);
  f.content.nodes.set(".provider-note", note);
  const editor = new TextArea(); editor.parentElement = note; Object.assign(document, { activeElement: editor });
  await f.click("transcript-view"); expect(note.dataset.conversation).toBe("shown"); expect(f.player.stop).not.toHaveBeenCalled();
  await f.click("note-view");
  expect(note.dataset.conversation).toBe("hidden"); expect(f.player.stop).toHaveBeenCalledOnce(); expect(f.player.dispose).not.toHaveBeenCalled();
  expect(f.content.innerHTML).toBe(markup); expect(f.content.nodes.get(".provider-note")).toBe(note); expect(editor.parentElement).toBe(note);
  expect([editor.value, editor.defaultValue, editor.selectionStart, editor.selectionEnd, editor.selectionDirection, editor.scrollTop, editor.readOnly])
    .toEqual(["Unsaved invented clinical text", "Saved invented clinical text", 3, 8, "backward", 17, true]);
  expect(editor.focus).toHaveBeenCalledWith({ preventScroll: true });
});

it("revokes the mounted playback view and disposes it when the host session aborts", async () => {
  const f = await mount(); f.abort.abort();
  expect(f.options.current()).toBeNull(); expect(f.options.signal?.aborted).toBe(true);
  await vi.waitFor(() => expect(f.player.dispose).toHaveBeenCalledOnce());
});

it.each(["automatic", "manual"] as const)("%s save recovery stops playback before replacing the transcript while retaining its editor", async mode => {
  const f = await mount(), before = f.options.current(), markup = f.content.innerHTML;
  const editor = new TextArea(); editor.defaultValue = f.draft.fields.Plan; editor.value = "Submitted invented correction."; editor.readOnly = false;
  const queryAll = f.content.querySelectorAll.bind(f.content);
  f.content.querySelectorAll = selector => selector === "textarea[data-note-field]" ? [editor] : queryAll(selector);
  f.content.nodes.set('[name="note-0"]', editor); f.content.nodes.set("textarea[data-note-field]", editor);
  Object.assign(document, { activeElement: editor, createElement: () => new Surface() });
  let submitted: PendingNoteSave["edit"] | null = null;
  const viewAtStop: ReturnType<typeof f.options.current>[] = [];
  vi.mocked(f.player.stop).mockImplementation(() => { viewAtStop.push(f.options.current()); });
  f.request.mockImplementation(async (_path, body) => {
    const response = (receipt: unknown) => Response.json({ ...body, contract_version: "1", checked_at: new Date().toISOString(),
      ...(body.operation ? { operation: "creator_review" } : { action: body.action }), receipt });
    if (body.operation) return response(ready());
    if (body.action === "save") { submitted = body.edit as PendingNoteSave["edit"]; return new Response(null, { status: 503 }); }
    if (!submitted) throw new Error("Save recovery must follow the normal submitted edit");
    const noteRef = "visit_note_" + suffix.slice(0, -1) + "1";
    const noteHash = await sha256(JSON.stringify([["Plan", submitted.fields.Plan]]));
    if (body.action === "save_status" || body.action === "resolve") {
      const pending = mode === "manual" && body.action === "save_status";
      return response({ session_id: id(2), schema_ref: schema, client_key: submitted.client_key,
        request_sha256: await sha256(canonical({ edit: submitted, schema, session: id(2), workspace: scope.workspaceId })),
        status: pending ? "pending" : "saved", result_note_ref: pending ? null : noteRef, result_sha256: pending ? null : noteHash });
    }
    if (body.action === "read") return response({ ...f.draft, note_ref: noteRef, fields: submitted.fields, note_sha256: noteHash });
    throw new Error("Unexpected recovery operation");
  });
  await f.click("save");
  if (mode === "manual") {
    expect((await f.journal.load()).progress?.pendingSave).not.toBeNull();
    expect(f.player.stop).not.toHaveBeenCalled(); await f.click("resolve");
  }
  await vi.waitFor(async () => expect((await f.journal.load()).progress?.pendingSave).toBeNull());
  await vi.waitFor(() => expect(f.player.stop).toHaveBeenCalledOnce());
  expect(viewAtStop).toEqual([before]); expect(viewAtStop[0]).toBe(before);
  expect(f.options.current()).not.toBe(before); expect(f.options.current()).toEqual(before);
  expect(f.player.dispose).not.toHaveBeenCalled(); expect(bound).toHaveBeenCalledOnce();
  expect(f.content.innerHTML).toBe(markup); expect(f.content.nodes.get('[name="note-0"]')).toBe(editor);
  expect([editor.value, editor.defaultValue, editor.selectionStart, editor.selectionEnd, editor.scrollTop, editor.readOnly])
    .toEqual(["Submitted invented correction.", "Submitted invented correction.", 3, 8, 17, false]);
  expect(f.request.mock.calls.filter(([, body]) => body.action === "save")).toHaveLength(1);
});
