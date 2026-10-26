import type { CoreDraft } from "./core-notes";
import { noteFieldLabel } from "./workspace-display";
import { escapeText } from "./visit-list-view";
import { noteEditorPosition, restoreNoteEditorPosition, type NoteEditorPosition } from "./note-editor-state";

export function draftSaveState(state: { pending: boolean; dirty: boolean; unconfirmed: boolean; savedAt: Date | null }): string {
  if (state.unconfirmed) return state.pending ? "Draft save not confirmed" : "Draft not saved";
  if (state.pending || state.dirty) return "Draft saving…";
  return state.savedAt ? `Draft saved at ${state.savedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Draft saved";
}

/** Switches the view without replacing either editor or persisting its editing position. */
export function noteConversationView(note: HTMLElement, shown: boolean, lastField: HTMLTextAreaElement | null,
  position: NoteEditorPosition | null, rememberPosition = true): NoteEditorPosition | null {
  const wasShown = note.dataset.conversation === "shown";
  if (shown && !wasShown && rememberPosition) position = noteEditorPosition(note, lastField);
  note.dataset.noteView = shown ? "transcript" : "note";
  note.dataset.conversation = shown ? "shown" : "hidden";
  const evidence = note.querySelector<HTMLElement>(".provider-note-evidence");
  if (evidence) evidence.hidden = !shown;
  const toggle = note.querySelector<HTMLButtonElement>('[data-workspace-action="transcript-view"]');
  if (toggle) { toggle.textContent = shown ? "Hide the conversation" : "Show the conversation"; toggle.setAttribute("aria-expanded", String(shown)); }
  if (shown) {
    const details = evidence?.querySelector<HTMLDetailsElement>("details");
    if (details) details.open = true;
    if (window.matchMedia("(min-width: 900px)").matches) {
      evidence?.querySelector<HTMLElement>("input, summary")?.focus({ preventScroll: true });
    } else {
      note.scrollIntoView({ block: "start" });
      evidence?.querySelector<HTMLElement>("[data-note-back]")?.focus({ preventScroll: true });
    }
  } else if (wasShown) {
    restoreNoteEditorPosition(position);
    if (!position?.field?.isConnected) toggle?.focus({ preventScroll: true });
    position = null;
  }
  return position;
}

export function noteView(draft: CoreDraft, patient: string, conversation: string): string {
  const field = (key: string, index: number): string => `<label>${escapeText(noteFieldLabel(key))}<textarea data-note-field name="note-${index}" rows="2">${escapeText(draft.fields?.[key] ?? "")}</textarea></label>`;
  return `<section class="provider-note" data-note-view="note" data-conversation="hidden">
    <div class="provider-save-bar provider-note-actions"><button class="provider-primary" data-workspace-action="finish-note">Save and review</button><p class="provider-draft-status"><span data-note-save-state role="status" aria-atomic="true">Draft saved</span></p></div>
    <div class="provider-note-heading"><h1>${escapeText(patient)}</h1>
    <button class="provider-text-link" data-workspace-action="transcript-view" aria-expanded="false">Show the conversation</button></div>
    <p class="provider-note-review-help">Check it against the conversation first. Then review it in the CosmaNeura dashboard.</p>
    ${draft.reviewed_source.capture_continuity ? '<p class="provider-warning" role="status">Some speech may be missing. Check this note against the conversation.</p>' : ''}
    <scribe-private-note mode="note"></scribe-private-note><div class="provider-note-grid"><div class="provider-note-editor" tabindex="0" role="region" aria-label="Draft note">${draft.field_order?.map(field).join("") ?? ''}
      <details class="provider-note-guidance"><summary>Details</summary><p>${escapeText(draft.note_type)} · Saving keeps your edits. Clinical review is still required.</p></details>
    </div><aside class="provider-note-evidence" hidden><button class="provider-text-link provider-note-mobile-back" data-note-back data-workspace-action="note-view">Back to note</button><p class="provider-note-mobile-context">${escapeText(patient)}</p><h2>Conversation</h2><div class="provider-note-source-toolbar"></div><div data-note-transcript-scroll tabindex="0" role="region" aria-label="Recording transcript">${conversation}</div></aside></div>
    <p class="provider-support">Still stuck? Email <a href="mailto:dev@cosmaneura.com">dev@cosmaneura.com</a></p></section>`;
}
