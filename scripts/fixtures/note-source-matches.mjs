// Invented, already uploaded/consented fixture. No recording or service is used.
export async function sourceMatchFixture() {
  const session = "10000000-0000-4000-8000-000000000001", working = "20000000-0000-4000-8000-000000000002";
  const suffix = "01j" + "0".repeat(23), schema = "doctor_note_schema_" + suffix;
  const scope = { workspaceId: working, appointmentRef: "appointment_" + suffix, bindingRef: "scribe_capture_binding_" + suffix };
  const encounter = { appointmentRef: scope.appointmentRef, title: "Synthetic source matching visit", detail: "Invented fixture; no real patient" };
  const segments = Array.from({ length: 24 }, (_, index) => ({
    source_segment_id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, source_segment_version: 1,
    speaker_id: `40000000-0000-4000-8000-${String(index % 2 + 1).padStart(12, "0")}`,
    content: index === 0 ? "Fictional wrist soreness began after gardening. No injury was reported."
      : index === 23 ? "If soreness persists, return. No treatment was agreed today."
      : `Invented complete conversation turn ${index}. The participants discussed a synthetic example with no real patient.`,
    source_locale: "en-US", speaker_role: index % 2 ? "clinician" : "patient", start_ms: index * 10_000, end_ms: index * 10_000 + 5000,
  }));
  const review = { schema_version: "1.0", session_id: session, status: "transcript_ready",
    source: { source_transcript_version: 1, segments },
    working: { source_transcript_version: 1, working_transcript_id: working, working_transcript_version: 1,
      note_ready: true, blockers: [], segments: segments.map(segment => ({ ...segment, resolution: "english_source" })) },
    review_queue: { schema_version: "1.0", session_id: session, source_transcript_version: 1,
      working_transcript_id: working, working_transcript_version: 1, status: "complete", items: [] } };
  const fields = { Subjective: segments[0].content, Assessment: "An invented note summary without an exact quoted source.",
    Plan: `Transcript — Clinician:\n${segments[23].content}` };
  const template = { schema_ref: schema, note_type: "Synthetic SOAP", field_names: Object.keys(fields) };
  const digest = async fields => [...new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(Object.entries(fields)))))].map(n => n.toString(16).padStart(2, "0")).join("");
  const note = { session_id: session, scribe_source_id: working, source_sha256: "a".repeat(64), schema_ref: schema,
    transcript_ref: "ai_visit_transcript_" + suffix, note_ref: "visit_note_" + suffix, status: "draft", note_type: "Synthetic SOAP",
    fields, field_order: Object.keys(fields), note_sha256: await digest(fields), created_at: "2026-09-30T12:00:00Z", review_required: true,
    reviewed_source: { kind: "reviewed_english", source_version: 1, working_transcript_id: working, working_version: 1 } };
  return { session, working, scope, encounter, template, review, note, digest };
}
