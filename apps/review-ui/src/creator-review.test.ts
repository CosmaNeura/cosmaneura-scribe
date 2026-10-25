import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpCreatorReviewApi, parseCreatorReview, parseCaptureContinuity, type AuthorizedReviewRequest } from "./creator-review-api";
import { mountCreatorReview, renderCreatorReview, renderNoteTranscript, transcriptParagraphs } from "./creator-review-panel";
import { renderCreatorEditDialog } from "./creator-edit-view";
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
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("breaks long speech into readable paragraphs without changing characters or assigning voices", () => {
    for (const text of [
      "Dr. Avery described a fictional test. No medication was discussed. ".repeat(20),
      "síntoma sin puntuación ".repeat(80),
      "First sentence.\nSecond sentence!  Third sentence? Fourth sentence. Fifth sentence.",
      "<script>never interpret this</script> & original wording.",
    ]) {
      const parts = transcriptParagraphs(text);
      expect(parts.join("")).toBe(text);
      expect(parts.every(part => part.length <= 401)).toBe(true);
      if (text.length > 400) expect(parts.length).toBeGreaterThan(1);
    }
    const html = renderCreatorReview({ phase: "ready", view: parseCreatorReview(view, session), notice: "" });
    expect(html.match(/class="creator-segment-heading"/gu)).toHaveLength(1);
    expect(html).toContain("Speaker not assigned");
    expect(html).not.toContain("<script>");
  });
  it("keeps the same detected speaker number across languages without inferring a patient or clinician", () => {
    const speakerA = "00000000-0000-4000-8000-000000000011";
    const speakerB = "00000000-0000-4000-8000-000000000012";
    const speakerC = "00000000-0000-4000-8000-000000000013";
    const ids = [segment, translation, working, "00000000-0000-4000-8000-000000000014"];
    const segments = ids.map((id, index) => ({ ...view.source.segments[0]!, source_segment_id: id,
      speaker_id: [speakerA, speakerB, speakerA, speakerC][index], source_locale: index === 2 ? "en-US" : "es-US",
      content: index === 2 ? "Invented English speech." : "Habla ficticia.", start_ms: index * 1000, end_ms: index * 1000 + 900 }));
    const parsed = parseCreatorReview({ ...view, status: "transcript_ready", source: { ...view.source, segments },
      working: { ...view.working, note_ready: true, blockers: [], segments: segments.map(item => ({
        source_segment_id: item.source_segment_id, source_segment_version: 1,
        resolution: item.source_locale === "en-US" ? "english_source" : "spanish_translation", content: "Invented English speech.",
      })) }, review_queue: { ...view.review_queue, status: "complete", items: [] },
    }, session);
    const html = renderCreatorReview({ phase: "ready", view: parsed, notice: "" });
    expect(html.match(/Speaker 1 · not identified/gu)).toHaveLength(2);
    expect(html.match(/Speaker 2 · not identified/gu)).toHaveLength(1);
    expect(html.match(/Speaker 3 · not identified/gu)).toHaveLength(1);
    expect([...html.matchAll(/Speaker (\d) · not identified/gu)].map(match => match[1])).toEqual(["1", "2", "1", "3"]);
    expect(html).not.toContain("<strong>Clinician</strong>");
    expect(html).not.toContain("<strong>Patient</strong>");
  });
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
      expect(html).toContain("Check status</button>");
      expect(html).toContain(state === "unconfirmed" ? "Choose Check status later" : "Checking translation automatically");
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
      .toContain("English translation needs help");
    expect(renderCreatorReview({ phase: "ready", view: parseCreatorReview(rejected, session), notice: "" }))
      .not.toContain("Checking translation automatically");
  });

  it.each(["translation_failed", "translation_retry_required"])("keeps %s blocked while repeated Check status only reads", async code => {
    const failed = { ...view, status: "translation_pending", editing_allowed: true,
      review_queue: { ...view.review_queue, status: "not_ready", items: [] },
      working: { ...view.working, blockers: [{ source_segment_id: segment, code }] },
    };
    const parsed = parseCreatorReview(failed, session), original = JSON.stringify(parsed);
    const afterDecision = renderCreatorReview({ phase: "ready", view: parsed, notice: "Decision saved." });
    expect(afterDecision).toContain("Decision saved.");
    expect(afterDecision).toContain("Check status only looks for updates; it does not retry translation.");
    const edit = renderCreatorEditDialog(parsed, segment);
    expect(edit).toContain("English wording is unavailable for this passage.");
    expect(edit).toContain("Your original Spanish transcript is retained.");
    expect(edit).not.toContain("Finish translation review");
    expect(edit).not.toContain('textarea name="content"');

    // Minimal event surface only; the actual mounted controller and HTTP adapter run.
    // This exercises read/mutation boundaries without a browser or simulated provider success.
    class Surface extends EventTarget {
      innerHTML = "";
      disabled = false;
      dataset = { reviewAction: "refresh" };
      closest(selector: string): Surface | null { return selector === "button[data-review-action]" ? this : null; }
      contains(element: unknown): boolean { return element === button; }
      replaceChildren(): void { this.innerHTML = ""; }
    }
    const root = new Surface(), button = new Surface();
    vi.stubGlobal("Element", Surface);
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    vi.useFakeTimers();
    const request = vi.fn<AuthorizedReviewRequest>(async () => new Response(JSON.stringify(failed), { headers: { "content-type": "application/json" } }));
    const api = new HttpCreatorReviewApi(session, request), decide = vi.spyOn(api, "decide"), openNote = vi.fn();
    const dispose = mountCreatorReview(root as unknown as HTMLElement, api, { continueToNote: openNote });
    try {
      await vi.waitFor(() => expect(root.innerHTML).toContain("English translation needs help"));
      for (let index = 0; index < 2; index += 1) {
        expect(root.innerHTML).toContain("Check status</button>");
        const click = new Event("click");
        Object.defineProperty(click, "target", { value: button });
        root.dispatchEvent(click);
        await vi.waitFor(() => expect(root.innerHTML).toContain("English translation needs help"));
      }
      await vi.advanceTimersByTimeAsync(60_000);
      expect(request).toHaveBeenCalledTimes(3);
      for (const [url, options] of request.mock.calls) {
        expect(url).toBe(`/v1/captured-sessions/${session}/review`);
        expect(options.method).toBe("GET");
      }
      expect(decide).not.toHaveBeenCalled();
      expect(openNote).not.toHaveBeenCalled();
      expect(root.innerHTML).toContain("Your original Spanish transcript is retained.");
      expect(root.innerHTML).toContain("Keep this visit and contact your practice administrator for help.");
      expect(root.innerHTML).toContain("Check status only looks for updates; it does not retry translation.");
      expect(root.innerHTML).toContain("A note cannot be prepared yet.");
      expect(root.innerHTML).toContain("No tengo fiebre.");
      expect(root.innerHTML).not.toMatch(/data-review-action="(?:accepted|rejected|continue|retry)"/u);
      expect(JSON.stringify(parsed)).toBe(original);
    } finally { dispose(); }
  });

  it("shows the actual bilingual review contract, explicit decisions and unassigned speakers", () => {
    const parsed = parseCreatorReview(view, session);
    const original = JSON.stringify(parsed);
    const html = renderCreatorReview({ phase: "ready", view: parsed, notice: "" });
    const disclosure = html.match(/<details class="creator-transcript-details">.*?<\/details>/su)?.[0];
    expect(disclosure).toBe('<details class="creator-transcript-details"><summary>Transcript details</summary><p>Version 2</p></details>');
    const visibleReview = html.replace(disclosure!, "");
    expect(visibleReview).toContain("Your translation review is needed");
    expect(visibleReview).toContain("Spanish · original");
    expect(visibleReview).toContain("English · proposed translation");
    expect(visibleReview).toContain("Accept English translation");
    expect(visibleReview).toContain("Speaker not assigned");
    expect(html).toContain("1 transcript passage");
    expect(html).toContain('aria-label="Next matching passage"');
    expect(html).toContain(`data-transcript-segment="${segment}"`);
    expect(JSON.stringify(parsed)).toBe(original);
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
