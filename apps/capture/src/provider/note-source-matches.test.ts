import { webcrypto } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { parseCreatorReview } from "../../../review-ui/src/creator-review-api";
import { parseDraft, reviewedSource, sha256 } from "./core-notes";
import { noteSourceMatches } from "./note-source-matches";

const session = "10000000-0000-4000-8000-000000000001", working = "20000000-0000-4000-8000-000000000002";
const suffix = "01j" + "0".repeat(23), schema = "doctor_note_schema_" + suffix;
const utterance = "If soreness persists, return. No treatment was agreed today.";
const block = (text: string, role = "Clinician") => `Transcript — ${role}:\n${text}`;
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });
async function fixture(texts = [utterance], field = texts[0]!, roles = texts.map(() => "clinician")) {
  const segments = texts.map((content, index) => ({ source_segment_id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    source_segment_version: 1, speaker_id: working, content, source_locale: "en-US", speaker_role: roles[index],
    start_ms: index * 10_000, end_ms: index * 10_000 + 5000 }));
  const view = parseCreatorReview({ schema_version: "1.0", session_id: session, status: "transcript_ready",
    source: { source_transcript_version: 1, segments },
    working: { source_transcript_version: 1, working_transcript_id: working, working_transcript_version: 1,
      note_ready: true, blockers: [], segments: segments.map(segment => ({ ...segment, resolution: "english_source" })) },
    review_queue: { schema_version: "1.0", session_id: session, source_transcript_version: 1,
      working_transcript_id: working, working_transcript_version: 1, status: "complete", items: [] } }, session);
  const draft = await parseDraft({ session_id: session, scribe_source_id: working, source_sha256: "a".repeat(64), schema_ref: schema,
    transcript_ref: "ai_visit_transcript_" + suffix, note_ref: "visit_note_" + suffix, status: "draft", note_type: "Synthetic SOAP",
    fields: { Plan: field }, field_order: ["Plan"], note_sha256: await sha256(JSON.stringify([["Plan", field]])),
    created_at: "2026-09-30T12:00:00Z", review_required: true, reviewed_source: reviewedSource(view) }, session, schema, reviewedSource(view));
  return { draft, view, matches: () => noteSourceMatches(draft, view).get("Plan") ?? [] };
}

it.each([utterance, block(utterance)])("links the complete unchanged turn, including its condition and negation (%#)", async text => {
  const f = await fixture([utterance], text);
  expect(f.matches()).toEqual([{ source_segment_id: f.view.source!.segments[0]!.source_segment_id, source_segment_version: 1,
    source_transcript_version: 1, working_transcript_id: working, working_transcript_version: 1, startMs: 0 }]);
});
it("reconstructs complete multiline blocks uniquely and displays their timestamps in transcript order", async () => {
  const texts = ["An invented question.\n\nWith a second paragraph.", utterance];
  const f = await fixture(texts, [block(texts[1]!), block(texts[0]!)].join("\n\n"));
  expect(f.matches().map(match => match.startMs)).toEqual([0, 10_000]);
});
it.each([["patient", "Patient"], ["other", "Other speaker"], ["unknown", "Unidentified speaker"]])(
  "recognizes only Core's fixed %s attribution", async (role, label) => {
    expect((await fixture([utterance], block(utterance, label), [role])).matches()).toHaveLength(1);
  });
it("uses accepted translated/corrected working content, never the original Spanish or replaced English", async () => {
  const f = await fixture([utterance], block(utterance));
  f.view.source!.segments[0]!.content = "Consulta sintética. No se acordó un tratamiento.";
  f.view.source!.segments[0]!.source_locale = "es-US";
  f.view.working!.segments[0]!.source_locale = "es-US";
  f.view.working!.segments[0]!.resolution = "spanish_translation";
  expect(f.matches()).toHaveLength(1);
  f.draft.fields!.Plan = f.view.source!.segments[0]!.content;
  expect(f.matches()).toHaveLength(0);
  f.draft.fields!.Plan = "An earlier English draft.";
  expect(f.matches()).toHaveLength(0);
});
it.each([utterance.toLowerCase(), utterance + " ", " " + utterance, utterance.replace(". ", ".\n"),
  "If soreness persists, return.", "The patient should return if needed.", `Summary: ${utterance}`, block(utterance) + "\n",
  block(utterance, "Doctor"), block(utterance) + "\n\nAn added clinician sentence."])(
  "omits altered, partial, paraphrased or mixed fields (%#)", async text => {
    expect((await fixture([utterance], text)).matches()).toHaveLength(0);
  });
it("does not normalize Unicode", async () => {
  expect((await fixture(["Synthetic café."], "Synthetic cafe\u0301.")).matches()).toHaveLength(0);
});
it.each(["Not mentioned in transcript", "Clinician's saved scratch notes:\n" + utterance,
  block(utterance) + "\n\nClinician's saved scratch notes:\nInvented scratch."])(
  "excludes placeholders and scratch blocks even if a turn contains identical text (%#)", async text => {
    expect((await fixture([text], text)).matches()).toHaveLength(0);
  });
it.each([["clinician", "clinician"], ["clinician", "patient"]])("never chooses between duplicate complete turns (%#)", async (...roles) => {
  for (const text of [utterance, block(utterance)]) expect((await fixture([utterance, utterance], text, roles)).matches()).toHaveLength(0);
});
it("does not choose a long block when a shorter decomposition is also valid", async () => {
  const one = "Invented first turn.", two = "Invented second turn.", long = one + "\n\n" + block(two);
  expect((await fixture([one, two, long], block(long))).matches()).toHaveLength(0);
  // Duplicated shorter turns still make the decomposition ambiguous.
  expect((await fixture([one, one, two, long], block(long))).matches()).toHaveLength(0);
});
it("omits raw text that can also be interpreted as another turn's quoted block", async () => {
  expect((await fixture([utterance, block(utterance)], block(utterance))).matches()).toHaveLength(0);
});
it("omits a repeated turn and fails closed for excessive decomposition depth", async () => {
  expect((await fixture([utterance], block(utterance) + "\n\n" + block(utterance))).matches()).toHaveLength(0);
  const turns = Array.from({ length: 103 }, (_, i) => `Invented distinct turn ${i}.`);
  expect((await fixture(turns, turns.map(text => block(text)).join("\n\n"))).matches()).toHaveLength(0);
});
it("bounds comparison work for pathological optional matching", async () => {
  const turns = Array.from({ length: 1100 }, (_, i) => `Invented turn ${i}.`);
  const f = await fixture(turns, turns.slice(0, 95).map(text => block(text)).join("\n\n"));
  expect(f.matches()).toHaveLength(0);
});
it("bounds character work when long complete turns share their opening", async () => {
  const prefix = "Invented common opening. ".repeat(300);
  const turns = Array.from({ length: 100 }, (_, i) => `${prefix}Distinct ending ${i}.`);
  // The matching turn exists, but reaching it would exceed the shared budget.
  expect((await fixture(turns, block(turns.at(-1)!))).matches()).toHaveLength(0);
});
it.each(["session", "draft-state", "working-id", "working-version", "source-version", "working-source", "segment-version",
  "foreign-segment", "duplicate-source-id", "duplicate-working-id", "unready", "processing", "missing-view", "negative-time", "unresolved",
  "null-content", "continuity"])("omits unsafe or stale %s", async fault => {
    const f = await fixture();
    if (fault === "session") f.draft.session_id = working;
    if (fault === "draft-state") f.draft.status = "not_prepared";
    if (fault === "working-id") f.draft.scribe_source_id = session;
    if (fault === "working-version") f.view.working!.working_transcript_version++;
    if (fault === "source-version") f.view.source!.source_transcript_version++;
    if (fault === "working-source") f.view.working!.source_transcript_version++;
    if (fault === "segment-version") f.view.working!.segments[0]!.source_segment_version++;
    if (fault === "foreign-segment") f.view.working!.segments[0]!.source_segment_id = working;
    if (fault === "duplicate-source-id") f.view.source!.segments.push(f.view.source!.segments[0]!);
    if (fault === "duplicate-working-id") f.view.working!.segments.push(f.view.working!.segments[0]!);
    if (fault === "unready") f.view.working = { ...f.view.working!, note_ready: false };
    if (fault === "processing") f.view.status = "processing";
    if (fault === "missing-view") f.view.source = null;
    if (fault === "negative-time") f.view.source!.segments[0]!.start_ms = -1;
    if (fault === "unresolved") f.view.working!.segments[0]!.resolution = "unresolved";
    if (fault === "null-content") f.view.working!.segments[0]!.content = null;
    if (fault === "continuity") f.draft.reviewed_source = { ...f.draft.reviewed_source, capture_continuity: {
      schema_version: "1.0", continuity: "interrupted_or_unconfirmed", missing_audio: "unknown",
      starts: [{ source_start_id: session, first_sequence_number: 0 }, { source_start_id: working, first_sequence_number: 1 }] } };
    expect(f.matches()).toHaveLength(0);
  });
