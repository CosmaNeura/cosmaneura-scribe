import {
  CreatorReviewError,
  type CreatorReviewApi,
  type CreatorReviewView,
} from "./creator-review-api";
import {
  parsePendingReviewDecision,
  type CreatorReviewJournal,
  type PendingReviewDecision,
} from "./creator-review-journal";
import "./creator-review.css";
import { isUuid } from "./contracts";

type Phase = "loading" | "ready" | "saving" | "retry" | "unavailable";
export interface CreatorReviewState {
  readonly phase: Phase;
  readonly view: CreatorReviewView | null;
  readonly notice: string;
}

export interface CreatorReviewOptions {
  readonly journal?: CreatorReviewJournal;
  /** Open the host's existing Core note flow with this action's fresh authorized read. */
  readonly continueToNote?: (view: CreatorReviewView) => Promise<void>;
  /** Coordinated fresh read, consumed only by this still-current explicit action. */
  readonly prepareNoteOpening?: () => Promise<{ view: CreatorReviewView; open: () => Promise<void> }>;
}

/** Mount in the authenticated standalone or OS shell; dispose on logout/session change. */
export function mountCreatorReview(
  root: HTMLElement, api: CreatorReviewApi, options: CreatorReviewOptions = {},
): () => void {
  let state: CreatorReviewState = { phase: "loading", view: null, notice: "" };
  let pending: PendingReviewDecision | null = null;
  let disposed = false;
  let generation = 0;
  let recovered = false;
  let continuing = false;
  let refreshing = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const clearRefresh = (): void => { clearTimeout(refreshTimer); refreshTimer = undefined; };
  const waitingForTranscript = (): boolean => state.phase === "ready" && pending === null && !continuing
    && state.view?.source === null && ["uploaded", "processing"].includes(state.view.status);
  const scheduleRefresh = (): void => {
    clearRefresh();
    if (!disposed && waitingForTranscript() && document.visibilityState === "visible") {
      refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh(true); }, 3000);
    }
  };
  const render = (): void => {
    if (disposed) return;
    root.innerHTML = renderCreatorReview(state);
    if (state.phase === "ready" && state.view?.working?.note_ready && options.continueToNote) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.reviewAction = "continue";
      button.disabled = continuing;
      button.textContent = continuing ? "Opening note…" : "Continue to note";
      root.querySelector(".creator-status")?.append(button);
    }
  };

  const refresh = async (automatic = false): Promise<void> => {
    if (disposed || pending !== null || refreshing
      || automatic && (document.visibilityState !== "visible" || !waitingForTranscript())) return;
    clearRefresh();
    refreshing = true;
    const request = ++generation;
    state = { ...state, phase: "loading", view: automatic ? state.view : null };
    // Processing has no transcript content. Keep its status stable during the
    // background read instead of flashing the loading screen every three seconds.
    if (!automatic) render();
    try {
      const view = await api.read();
      if (disposed || request !== generation) return;
      // A fresh authorized read must succeed before opening local recovery metadata.
      if (!recovered && options.journal) {
        const saved = await options.journal.load();
        if (disposed || request !== generation) return;
        pending = saved === null ? null : parsePendingReviewDecision(saved);
      }
      recovered = true;
      if (pending !== null) {
        state = { phase: "retry", view: null,
          notice: "A previous decision needs confirmation. Retry that same decision to recover its result." };
        return;
      }
      state = { ...state, phase: "ready", view };
    } catch {
      if (disposed || request !== generation) return;
      state = {
        phase: "unavailable", view: null,
        notice: "This recording is unavailable. Check your session or access, then refresh.",
      };
    } finally {
      refreshing = false;
      if (!disposed && request === generation) { render(); scheduleRefresh(); }
    }
  };

  const save = async (): Promise<void> => {
    if (disposed || pending === null || state.phase === "saving") return;
    clearRefresh();
    const operation = pending;
    state = { ...state, phase: "saving", notice: "Saving your decision…" };
    render();
    try {
      if (options.journal) await options.journal.save(operation);
      if (disposed) return;
      await api.decide(operation.request, operation.key);
      if (disposed) return;
      if (options.journal) await options.journal.clear(operation.key);
      if (disposed) return;
      pending = null;
      state = { ...state, notice: "Decision saved." };
      await refresh();
    } catch (error) {
      if (disposed) return;
      if (error instanceof CreatorReviewError && error.kind === "conflict") {
        try {
          if (options.journal) await options.journal.clear(operation.key);
          if (disposed) return;
          pending = null;
          state = { ...state, notice: "The review changed. Check the current version before deciding again." };
          await refresh();
        } catch {
          state = { phase: "retry", view: null, notice: "Recovery storage is unavailable. Retry to confirm the saved decision." };
          render();
        }
      } else {
        // Preserve only the exact metadata request, not protected transcript text.
        state = {
          phase: "retry", view: null,
          notice: "The save is unconfirmed. Retry the same decision; do not submit a different one.",
        };
        render();
      }
    }
  };

  const continueToNote = async (): Promise<void> => {
    if (continuing || disposed || pending !== null || state.phase !== "ready" || !options.continueToNote) return;
    clearRefresh();
    const request = ++generation;
    continuing = true;
    render();
    try {
      const opening = options.prepareNoteOpening ? await options.prepareNoteOpening() : undefined;
      const view = opening?.view ?? await api.read();
      if (disposed || request !== generation) return;
      state = { ...state, view };
      if (view.working?.note_ready !== true) {
        state = { ...state, notice: "The transcript changed. Complete its current review before preparing a note." };
      } else {
        if (opening) await opening.open();
        else await options.continueToNote(view);
      }
    } catch {
      if (disposed || request !== generation) return;
      state = { phase: "unavailable", view: null, notice: "The note could not be opened. Check access and refresh before trying again." };
    } finally {
      continuing = false;
      render();
      scheduleRefresh();
    }
  };

  const onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("button[data-review-action]");
    if (button === null || !root.contains(button) || button.disabled) return;
    const action = button.dataset.reviewAction;
    if (action === "continue") { void continueToNote(); return; }
    if (action === "refresh") { void refresh(); return; }
    if (action === "retry") { void save(); return; }
    if (pending !== null || state.phase !== "ready" || state.view?.review_queue == null) return;
    if (action !== "accepted" && action !== "rejected") return;
    const item = state.view.review_queue.items?.find(
      (candidate) => candidate.source_segment_id === button.dataset.segment,
    );
    if (item === undefined) return;
    pending = {
      key: `review-${crypto.randomUUID()}`,
      request: {
        schema_version: "1.0",
        expected_source_transcript_version: state.view.review_queue.source_transcript_version,
        source_segment_id: item.source_segment_id,
        expected_source_segment_version: item.source_segment_version,
        translation_id: item.translation_id,
        expected_translation_version: item.translation_version,
        decision: action,
      },
    };
    void save();
  };

  const visibilityChanged = (): void => {
    clearRefresh();
    if (document.visibilityState === "visible" && waitingForTranscript()) void refresh(true);
  };
  root.addEventListener("click", onClick);
  document.addEventListener("visibilitychange", visibilityChanged);
  render();
  void refresh();
  return () => {
    disposed = true;
    clearRefresh();
    generation += 1;
    pending = null;
    state = { phase: "unavailable", view: null, notice: "" };
    root.removeEventListener("click", onClick);
    document.removeEventListener("visibilitychange", visibilityChanged);
    root.replaceChildren();
  };
}

export function renderCreatorReview(state: CreatorReviewState): string {
  const view = state.view;
  const ready = view?.working?.note_ready === true;
  const sourceSegments = view?.source?.segments ?? [];
  const languageLabel = sourceSegments.some(segment => segment.source_locale === "es-US")
    ? "Spanish → English · "
    : sourceSegments.length > 0 && sourceSegments.every(segment => segment.source_locale === "en-US")
      ? "English · " : "";
  const subtitle = ready
    ? "English transcript ready"
    : view === null ? "Your recording" : reviewStatusCopy(view);
  return `<section class="creator-review" aria-label="Your recording and transcript">
    <header class="creator-review-header">
      <div><p class="creator-eyebrow">Cosmaneura Scribe</p><h1>Review your recording</h1>
      <p>${languageLabel}Original speech preserved</p></div>
      <button type="button" data-review-action="refresh"
        ${["loading", "saving", "retry"].includes(state.phase) ? "disabled" : ""}>Refresh</button>
    </header>
    <div class="creator-status ${ready ? "creator-ready" : ""}" role="status">
      <strong>${escape(subtitle)}</strong>
      <p>${escape(state.notice || (ready
        ? "Review is complete. Your transcript is ready for note preparation."
        : view?.status === "uploaded" || view?.status === "processing"
          ? "Your transcript will appear here automatically when it is ready."
        : view?.status === "translation_pending"
          ? "The transcript is not ready for a note. Check the messages below for what is still needed."
          : "Review the proposed English before it is used for a note."))}</p>
    </div>
    ${view?.capture_continuity ? '<p class="creator-blocker" role="status">Recording continuity is unconfirmed. Review for missing speech before using a note. Gap lengths are unknown.</p>' : ""}
    ${state.phase === "retry" ? `<button type="button" data-review-action="retry">Retry the same decision</button>` : ""}
    ${state.phase === "loading" ? '<p aria-busy="true">Loading the current recording…</p>' : ""}
    ${view?.source != null && view.working != null ? renderTranscript(view, state.phase) : ""}
  </section>`;
}

/** Reuse the already-authorized transcript without mounting decision controls. */
export function renderNoteTranscript(view: CreatorReviewView): string {
  if (!view.working?.note_ready || !view.source) return "";
  return `<details data-note-transcript><summary>Compare with recording transcript</summary>
    ${renderTranscript(view, "ready", true)}</details>`;
}

function renderTranscript(view: CreatorReviewView, phase: Phase, readOnly = false): string {
  const working = view.working;
  const source = view.source;
  if (working == null || source == null) return "";
  const reviews = new Map((view.review_queue?.items ?? []).map((item) => [item.source_segment_id, item]));
  const resolved = new Map(working.segments.map((item) => [item.source_segment_id, item]));
  const blockers = working.blockers ?? [];
  const hasSpanish = source.segments.some(segment => segment.source_locale === "es-US");
  const progress = new Map((view.translation_progress ?? []).map((item) => [item.source_segment_id, item.state]));
  const speakers = new Map<string, number>();
  for (const segment of source.segments) {
    if (isUuid(segment.speaker_id) && !speakers.has(segment.speaker_id)) speakers.set(segment.speaker_id, speakers.size + 1);
  }
  return `<div class="creator-transcript-heading"><h2>Transcript</h2>
    <span>Version ${working.working_transcript_version}</span></div>
    <p class="creator-help">${hasSpanish ? "English speech stays in English. Spanish is shown beside its translation." : "Original speech is shown below."}
    ${readOnly ? "Compare the wording with your draft. Expanding this transcript keeps your unsaved edits in place."
    : hasSpanish ? "Accept only a faithful translation; reject one that changes the meaning."
      : "Review the transcript for accuracy before preparing your note."}</p>
    <ol class="creator-segments">${source.segments.map((segment) => {
      const review = reviews.get(segment.source_segment_id);
      const english = resolved.get(segment.source_segment_id);
      const issues = blockers.filter((blocker) => blocker.source_segment_id === segment.source_segment_id);
      const pending = progress.get(segment.source_segment_id);
      const englishText = review?.translated_content ?? english?.content;
      const spanish = segment.source_locale === "es-US";
      const speaker = speakers.get(segment.speaker_id);
      return `<li class="creator-segment">
        <div class="creator-segment-heading"><strong>${segment.speaker_role === "unknown" && speaker
          ? `Speaker ${speaker} · not identified` : speakerCopy(segment.speaker_role)}</strong>
          <span>${time(segment.start_ms)}–${time(segment.end_ms)}</span></div>
        <div class="creator-language-grid ${spanish ? "creator-bilingual" : ""}">
          <div>${segment.source_locale === "en-US" ? "" : `<h3>${spanish ? "Spanish · original" : "Original · language unconfirmed"}</h3>`}
            ${transcriptParagraphs(segment.content).map(part => `<p lang="${spanish ? "es" : segment.source_locale === "en-US" ? "en" : "und"}">${escape(part)}</p>`).join("")}</div>
          ${spanish ? `<div><h3>English · ${review ? "proposed translation" : english?.resolution === "spanish_translation" ? "accepted translation" : "not ready"}</h3>
            ${transcriptParagraphs(englishText ?? "Translation is not ready for use.").map(part => `<p lang="en">${escape(part)}</p>`).join("")}</div>` : ""}
        </div>
        ${readOnly ? "" : review === undefined ? (pending === undefined
          ? issues.map((issue) => `<p class="creator-blocker">${escape(blockerCopy(issue.code))}</p>`).join("")
          : `<p class="creator-blocker">${escape(progressCopy(pending))}</p>`) : `
          <div class="creator-review-actions">
            <button type="button" data-review-action="accepted" data-segment="${escape(segment.source_segment_id)}" ${phase === "saving" ? "disabled" : ""}>Accept English translation</button>
            <button type="button" class="creator-reject" data-review-action="rejected" data-segment="${escape(segment.source_segment_id)}" ${phase === "saving" ? "disabled" : ""}>Reject translation</button>
          </div>`}
      </li>`;
    }).join("")}</ol>`;
}

/** Reading breaks only: every source character remains in its original order.
 * A paragraph is not a new speaker turn or a stored transcript edit. */
export function transcriptParagraphs(text: string): string[] {
  const paragraphs: string[] = [];
  let pending = "", count = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text)) {
    if (pending && (pending.length + segment.length > 400 || count >= 2)) {
      paragraphs.push(pending); pending = ""; count = 0;
    }
    pending += segment; count += 1;
    while (pending.length > 400) {
      let split = pending.lastIndexOf(" ", 400);
      if (split <= 0) split = pending.indexOf(" ", 400);
      if (split < 0) break;
      paragraphs.push(pending.slice(0, split + 1)); pending = pending.slice(split + 1); count = 0;
    }
  }
  if (pending) paragraphs.push(pending);
  return paragraphs;
}

function reviewStatusCopy(view: CreatorReviewView): string {
  if (view.status === "quality_blocked") return statusCopy(view.status);
  const progress = view.translation_progress ?? [];
  if (progress.some((item) => item.state === "unconfirmed")) return "Translation result unconfirmed";
  const progressing = new Set(progress.map((item) => item.source_segment_id));
  if (view.working?.blockers.some((item) => !progressing.has(item.source_segment_id)
    && ["translation_retry_required", "translation_failed"].includes(item.code))) {
    return "Translation needs a new attempt";
  }
  if (progress.length > 0 && progress.every((item) => item.state === "result_saved")) {
    return "Preparing translation review";
  }
  return statusCopy(view.status);
}

function progressCopy(state: "queued" | "unconfirmed" | "result_saved"): string {
  return {
    queued: "Waiting for this translation to start. Refresh to check progress.",
    unconfirmed: "This translation request has no confirmed result yet. Refresh later; a second request will not be sent automatically.",
    result_saved: "The translation result is saved and is being prepared for your review.",
  }[state];
}

function statusCopy(status: string): string {
  return ({
    created: "Ready to record", capturing: "Recording in progress", uploaded: "Recording uploaded",
    processing: "Transcribing your recording", speech_retryable: "Transcription needs recovery",
    speech_failed: "Transcription could not complete", translation_pending: "English translation pending",
    review_required: "Your translation review is needed", transcript_ready: "English transcript ready",
    quality_blocked: "Transcript needs attention", handed_off: "Transcript sent to Core",
  } as Record<string, string>)[status] ?? "Recording status unavailable";
}
function blockerCopy(code: string): string {
  return ({
    source_locale_unknown: "The spoken language could not be confirmed. This segment blocks note preparation.",
    source_overlap: "Overlapping speech needs attention before note preparation.",
    translation_missing: "Waiting for the English translation. Refresh to check progress.",
    translation_review_required: "An English translation is waiting for your review.",
    translation_retry_required: "The translation was rejected. A new translation attempt is required; it will not retry automatically.",
    translation_failed: "Translation could not complete. This recording is not ready for a note.",
  } as Record<string, string>)[code] ?? "This segment needs attention before note preparation.";
}
function speakerCopy(role: string): string {
  return ({ clinician: "Provider", patient: "Patient", other: "Other speaker" } as Record<string, string>)[role]
    ?? "Speaker not assigned";
}
function time(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function escape(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}
