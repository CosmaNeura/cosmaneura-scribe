import { describe, expect, it, vi } from "vitest";
import { HttpCreatorReviewApi, parseCreatorReview } from "./creator-review-api";
import { parseCreatorEditRequest, parsePendingCreatorEdit } from "./creator-edit";
import { renderTranscriptEvidenceLinks, transcriptSearchText } from "./transcript-tools";
import { renderCreatorReview } from "./creator-review-panel";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const body = { schema_version: "1.0" as const, expected_source_transcript_version: 1,
  expected_working_transcript_id: id(3), expected_working_transcript_version: 1,
  corrections: [{ source_segment_id: id(2), expected_source_segment_version: 1, content: "Corrected synthetic wording." }],
  speakers: [{ speaker_id: id(4), role: "clinician" as const, display_name: "Fictional Dr. Avery", detail: null }] };
const fixture = (): unknown => ({ schema_version: "1.0", session_id: id(1), status: "transcript_ready", editing_allowed: true,
  source: { source_transcript_version: 1, segments: [{ source_segment_id: id(2), source_segment_version: 1, speaker_id: id(4),
    speaker_role: "unknown", source_locale: "en-US", content: "Original synthetic wording.", start_ms: 0, end_ms: 2000 }] },
  working: { source_transcript_version: 1, working_transcript_id: id(3), working_transcript_version: 2,
    note_ready: true, blockers: [], segments: [{ source_segment_id: id(2), source_segment_version: 1, speaker_role: "clinician",
      resolution: "english_source", content: body.corrections[0]!.content }] },
  review_queue: { schema_version: "1.0", session_id: id(1), source_transcript_version: 1,
    working_transcript_id: id(3), working_transcript_version: 2, status: "complete", items: [] },
  review_edits: [{ edit_id: id(5), working_transcript_version: 2, created_at: "2026-09-30T12:00:00Z", request: body }],
});

describe("explicit creator corrections", () => {
  it("keeps the exact protected request for encrypted recovery and rejects authority extras", () => {
    const pending = parsePendingCreatorEdit({ key: "transcript-edit-fixture", request: body });
    expect(pending.request).toEqual(body);
    expect(pending.request).not.toBe(body);
    for (const invalid of [{ ...body, actor: "untrusted" }, { ...body, expected_source_transcript_version: true },
      { ...body, corrections: [body.corrections[0], body.corrections[0]] }]) expect(() => parseCreatorEditRequest(invalid)).toThrow();
  });
  it("requires explicit canonical roles and leaves unknown speakers unnamed", () => {
    for (const speaker of [{ ...body.speakers[0], role: "unknown" }, { ...body.speakers[0], detail: "interpreter" },
      { ...body.speakers[0], role: "doctor" }, { ...body.speakers[0], display_name: "\u0000" }]) {
      expect(() => parseCreatorEditRequest({ ...body, speakers: [speaker] })).toThrow();
    }
    expect(parseCreatorEditRequest({ ...body, speakers: [{ ...body.speakers[0], role: "other", detail: "interpreter" }] })
      .speakers?.[0]?.role).toBe("other");
  });
  it("rejects oversized UTF8 edits without truncation", () => {
    const content = "界".repeat(100000);
    expect(() => parseCreatorEditRequest({ ...body, corrections: [1, 2, 3, 4].map(value => ({
      ...body.corrections[0], source_segment_id: id(20 + value), content,
    })) })).toThrow("too large");
  });
  it("rejects NUL and unpaired surrogates while preserving valid Unicode", () => {
    for (const content of ["bad\u0000text", "bad\ud800text", "bad\udffftext"]) {
      expect(() => parseCreatorEditRequest({ ...body, corrections: [{ ...body.corrections[0], content }] })).toThrow();
    }
    expect(parseCreatorEditRequest({ ...body, corrections: [{ ...body.corrections[0], content: "Síntoma 🩺" }] })
      .corrections?.[0]?.content).toBe("Síntoma 🩺");
  });
  it("binds saved history to source, working version and actual current content", () => {
    const view = parseCreatorReview(fixture(), id(1));
    for (const change of [{ expected_source_transcript_version: 2 }, { expected_working_transcript_id: id(9) }]) {
      expect(() => parseCreatorReview({ ...view, review_edits: [{ ...view.review_edits?.[0], request: { ...body, ...change } }] }, id(1))).toThrow();
    }
    expect(() => parseCreatorReview({ ...view, working: { ...view.working, segments: [{ ...view.working?.segments[0], content: "Unrelated." }] } }, id(1))).toThrow();
    expect(() => parseCreatorReview({ ...view, working: { ...view.working, segments: [{ ...view.working?.segments[0], speaker_role: "patient" }] } }, id(1))).toThrow();
  });
  it("renders current wording and confirmed names while retaining original and history", () => {
    const html = renderCreatorReview({ phase: "ready", view: parseCreatorReview(fixture(), id(1)), notice: "", editable: true });
    expect(html).toContain("Provider · Fictional Dr. Avery · confirmed");
    expect(html).toContain("Corrected synthetic wording.");
    expect(html).toContain("Original synthetic wording.");
    expect(html).toContain("Correction history");
    expect(html).not.toContain("Review is complete");
    expect(html).toContain("Needs accuracy review");
  });
  it("uses the supplied transport and validates exact resulting version on an edit receipt", async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ schema_version: "1.0", session_id: id(1), edit_id: id(5),
      working_transcript_id: id(3), working_transcript_version: 2, saved: true }), { headers: { "content-type": "application/json" } }));
    const api = new HttpCreatorReviewApi(id(1), transport);
    await api.edit(body, "transcript-edit-fixture");
    expect(transport).toHaveBeenCalledWith(`/v1/captured-sessions/${id(1)}/review/edit`, { method: "POST", body, key: "transcript-edit-fixture" });
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ schema_version: "1.0", session_id: id(1), edit_id: id(5),
      working_transcript_id: id(3), working_transcript_version: 3, saved: true }), { headers: { "content-type": "application/json" } }));
    await expect(api.edit(body, "transcript-edit-fixture")).rejects.toThrow();
  });
  it("finds Spanish accent variants without altering the original transcript", () => {
    expect(transcriptSearchText("  Síntoma\nFICTICIO ")).toBe("sintoma ficticio");
  });
  it("only links supplied evidence at the current exact source and working version", () => {
    const view = parseCreatorReview(fixture(), id(1));
    const reference = { working_transcript_id: id(3), working_transcript_version: 2,
      source_transcript_version: 1, source_segment_id: id(2), source_segment_version: 1 };
    expect(renderTranscriptEvidenceLinks(view, [reference])).toContain("Transcript 0:00");
    expect(renderTranscriptEvidenceLinks(view, [])).toBe("");
    for (const change of [{ working_transcript_version: 1 }, { source_segment_id: id(99) }, { source_segment_version: 2 }]) {
      expect(renderTranscriptEvidenceLinks(view, [{ ...reference, ...change }])).toBe("");
    }
  });
});
