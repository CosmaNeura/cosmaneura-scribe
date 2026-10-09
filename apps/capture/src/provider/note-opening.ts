import { parseCreatorReview, type CreatorReviewView } from "../../../review-ui/src/creator-review-api";
import { type CoreCaptureClient, requireValue } from "./core-client";
import { closed, parseDraft, parseNoteTemplates, reviewedSource, type CoreDraft, type CoreNoteTemplate } from "./core-notes";

export interface NoteOpening {
  readonly view: CreatorReviewView;
  readonly templates: CoreNoteTemplate[] | null;
  readonly draft: CoreDraft | null;
}

/** Parse one fresh coordinated response. Only an explicit size fallback returns null. */
export async function readNoteOpening(client: CoreCaptureClient, session: string): Promise<NoteOpening | null> {
  const value = await client.openNote(session);
  if (closed(value, "session_id,separate_reads_required")) {
    requireValue(value.session_id === session && value.separate_reads_required === true);
    return null;
  }
  requireValue(closed(value, "session_id,review,templates,note") && value.session_id === session);
  const view = parseCreatorReview(value.review, session);
  if (view.status !== "transcript_ready" || view.working?.note_ready !== true) {
    requireValue(value.templates === null && value.note === null);
    return { view, templates: null, draft: null };
  }
  const source = reviewedSource(view);
  const templates = parseNoteTemplates({ session_id: session, templates: value.templates }, session);
  const draft = templates.length === 1
    ? await parseDraft(value.note, session, templates[0]!.schema_ref, source) : null;
  requireValue(templates.length === 1 || value.note === null);
  requireValue(!client.signal.aborted);
  return { view, templates, draft };
}
