import type { components } from "../../capture/src/generated/capture-api";
import { readBoundedJson } from "./beta-api";
import { isUuid } from "./contracts";

export type CreatorReviewView = components["schemas"]["CreatorReviewViewV1"];
export type ReviewItem = components["schemas"]["CreatorTranslationReviewItemV1"];
export type ReviewDecision = components["schemas"]["CreatorTranslationDecisionBodyV1"];
export type ReviewReceipt = components["schemas"]["CreatorDecisionReceiptV1"];
export type CaptureContinuity = components["schemas"]["CaptureContinuity"];

/** Closed native restart evidence. It supplies no missing audio or gap duration. */
export function parseCaptureContinuity(value: unknown): CaptureContinuity {
  const evidence = record(value);
  requireValue(Object.keys(evidence).sort().join(",") === "continuity,missing_audio,schema_version,starts"
    && evidence.schema_version === "1.0" && evidence.continuity === "interrupted_or_unconfirmed"
    && evidence.missing_audio === "unknown");
  const starts = array(evidence.starts);
  requireValue(starts.length >= 2 && starts.length <= 1000);
  const ids = new Set<string>();
  let position = 0;
  for (const [index, value] of starts.entries()) {
    const start = record(value);
    requireValue(Object.keys(start).sort().join(",") === "first_sequence_number,source_start_id"
      && isUuid(start.source_start_id) && !ids.has(start.source_start_id)
      && Number.isSafeInteger(start.first_sequence_number) && Number(start.first_sequence_number) >= position
      && Number(start.first_sequence_number) < 1000 && (index !== 0 || start.first_sequence_number === 0));
    ids.add(start.source_start_id); position = Number(start.first_sequence_number);
  }
  return evidence as unknown as CaptureContinuity;
}

/** The existing authenticated shell/BFF supplies this. Never pass a workload token to a view. */
export type AuthorizedReviewRequest = (
  path: string,
  request: { readonly method: "GET" | "POST"; readonly body?: ReviewDecision; readonly key?: string },
) => Promise<Response>;

export class CreatorReviewError extends Error {
  public constructor(public readonly kind: "unavailable" | "conflict" | "invalid_response") {
    super("Creator transcript request failed.");
    this.name = "CreatorReviewError";
  }
}

export interface CreatorReviewApi {
  read(): Promise<CreatorReviewView>;
  decide(request: ReviewDecision, key: string): Promise<ReviewReceipt>;
}

export class HttpCreatorReviewApi implements CreatorReviewApi {
  private readonly path: string;

  public constructor(
    private readonly sessionId: string,
    private readonly authorizedRequest: AuthorizedReviewRequest,
  ) {
    if (!isUuid(sessionId)) throw new CreatorReviewError("unavailable");
    this.path = `/v1/captured-sessions/${encodeURIComponent(sessionId)}/review`;
  }

  public async read(): Promise<CreatorReviewView> {
    const value = await this.send({ method: "GET" });
    return parseCreatorReview(value, this.sessionId);
  }

  public async decide(request: ReviewDecision, key: string): Promise<ReviewReceipt> {
    if (!/^[A-Za-z0-9._-]{8,255}$/u.test(key)) throw new CreatorReviewError("unavailable");
    const value = record(await this.send({ method: "POST", body: request, key }));
    requireValue(value.schema_version === "1.0" && value.session_id === this.sessionId);
    requireValue(value.saved === true && isUuid(value.review_id));
    return value as unknown as ReviewReceipt;
  }

  private async send(request: Parameters<AuthorizedReviewRequest>[1]): Promise<unknown> {
    let response: Response;
    try {
      response = await this.authorizedRequest(this.path, request);
    } catch {
      throw new CreatorReviewError("unavailable");
    }
    if (!response.ok) {
      throw new CreatorReviewError(response.status === 409 ? "conflict" : "unavailable");
    }
    requireValue(response.headers.get("content-type")?.split(";", 1)[0] === "application/json");
    try {
      return await readBoundedJson(response, 8 * 1024 * 1024);
    } catch {
      throw new CreatorReviewError("invalid_response");
    }
  }
}

export function parseCreatorReview(value: unknown, sessionId: string): CreatorReviewView {
  const view = record(value);
  requireValue(view.schema_version === "1.0" && view.session_id === sessionId);
  requireValue(typeof view.status === "string");
  if (Object.hasOwn(view, "capture_continuity")) parseCaptureContinuity(view.capture_continuity);
  const progress = view.translation_progress === undefined ? [] : array(view.translation_progress);
  if (view.source === null && view.working === null && view.review_queue === null) {
    requireValue(progress.length === 0 && !Object.hasOwn(view, "capture_continuity"));
    requireValue([
      "created", "capturing", "uploaded", "processing", "speech_failed", "speech_retryable", "handed_off",
    ].includes(view.status));
    return view as unknown as CreatorReviewView;
  }
  const source = record(view.source);
  const working = record(view.working);
  const queue = record(view.review_queue);
  requireValue(positive(source.source_transcript_version));
  requireValue(working.source_transcript_version === source.source_transcript_version);
  requireValue(isUuid(working.working_transcript_id) && positive(working.working_transcript_version));
  requireValue(queue.session_id === sessionId && queue.schema_version === "1.0");
  requireValue(queue.source_transcript_version === source.source_transcript_version);
  requireValue(queue.working_transcript_id === working.working_transcript_id);
  requireValue(queue.working_transcript_version === working.working_transcript_version);
  const sources = array(source.segments);
  const segments = array(working.segments);
  requireValue(sources.length > 0 && sources.length === segments.length);
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of sources) {
    const segment = record(item);
    requireValue(isUuid(segment.source_segment_id) && !byId.has(segment.source_segment_id));
    requireValue(positive(segment.source_segment_version) && content(segment.content));
    requireValue(["en-US", "es-US", "unknown"].includes(String(segment.source_locale)));
    requireValue(["clinician", "patient", "other", "unknown"].includes(String(segment.speaker_role)));
    requireValue(Number.isSafeInteger(segment.start_ms) && Number(segment.start_ms) >= 0);
    requireValue(Number.isSafeInteger(segment.end_ms) && Number(segment.end_ms) > Number(segment.start_ms));
    byId.set(segment.source_segment_id, segment);
  }
  const workingIds = new Set<string>();
  for (const item of segments) {
    const segment = record(item);
    requireValue(isUuid(segment.source_segment_id) && !workingIds.has(segment.source_segment_id));
    workingIds.add(segment.source_segment_id);
    const original = byId.get(segment.source_segment_id);
    requireValue(original !== undefined && segment.source_segment_version === original.source_segment_version);
    requireValue(["english_source", "spanish_translation", "unresolved"].includes(String(segment.resolution)));
    requireValue(segment.resolution === "unresolved" ? segment.content === null : content(segment.content));
  }
  const blockers = array(working.blockers);
  const unresolvedIds = new Set(segments.filter((item) => record(item).resolution === "unresolved")
    .map((item) => record(item).source_segment_id));
  const progressIds = new Set<string>();
  for (const item of progress) {
    const pending = record(item);
    requireValue(isUuid(pending.source_segment_id) && !progressIds.has(pending.source_segment_id));
    progressIds.add(pending.source_segment_id);
    const original = byId.get(pending.source_segment_id);
    requireValue(original?.source_locale === "es-US"
      && original.source_segment_version === pending.source_segment_version);
    requireValue(unresolvedIds.has(pending.source_segment_id));
    requireValue(["queued", "unconfirmed", "result_saved"].includes(String(pending.state)));
  }
  for (const item of blockers) {
    const blocker = record(item);
    requireValue(typeof blocker.source_segment_id === "string" && byId.has(blocker.source_segment_id));
    requireValue(typeof blocker.code === "string");
  }
  requireValue(typeof working.note_ready === "boolean");
  requireValue(working.note_ready === (blockers.length === 0 && segments.every(
    (item) => record(item).resolution !== "unresolved",
  )));
  const expectedQueue = {
    translation_pending: "not_ready", review_required: "review_required",
    transcript_ready: "complete", quality_blocked: "quality_blocked",
  }[view.status];
  requireValue(expectedQueue !== undefined && queue.status === expectedQueue);
  requireValue((view.status === "transcript_ready") === working.note_ready);
  const items = array(queue.items);
  requireValue((queue.status === "review_required") === (items.length > 0));
  const reviewIds = new Set<string>();
  for (const item of items) {
    const review = record(item);
    requireValue(isUuid(review.source_segment_id) && !reviewIds.has(review.source_segment_id));
    requireValue(!progressIds.has(review.source_segment_id));
    reviewIds.add(review.source_segment_id);
    const original = byId.get(review.source_segment_id);
    requireValue(original !== undefined && original.source_locale === "es-US");
    requireValue(review.source_content === original.content && review.source_segment_version === original.source_segment_version);
    requireValue(isUuid(review.translation_id) && positive(review.translation_version));
    requireValue(review.source_locale === "es-US" && review.target_locale === "en-US");
    requireValue(content(review.translated_content));
  }
  return view as unknown as CreatorReviewView;
}

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new CreatorReviewError("invalid_response");
}
function record(value: unknown): Record<string, unknown> {
  requireValue(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  requireValue(Array.isArray(value) && value.length <= 10_000);
  return value;
}
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0; }
function content(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 100_000;
}
