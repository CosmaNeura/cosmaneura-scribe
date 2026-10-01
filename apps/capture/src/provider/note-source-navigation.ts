import type { CreatorReviewView } from "../../../review-ui/src/creator-review-api";
import { canonical, reviewedSource, type CoreDraft } from "./core-notes";
import { noteSourceMatches, type NoteSourceMatch } from "./note-source-matches";

interface NotePair { readonly draft: CoreDraft; readonly view: CreatorReviewView }
interface Options {
  /** Null immediately after authorization, encounter or displayed note changes. */
  current(): NotePair | null;
  revealTranscript(rememberPosition: boolean): void;
  returnToNote(): void;
}
interface FieldLinks { readonly key: string; readonly field: HTMLTextAreaElement; readonly value: string; readonly container: HTMLElement }

/** Add reading controls beside existing fields; never replace, save or edit them. */
export function bindNoteSourceNavigation(root: HTMLElement, options: Options): { refresh: () => void; dispose: () => void } {
  let bound: NotePair | null = null, identity = "", disposed = false, returning = false;
  let fields: FieldLinks[] = [];
  const buttons = new Map<HTMLButtonElement, { field: FieldLinks; match: NoteSourceMatch; wording: string; resolution: string; role: string }>();
  const back = document.createElement("button");
  back.type = "button"; back.dataset.noteSourceBack = ""; back.textContent = "Back to note"; back.hidden = true;
  const fingerprint = (pair: NotePair): string => canonical({ note: pair.draft.note_ref, hash: pair.draft.note_sha256,
    sourceHash: pair.draft.source_sha256, schema: pair.draft.schema_ref, session: pair.draft.session_id,
    status: pair.draft.status, scribeSource: pair.draft.scribe_source_id, transcriptRef: pair.draft.transcript_ref, order: pair.draft.field_order,
    draftSource: pair.draft.reviewed_source, transcript: reviewedSource(pair.view) });
  const sourceIdentity = (pair: NotePair): string => canonical({ session: pair.view.session_id, source: reviewedSource(pair.view) });
  let displayedSource = "";
  try { const initial = options.current(); if (initial) displayedSource = sourceIdentity(initial); } catch { /* No valid source was rendered. */ }
  const active = (): boolean => {
    if (disposed || !root.isConnected || !bound) return false;
    const current = options.current();
    try { return !!current && current.draft === bound.draft && current.view === bound.view && fingerprint(current) === identity
      && sourceIdentity(current) === displayedSource; }
    catch { return false; }
  };
  const clear = (): void => {
    for (const item of fields) item.container.remove();
    fields = []; buttons.clear(); back.remove(); returning = false; back.hidden = true;
  };
  const syncField = (item: FieldLinks): void => {
    const enabled = active() && bound!.draft.fields?.[item.key] === item.value
      && root.contains(item.field) && item.field.value === item.value && item.field.defaultValue === item.value;
    item.container.hidden = !enabled;
    for (const button of item.container.querySelectorAll("button")) button.disabled = !enabled;
  };
  const refresh = (): void => {
    if (disposed) return;
    const pair = options.current();
    let nextIdentity = "";
    // Saving may replace the note in place. A different transcript requires its
    // actual rows to be rendered and a new binding, never just new link buttons.
    try { if (pair && sourceIdentity(pair) === displayedSource) nextIdentity = fingerprint(pair); }
    catch { /* Unavailable lineage gives no reading shortcuts. */ }
    if (pair?.draft === bound?.draft && pair?.view === bound?.view && nextIdentity === identity) return;
    clear(); bound = pair; identity = nextIdentity;
    if (!pair || !identity) return;
    const matches = noteSourceMatches(pair.draft, pair.view);
    for (const [index, key] of (pair.draft.field_order ?? []).entries()) {
      const links = matches.get(key), field = root.querySelector<HTMLTextAreaElement>(`textarea[data-note-field][name="note-${index}"]`);
      const label = field?.closest("label");
      if (!field || !label || !links?.length) continue;
      const container = document.createElement("div"); container.className = "provider-note-source-matches";
      container.setAttribute("aria-label", "Matching transcript wording");
      const item: FieldLinks = { key, field, value: pair.draft.fields![key]!, container };
      for (const match of links) {
        const working = pair.view.working!.segments.find(segment => segment.source_segment_id === match.source_segment_id)!;
        const seconds = Math.floor(match.startMs / 1000), button = document.createElement("button");
        button.type = "button"; button.dataset.noteSourceMatch = "";
        button.textContent = `Check in transcript · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        buttons.set(button, { field: item, match, wording: working.content!, resolution: working.resolution, role: working.speaker_role }); container.append(button);
      }
      fields.push(item); label.after(container); syncField(item);
    }
    if (fields.length) root.querySelector(".provider-note-source-toolbar")?.append(back);
  };
  const onInput = (event: Event): void => {
    const item = fields.find(value => value.field === event.target);
    if (item) syncField(item);
  };
  const onFocus = (event: FocusEvent): void => {
    if (event.target instanceof HTMLTextAreaElement && event.target.hasAttribute("data-note-field")) {
      returning = false; back.hidden = true;
    }
  };
  const onClick = (event: MouseEvent): void => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    if (!(button instanceof HTMLButtonElement)) return;
    if (button === back) {
      if (!active() || back.hidden) return;
      back.hidden = true; returning = false; options.returnToNote(); return;
    }
    if (button.dataset.workspaceAction === "note-view") { returning = false; back.hidden = true; return; }
    const item = buttons.get(button);
    if (!item || !active() || button.disabled || !root.contains(button) || !root.contains(item.field.field)
      || bound!.draft.fields?.[item.field.key] !== item.field.value
      || item.field.field.value !== item.field.value || item.field.field.defaultValue !== item.field.value) return;
    const original = bound!.view.source?.segments.find(segment => segment.source_segment_id === item.match.source_segment_id);
    const working = bound!.view.working?.segments.find(segment => segment.source_segment_id === item.match.source_segment_id);
    if (original?.source_segment_version !== item.match.source_segment_version || original.start_ms !== item.match.startMs
      || working?.source_segment_version !== item.match.source_segment_version || working.content !== item.wording
      || working.resolution !== item.resolution || working.speaker_role !== item.role) return;
    const rows = [...root.querySelectorAll<HTMLElement>("[data-transcript-segment]")]
      .filter(row => row.dataset.transcriptSegment === item.match.source_segment_id);
    if (rows.length !== 1) return;
    const row = rows[0]!;
    options.revealTranscript(!returning); returning = true; back.hidden = false;
    // Reuse the bound transcript search's local input path, not its unguarded
    // generic evidence-button event. This cannot initiate a review or request.
    const input = row.closest("[data-transcript-surface]")?.querySelector<HTMLInputElement>("[data-transcript-search]");
    if (input) { input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); }
    const details = row.closest<HTMLDetailsElement>("[data-note-transcript]");
    if (details) details.open = true;
    for (const other of root.querySelectorAll("[data-search-current]")) other.removeAttribute("data-search-current");
    row.dataset.searchCurrent = "true";
    const pane = row.closest<HTMLElement>("[data-note-transcript-scroll]");
    if (pane) {
      // Reveal the bounded comparison, then scroll only its panes. A late
      // transcript match must not move the note offscreen with the whole page.
      root.querySelector(".provider-note-grid")?.scrollIntoView({ block: "nearest", behavior: "auto" });
      if (window.matchMedia("(min-width: 900px)").matches) {
        const editor = item.field.field.closest<HTMLElement>(".provider-note-editor");
        if (editor) centerWithin(editor, item.field.field.closest("label") ?? item.field.field);
      }
      centerWithin(pane, row);
    } else row.scrollIntoView({ block: "center", behavior: "auto" });
    row.focus({ preventScroll: true });
  };
  root.addEventListener("input", onInput); root.addEventListener("focusin", onFocus); root.addEventListener("click", onClick);
  refresh();
  return { refresh, dispose: () => {
    disposed = true; clear(); bound = null;
    root.removeEventListener("input", onInput); root.removeEventListener("focusin", onFocus); root.removeEventListener("click", onClick);
  } };
}

function centerWithin(pane: HTMLElement, target: Element): void {
  const item = target.getBoundingClientRect(), viewport = pane.getBoundingClientRect();
  pane.scrollTop += item.top - viewport.top - Math.max(0, (pane.clientHeight - item.height) / 2);
}
