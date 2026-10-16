import type { CoreDraft } from "./core-notes";
import { noteFieldLabel } from "./workspace-display";
import { escapeText } from "./visit-list-view";

export function noteView(draft: CoreDraft, patient: string, conversation: string): string {
  const field = (key: string, index: number): string => `<label>${escapeText(noteFieldLabel(key))}<textarea data-note-field name="note-${index}" rows="2">${escapeText(draft.fields?.[key] ?? "")}</textarea></label>`;
  return `<section class="provider-note" data-note-view="note" data-conversation="hidden">
    <div class="provider-note-heading"><h1>${escapeText(patient)}</h1><p class="provider-draft-status">Visit note · <span data-note-save-state role="status" aria-atomic="true">Saved</span></p>
    <button class="provider-text-link" data-workspace-action="transcript-view" aria-expanded="false">Show the conversation</button></div>
    ${draft.reviewed_source.capture_continuity ? '<p class="provider-warning" role="status">Some speech may be missing. Check this note against the conversation.</p>' : ''}
    <scribe-private-note mode="note"></scribe-private-note><div class="provider-note-grid"><div class="provider-note-editor" tabindex="0" role="region" aria-label="Draft note">${draft.field_order?.map(field).join("") ?? ''}
      <div class="provider-save-bar"><button class="provider-primary" data-workspace-action="finish-note">Save and review</button><p>Check it against the conversation first. You’ll review and sign it in the CosmaNeura dashboard.</p></div>
      <details class="provider-note-guidance"><summary>Details</summary><p>${escapeText(draft.note_type)} · Saving keeps your edits. Clinical review is still required.</p></details>
    </div><aside class="provider-note-evidence" hidden><h2>The conversation</h2><div class="provider-note-source-toolbar"></div><div data-note-transcript-scroll tabindex="0" role="region" aria-label="Recording transcript">${conversation}</div></aside></div>
    <p class="provider-support">Still stuck? Email <a href="mailto:dev@cosmaneura.com">dev@cosmaneura.com</a></p></section>`;
}
