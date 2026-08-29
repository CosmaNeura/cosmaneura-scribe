export type BetaIngestStatus = "processing" | "ready_for_review";
export type BetaSpeaker = "Clinician" | "Participant";

export interface BetaTranscriptSegment {
  readonly speaker: BetaSpeaker;
  readonly offset_ms: number;
  readonly duration_ms: number;
  readonly text: string;
}

export interface BetaTranscript {
  readonly language_code: "en-US";
  readonly segments: readonly BetaTranscriptSegment[];
}

export interface BetaIngest {
  readonly id: string;
  readonly tenant_id: string;
  readonly status: BetaIngestStatus;
  readonly created_at: string;
  readonly transcript: BetaTranscript | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_INGESTS = 200;
const MAX_SEGMENTS = 100;
const MAX_SEGMENT_TEXT_LENGTH = 500;

export class BetaContractError extends Error {
  public constructor() {
    super("The local Beta host returned an invalid response.");
    this.name = "BetaContractError";
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function parseBetaIngestList(value: unknown, expectedTenantId: string): BetaIngest[] {
  const document = requireRecord(value);
  const rawIngests = document.ingests;
  if (!Array.isArray(rawIngests) || rawIngests.length > MAX_INGESTS) {
    throw new BetaContractError();
  }
  return rawIngests.map((ingest) => parseBetaIngest(ingest, expectedTenantId));
}

export function parseBetaIngest(value: unknown, expectedTenantId: string): BetaIngest {
  const document = requireRecord(value);
  const id = document.id;
  const tenantId = document.tenant_id;
  const status = document.status;
  const createdAt = document.created_at;

  if (
    !isUuid(id) ||
    !isUuid(tenantId) ||
    tenantId.toLowerCase() !== expectedTenantId.toLowerCase() ||
    (status !== "processing" && status !== "ready_for_review") ||
    typeof createdAt !== "string" ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    throw new BetaContractError();
  }

  const transcript = parseTranscript(document.transcript);
  if (
    (status === "processing" && transcript !== null) ||
    (status === "ready_for_review" && transcript === null)
  ) {
    throw new BetaContractError();
  }

  return {
    id: id.toLowerCase(),
    tenant_id: tenantId.toLowerCase(),
    status,
    created_at: new Date(createdAt).toISOString(),
    transcript,
  };
}

function parseTranscript(value: unknown): BetaTranscript | null {
  if (value === null) return null;
  const document = requireRecord(value);
  if (document.language_code !== "en-US") throw new BetaContractError();
  const rawSegments = document.segments;
  if (
    !Array.isArray(rawSegments) ||
    rawSegments.length === 0 ||
    rawSegments.length > MAX_SEGMENTS
  ) {
    throw new BetaContractError();
  }
  return {
    language_code: "en-US",
    segments: rawSegments.map(parseSegment),
  };
}

function parseSegment(value: unknown): BetaTranscriptSegment {
  const document = requireRecord(value);
  const speaker = document.speaker;
  const offset = document.offset_ms;
  const duration = document.duration_ms;
  const text = document.text;
  if (
    (speaker !== "Clinician" && speaker !== "Participant") ||
    !Number.isSafeInteger(offset) ||
    Number(offset) < 0 ||
    !Number.isSafeInteger(duration) ||
    Number(duration) <= 0 ||
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > MAX_SEGMENT_TEXT_LENGTH
  ) {
    throw new BetaContractError();
  }
  return {
    speaker,
    offset_ms: Number(offset),
    duration_ms: Number(duration),
    text,
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BetaContractError();
  }
  return value as Record<string, unknown>;
}
