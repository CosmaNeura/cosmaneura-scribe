/* global document, window */
import { parseCreatorReview } from "../../../review-ui/src/creator-review-api.ts";
import { renderCreatorReview } from "../../../review-ui/src/creator-review-panel.ts";

const session = crypto.randomUUID(), working = crypto.randomUUID();
const speakers = [crypto.randomUUID(), crypto.randomUUID()];
const contents = [
  "This is an invented visit for testing how a transcript reads. There is no real patient. ".repeat(7),
  "The fictional person describes mild wrist soreness after gardening. No medication was discussed. ".repeat(8),
  "The fictional clinician repeats the history to confirm it. This text is only a layout fixture. ".repeat(6),
];
const segments = contents.map((content, index) => ({ source_segment_id: crypto.randomUUID(),
  source_segment_version: 1, speaker_id: speakers[index % 2], speaker_role: "unknown", source_locale: "en-US",
  content, start_ms: index * 30000, end_ms: index * 30000 + 29000 }));
const view = parseCreatorReview({ schema_version: "1.0", session_id: session, status: "transcript_ready",
  source: { source_transcript_version: 1, segments },
  working: { source_transcript_version: 1, working_transcript_id: working, working_transcript_version: 1,
    note_ready: true, blockers: [], segments: segments.map(item => ({ source_segment_id: item.source_segment_id,
      source_segment_version: 1, resolution: "english_source", content: item.content })) },
  review_queue: { schema_version: "1.0", session_id: session, source_transcript_version: 1,
    working_transcript_id: working, working_transcript_version: 1, status: "complete", items: [] },
}, session);
document.querySelector("#review").innerHTML = renderCreatorReview({ phase: "ready", view, notice: "" });
window.transcriptReadingLab = { contents };
