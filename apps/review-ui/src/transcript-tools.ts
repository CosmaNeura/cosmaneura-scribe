import type { CreatorReviewView } from "./creator-review-api";
import { isUuid } from "./contracts";

export interface TranscriptEvidenceReference {
  readonly working_transcript_id: string;
  readonly working_transcript_version: number;
  readonly source_transcript_version: number;
  readonly source_segment_id: string;
  readonly source_segment_version: number;
}

/** Render only supplied, exact-version evidence; never infer a citation from similar words. */
export function renderTranscriptEvidenceLinks(view: CreatorReviewView, references: readonly TranscriptEvidenceReference[]): string {
  if (!view.source || !view.working) return "";
  const seen = new Set<string>();
  return references.flatMap(reference => {
    const segment = view.source?.segments.find(item => item.source_segment_id === reference.source_segment_id
      && item.source_segment_version === reference.source_segment_version);
    if (!segment || !isUuid(segment.source_segment_id) || seen.has(segment.source_segment_id) || reference.working_transcript_id !== view.working?.working_transcript_id
      || reference.working_transcript_version !== view.working.working_transcript_version
      || reference.source_transcript_version !== view.source?.source_transcript_version) return [];
    seen.add(segment.source_segment_id);
    const seconds = Math.floor(segment.start_ms / 1000), time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    return [`<button type="button" data-transcript-evidence="${segment.source_segment_id}">Transcript ${time}</button>`];
  }).join(" ");
}

/** Search is a reading aid only: it never changes transcript content or speaker turns. */
export function transcriptSearchText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

export function bindTranscriptTools(root: HTMLElement): () => void {
  const activeRows = new WeakMap<Element, number>();
  const applySearch = (surface: Element): void => {
    const input = surface.querySelector<HTMLInputElement>("[data-transcript-search]");
    const query = transcriptSearchText(input?.value ?? "");
    let count = 0;
    const rows = surface.querySelectorAll<HTMLElement>("[data-transcript-segment]");
    for (const row of rows) {
      const content = [...row.querySelectorAll(".creator-language-grid, .creator-segment-heading")]
        .map(part => part.textContent ?? "").join(" ");
      row.hidden = query !== "" && !transcriptSearchText(content).includes(query);
      row.removeAttribute("data-search-current");
      if (!row.hidden) count += 1;
    }
    activeRows.delete(surface);
    const status = surface.querySelector<HTMLElement>("[data-transcript-search-status]");
    if (status) status.textContent = query ? `${count} matching ${count === 1 ? "turn" : "turns"}` : `${count} transcript ${count === 1 ? "turn" : "turns"}`;
    for (const button of surface.querySelectorAll<HTMLButtonElement>("[data-transcript-match]")) button.disabled = !query || count === 0;
  };
  const move = (surface: Element, direction: number): void => {
    const rows = [...surface.querySelectorAll<HTMLElement>("[data-transcript-segment]")].filter(row => !row.hidden);
    if (rows.length === 0) return;
    const current = activeRows.get(surface) ?? (direction > 0 ? -1 : 0);
    const index = (current + direction + rows.length) % rows.length;
    for (const row of rows) row.removeAttribute("data-search-current");
    const row = rows[index];
    if (!row) return;
    row.dataset.searchCurrent = "true";
    activeRows.set(surface, index);
    row.scrollIntoView({ block: "center", behavior: "auto" });
    row.focus({ preventScroll: true });
  };
  const onInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.matches("[data-transcript-search]")) return;
    const surface = target.closest("[data-transcript-surface]");
    if (surface && root.contains(surface)) applySearch(surface);
  };
  const onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const evidence = target.closest<HTMLButtonElement>("[data-transcript-evidence]");
    if (evidence && root.contains(evidence)) {
      const segmentId = evidence.dataset.transcriptEvidence;
      const row = [...root.querySelectorAll<HTMLElement>("[data-transcript-segment]")]
        .find(item => item.dataset.transcriptSegment === segmentId);
      if (!row) return;
      const surface = row.closest("[data-transcript-surface]");
      const input = surface?.querySelector<HTMLInputElement>("[data-transcript-search]");
      if (input && surface) { input.value = ""; applySearch(surface); }
      const details = row.closest<HTMLDetailsElement>("[data-note-transcript]");
      if (details) details.open = true;
      root.dispatchEvent(new CustomEvent("scribe-transcript-evidence", { bubbles: true, detail: { sourceSegmentId: segmentId } }));
      row.scrollIntoView({ block: "center", behavior: "auto" });
      row.focus({ preventScroll: true });
      return;
    }
    const button = target.closest<HTMLButtonElement>("[data-transcript-match], [data-transcript-clear]");
    if (!button || !root.contains(button) || button.disabled) return;
    const surface = button.closest("[data-transcript-surface]");
    if (!surface) return;
    if (button.hasAttribute("data-transcript-clear")) {
      const input = surface.querySelector<HTMLInputElement>("[data-transcript-search]");
      if (input) { input.value = ""; applySearch(surface); input.focus(); }
    } else move(surface, button.dataset.transcriptMatch === "previous" ? -1 : 1);
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)
      || !event.target.matches("[data-transcript-search]")) return;
    const surface = event.target.closest("[data-transcript-surface]");
    if (surface && root.contains(surface)) { event.preventDefault(); move(surface, event.shiftKey ? -1 : 1); }
  };
  root.addEventListener("input", onInput);
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKeydown);
  return () => {
    root.removeEventListener("input", onInput);
    root.removeEventListener("click", onClick);
    root.removeEventListener("keydown", onKeydown);
  };
}
