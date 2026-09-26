import { describe, expect, it, vi } from "vitest";
import { HttpCreatorReviewApi, parseCreatorReview, parseCaptureContinuity } from "./creator-review-api";
import { renderCreatorReview, renderNoteTranscript } from "./creator-review-panel";
import { longReviewFixture } from "./long-review.fixture";
import { MAX_CREATOR_REVIEW_BYTES } from "./capture-response-limits";

const session = "00000000-0000-4000-8000-000000000001";
const segment = "00000000-0000-4000-8000-000000000002";
const working = "00000000-0000-4000-8000-000000000003";
const translation = "00000000-0000-4000-8000-000000000004";
const view = {
  schema_version: "1.0", session_id: session, status: "review_required",
  source: { source_transcript_version: 1, segments: [{
    source_segment_id: segment, source_segment_version: 1, source_locale: "es-US",
    speaker_role: "unknown", start_ms: 0, end_ms: 900, content: "No tengo fiebre. <script>bad</script>",
  }] },
  working: {
    source_transcript_version: 1, working_transcript_id: working, working_transcript_version: 2,
    note_ready: false, segments: [{ source_segment_id: segment, source_segment_version: 1,
      resolution: "unresolved", content: null }],
    blockers: [{ source_segment_id: segment, code: "translation_review_required" }],
  },
  review_queue: {
    schema_version: "1.0", session_id: session, source_transcript_version: 1,
    working_transcript_id: working, working_transcript_version: 2, status: "review_required",
    items: [{ source_segment_id: segment, source_segment_version: 1,
      translation_id: translation, translation_version: 1, source_locale: "es-US", target_locale: "en-US",
      source_content: "No tengo fiebre. <script>bad</script>", translated_content: "I do not have a fever." }],
  },
};

describe("creator review surface", () => {
  it("receives every segment of a bounded maximum-length review", async () => {
    const source = longReviewFixture(session), json = JSON.stringify(source);
    expect(new TextEncoder().encode(json).length).toBeGreaterThan(8 * 1024 * 1024);
    expect(new TextEncoder().encode(json).length).toBeLessThan(MAX_CREATOR_REVIEW_BYTES);
    const api = new HttpCreatorReviewApi(session, async () => new Response(json, {
      headers: { "content-type": "application/json" },
    }));
    const result = await api.read();
    expect(result.source?.segments).toEqual(source.source.segments);
    expect(result.review_queue?.items).toEqual(source.review_queue.items);
    expect(result.working?.note_ready).toBe(false);
  });
  it("compares an accepted source without decision controls or interpreting source markup", () => {
    const ready = parseCreatorReview({ ...view, status: "transcript_ready",
      working: { ...view.working, note_ready: true, blockers: [], segments: [{
        ...view.working.segments[0], resolution: "spanish_translation", content: "I do not have a fever.",
      }] },
      review_queue: { ...view.review_queue, status: "complete", items: [] },
    }, session);
    const html = renderNoteTranscript(ready);
    expect(html).toContain("Compare with recording transcript");
    expect(html).toContain("Spanish · original");
    expect(html).toContain("English · accepted translation");
    expect(html).toContain("I do not have a fever.");
    expect(html).toContain("Speaker not assigned");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("data-review-action");
    expect(renderNoteTranscript(parseCreatorReview(view, session))).toBe("");
  });

  it("distinguishes queued, uncertain and saved translation progress without offering a new call", () => {
    for (const [state, copy] of [
      ["queued", "Waiting for this translation to start"],
      ["unconfirmed", "Translation result unconfirmed"],
      ["result_saved", "Preparing translation review"],
    ]) {
      const pending = { ...view, status: "translation_pending",
        review_queue: { ...view.review_queue, status: "not_ready", items: [] },
        translation_progress: [{ source_segment_id: segment, source_segment_version: 1, state }],
      };
      const parsed = parseCreatorReview(pending, session);
      const html = renderCreatorReview({ phase: "ready", view: parsed, notice: "" });
      expect(html).toContain(copy);
      expect(html).not.toContain('data-review-action="accepted"');
      expect(html).not.toContain("English transcript ready");
    }
  });

  it("rejects progress for another segment/version or a published review and labels rejected work clearly", () => {
    for (const progress of [
      { source_segment_id: working, source_segment_version: 1, state: "queued" },
      { source_segment_id: segment, source_segment_version: 2, state: "queued" },
      { source_segment_id: segment, source_segment_version: 1, state: "unconfirmed" },
    ]) expect(() => parseCreatorReview({ ...view, translation_progress: [progress] }, session)).toThrow();
    const rejected = { ...view, status: "translation_pending",
      review_queue: { ...view.review_queue, status: "not_ready", items: [] },
      working: { ...view.working, blockers: [{ source_segment_id: segment, code: "translation_retry_required" }] },
    };
    expect(renderCreatorReview({ phase: "ready", view: parseCreatorReview(rejected, session), notice: "" }))
      .toContain("Translation needs a new attempt");
  });

  it("shows the actual bilingual review contract, explicit decisions and unassigned speakers", () => {
    const parsed = parseCreatorReview(view, session);
    const html = renderCreatorReview({ phase: "ready", view: parsed, notice: "" });
    expect(html).toContain("Spanish · original");
    expect(html).toContain("English · proposed translation");
    expect(html).toContain("I do not have a fever.");
    expect(html).toContain("Accept English translation");
    expect(html).toContain("Reject translation");
    expect(html).toContain("Speaker not assigned");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("English transcript ready");
  });

  it("rejects cross-session, inconsistent readiness and changed review lineage", () => {
    expect(() => parseCreatorReview(view, working)).toThrow();
    expect(() => parseCreatorReview({ ...view, working: { ...view.working, note_ready: true } }, session)).toThrow();
    expect(() => parseCreatorReview({ ...view, review_queue: { ...view.review_queue, working_transcript_version: 3 } }, session)).toThrow();
  });

  it("hides protected content while a save is uncertain and offers the same-decision retry", () => {
    const html = renderCreatorReview({ phase: "retry", view: null, notice: "Save unconfirmed." });
    expect(html).toContain("Retry the same decision");
    expect(html).not.toContain("No tengo fiebre");
    expect(html).not.toContain('data-review-action="accepted"');
  });

  it("uses only the supplied authenticated transport and forwards the exact retry key", async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify(view), {
      headers: { "content-type": "application/json" },
    }));
    const api = new HttpCreatorReviewApi(session, transport);
    expect((await api.read()).session_id).toBe(session);
    expect(transport).toHaveBeenCalledWith(`/v1/captured-sessions/${session}/review`, { method: "GET" });
    const request = {
      schema_version: "1.0" as const, expected_source_transcript_version: 1,
      source_segment_id: segment, expected_source_segment_version: 1,
      translation_id: translation, expected_translation_version: 1, decision: "accepted" as const,
    };
    transport.mockResolvedValueOnce(new Response(JSON.stringify({
      schema_version: "1.0", session_id: session, review_id: translation, saved: true,
    }), { headers: { "content-type": "application/json" } }));
    await api.decide(request, "review-stable-key");
    expect(transport).toHaveBeenLastCalledWith(`/v1/captured-sessions/${session}/review`, {
      method: "POST", body: request, key: "review-stable-key",
    });
  });
});


it("retains late source-start positions in review evidence", () => {
  const evidence = { schema_version: "1.0", continuity: "interrupted_or_unconfirmed", missing_audio: "unknown",
    starts: [{ source_start_id: session, first_sequence_number: 0 },
      { source_start_id: segment, first_sequence_number: 1080 }] };
  expect(parseCaptureContinuity(evidence).starts[1]!.first_sequence_number).toBe(1080);
  expect(() => parseCaptureContinuity({ ...evidence, starts: [evidence.starts[0],
    { ...evidence.starts[1], first_sequence_number: 2048 }] })).toThrow();
});
