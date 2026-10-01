import type { CreatorReviewView } from "./creator-review-api";
import { currentSpeakerConfirmations, parseCreatorEditRequest, speakerNameSuggestion, type CreatorEditRequest } from "./creator-edit";

export interface SpeakerNameSuggestions {
  readonly patient?: string | undefined;
  readonly clinician?: string | undefined;
}

export function escapeReviewText(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
export function renderCreatorEditDialog(view: CreatorReviewView, segmentId: string, suggestions: SpeakerNameSuggestions = {}): string {
  const source = view.source?.segments.find(item => item.source_segment_id === segmentId);
  const working = view.working?.segments.find(item => item.source_segment_id === segmentId);
  if (!source || !working || !view.working) return "";
  const translationNeedsHelp = view.working.blockers.some(item => item.source_segment_id === segmentId
    && ["translation_retry_required", "translation_failed"].includes(item.code))
    && !(view.translation_progress ?? []).some(item => item.source_segment_id === segmentId);
  const confirmed = currentSpeakerConfirmations(view.review_edits ?? []).get(source.speaker_id);
  const role = confirmed?.detail === "interpreter" ? "interpreter" : confirmed?.role ?? "unknown";
  const name = confirmed?.display_name ?? "";
  return `<dialog class="creator-edit-dialog" data-creator-edit-dialog aria-labelledby="creator-edit-title">
    <h2 id="creator-edit-title">Correct this passage</h2>
    <p>Save a new transcript version. The original wording and previous corrections stay available.</p>
    <form data-creator-edit-form data-segment="${escapeReviewText(segmentId)}">
      <div class="creator-edit-fields">
      <details><summary>${source.source_locale === "es-US" ? "Spanish original" : "Original wording"}</summary>
        <p lang="${source.source_locale === "es-US" ? "es" : "en"}">${escapeReviewText(source.content)}</p></details>
      ${working.content != null ? `<label>English wording<textarea name="content" rows="6" maxlength="100000">${escapeReviewText(working.content)}</textarea></label>`
        : translationNeedsHelp
          ? `<p>English wording is unavailable for this passage. Your original ${source.source_locale === "es-US" ? "Spanish " : ""}transcript is retained. Keep this visit and contact your practice administrator for help.</p>`
          : `<p>Finish translation review before correcting the English wording.</p>`}
      <fieldset><legend>Confirm who is speaking</legend>
      <p>This applies to every passage with this detected voice. Choose “Not sure” if the voice cannot be identified.</p>
      <div class="creator-speaker-suggestions">${([ ["clinician", "Provider"], ["patient", "Patient"] ] as const).map(([value, label]) => {
        const suggested = speakerNameSuggestion(suggestions[value]);
        return suggested === undefined ? "" : `<button type="button" data-review-action="use-speaker-name" data-speaker-role="${value}">This is the ${label.toLowerCase()}: ${escapeReviewText(suggested)}</button>`;
      }).join("")}</div>
      <label>Speaker<select name="role">${[["unknown", "Not sure"], ["clinician", "Provider"], ["patient", "Patient"], ["interpreter", "Interpreter"], ["other", "Other speaker"]]
        .map(([value, label]) => `<option value="${value}" ${role === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <label>Name (optional)<input name="display_name" maxlength="120" autocomplete="off" value="${escapeReviewText(name)}" ${role === "unknown" ? "disabled" : ""}></label>
      <small>Enter a name only after confirming whose voice this is.</small></fieldset>
      <p role="alert" data-edit-validation></p>
      </div>
      <div class="creator-edit-actions"><button type="button" data-review-action="cancel-edit">Cancel</button>
      <button type="button" data-review-action="save-edit">Save correction</button></div>
    </form></dialog>`;
}

export function creatorEditFromForm(view: CreatorReviewView, form: HTMLFormElement): CreatorEditRequest {
  const source = view.source?.segments.find(item => item.source_segment_id === form.dataset.segment);
  const working = view.working?.segments.find(item => item.source_segment_id === form.dataset.segment);
  if (!source || !working || !view.source || !view.working) throw new Error("Transcript changed. Reopen this correction.");
  const fields = new FormData(form);
  const content = fields.get("content"), selected = fields.get("role"), enteredName = fields.get("display_name");
  const selectedRole = typeof selected === "string" ? selected : "unknown";
  const role = selectedRole === "interpreter" ? "other" : selectedRole;
  const displayName = selectedRole === "unknown" ? null : (typeof enteredName === "string" ? enteredName.trim() : "") || null;
  const detail = selectedRole === "interpreter" ? "interpreter" : selectedRole === "other" ? "other" : null;
  const previous = currentSpeakerConfirmations(view.review_edits ?? []).get(source.speaker_id);
  const speakerChanged = previous ? role !== previous.role || displayName !== previous.display_name || detail !== previous.detail
    : role !== "unknown";
  const corrections = typeof content === "string" && working.content != null && content !== working.content
    ? [{ source_segment_id: source.source_segment_id, expected_source_segment_version: source.source_segment_version, content }] : [];
  if (!speakerChanged && corrections.length === 0) throw new Error("Make a wording or speaker change before saving.");
  return parseCreatorEditRequest({ schema_version: "1.0", expected_source_transcript_version: view.source.source_transcript_version,
    expected_working_transcript_id: view.working.working_transcript_id, expected_working_transcript_version: view.working.working_transcript_version,
    corrections, speakers: speakerChanged ? [{ speaker_id: source.speaker_id, role, display_name: displayName, detail }] : [] });
}
