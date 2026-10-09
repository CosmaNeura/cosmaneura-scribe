/* global document, window */
import { mountCreatorReview } from "../../../review-ui/src/creator-review-panel.ts";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const view = { schema_version: "1.0", session_id: id(1), status: "transcript_ready", editing_allowed: true,
  source: { source_transcript_version: 1, segments: [{ source_segment_id: id(2), source_segment_version: 1,
    speaker_id: id(4), speaker_role: "unknown", source_locale: "en-US", content: "Synthetic speech, no real patient.", start_ms: 0, end_ms: 1000 }] },
  working: { source_transcript_version: 1, working_transcript_id: id(3), working_transcript_version: 1,
    note_ready: true, blockers: [], segments: [{ source_segment_id: id(2), source_segment_version: 1,
      speaker_role: "unknown", resolution: "english_source", content: "Synthetic speech, no real patient." }] },
  review_queue: { schema_version: "1.0", session_id: id(1), source_transcript_version: 1,
    working_transcript_id: id(3), working_transcript_version: 1, status: "complete", items: [] }, review_edits: [] };
const lab = { writes: [], saves: [], provider: "Fictional provider " + "é".repeat(100), patient: "Fictional Lucía Rivera" };
const dispose = mountCreatorReview(document.querySelector("#review"), {
  read: async () => structuredClone(view), decide: async () => { throw new Error("No review decisions in this fixture"); },
  edit: async request => { lab.writes.push(structuredClone(request)); return { working_transcript_version: 2 }; },
}, { speakerNameSuggestions: { patient: lab.patient, clinician: lab.provider },
  editJournal: { load: async () => null, save: async value => lab.saves.push(value), clear: async () => undefined } });
window.speakerNamesLab = { ...lab, dispose };
