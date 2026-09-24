import type { ReviewDecision } from "./creator-review-api";
import { isUuid } from "./contracts";

export interface PendingReviewDecision {
  readonly key: string;
  readonly request: ReviewDecision;
}

/** A host-owned, encrypted, creator/environment/session-scoped journal. */
export interface CreatorReviewJournal {
  load(): Promise<PendingReviewDecision | null>;
  /** Atomically retain this exact operation; reject a different pending decision. */
  save(operation: PendingReviewDecision): Promise<void>;
  /** Clear only the matching operation after a confirmed receipt or conflict. */
  clear(key: string): Promise<void>;
}

/** Strict metadata-only decoding: never persist arbitrary API or transcript fields. */
export function parsePendingReviewDecision(value: unknown): PendingReviewDecision {
  const fail = (): never => { throw new Error("Review recovery is unavailable."); };
  if (typeof value !== "object" || value === null) return fail();
  const outer = value as Record<string, unknown>;
  if (Object.keys(outer).sort().join(",") !== "key,request"
    || typeof outer.key !== "string" || !/^[A-Za-z0-9._-]{8,255}$/u.test(outer.key)
    || typeof outer.request !== "object" || outer.request === null) return fail();
  const request = outer.request as Record<string, unknown>;
  if (Object.keys(request).sort().join(",") !== [
    "decision", "expected_source_segment_version", "expected_source_transcript_version",
    "expected_translation_version", "schema_version", "source_segment_id", "translation_id",
  ].join(",") || request.schema_version !== "1.0"
    || !isUuid(request.source_segment_id) || !isUuid(request.translation_id)
    || !["accepted", "rejected"].includes(String(request.decision))
    || [request.expected_source_segment_version, request.expected_source_transcript_version,
      request.expected_translation_version].some((version) => !Number.isSafeInteger(version) || Number(version) < 1)) return fail();
  return structuredClone(value) as PendingReviewDecision;
}
