/* global document, window */
import { CreatorReviewError, parseCreatorReview } from "../src/creator-review-api.ts";
import { mountCreatorReview } from "../src/creator-review-panel.ts";

// Entirely synthetic HTTP/storage stand-ins; no media, credentials or external services.
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const source = [
  { source_segment_id: id(2), source_segment_version: 1, source_locale: "en-US", speaker_id: id(12), speaker_role: "unknown", content: "Synthetic clinician asks about fictional wrist soreness.", start_ms: 0, end_ms: 8000 },
  { source_segment_id: id(3), source_segment_version: 1, source_locale: "es-US", speaker_id: id(13), speaker_role: "unknown", content: "El paciente ficticio no tiene fiebre. Es una prueba de síntoma.", start_ms: 8000, end_ms: 15000 },
];
let view = { schema_version: "1.0", session_id: id(1), status: "transcript_ready", editing_allowed: true,
  source: { source_transcript_version: 1, segments: source },
  working: { source_transcript_version: 1, working_transcript_id: id(4), working_transcript_version: 1,
    note_ready: true, blockers: [], segments: source.map(row => ({ ...row,
      resolution: row.source_locale === "en-US" ? "english_source" : "spanish_translation",
      content: row.source_locale === "en-US" ? row.content : "The fictional patient has no fever. This is a symptom test." })) },
  review_queue: { schema_version: "1.0", session_id: id(1), source_transcript_version: 1, working_transcript_id: id(4), working_transcript_version: 1, status: "complete", items: [] },
};
let pending = null, lost = new URL(window.location.href).searchParams.has("lost");
const requests = [], receipts = new Map();
const api = {
  read: async () => parseCreatorReview(structuredClone(view), id(1)),
  decide: async () => { throw new Error("No translation decisions in this fixture."); },
  edit: async (request, key) => {
    requests.push(structuredClone({ request, key }));
    if (!receipts.has(key)) {
      if (request.expected_working_transcript_version !== view.working.working_transcript_version) throw new CreatorReviewError("conflict");
      const version = view.working.working_transcript_version + 1;
      const edit = { edit_id: id(100 + version), working_transcript_version: version, created_at: "2026-09-30T12:00:00Z", request: structuredClone(request) };
      view = { ...view, review_edits: [...(view.review_edits ?? []), edit],
        working: { ...view.working, working_transcript_version: version, segments: view.working.segments.map(row => ({ ...row,
          content: request.corrections.find(item => item.source_segment_id === row.source_segment_id)?.content ?? row.content,
          speaker_role: request.speakers.find(item => item.speaker_id === row.speaker_id)?.role ?? row.speaker_role })) },
        review_queue: { ...view.review_queue, working_transcript_version: version } };
      receipts.set(key, { schema_version: "1.0", session_id: id(1), edit_id: edit.edit_id, working_transcript_id: id(4), working_transcript_version: version, saved: true });
    }
    if (lost) { lost = false; throw new CreatorReviewError("unavailable"); }
    return receipts.get(key);
  },
};
mountCreatorReview(document.querySelector("#review"), api, { editJournal: {
  load: async () => structuredClone(pending),
  save: async operation => {
    if (pending && JSON.stringify(pending) !== JSON.stringify(operation)) throw new Error("Different operation.");
    pending = structuredClone(operation);
  }, clear: async key => { if (pending?.key !== key) throw new Error("Wrong operation."); pending = null; },
} });
window.creatorEditLab = { requests, get view() { return view; }, get pending() { return pending; } };
