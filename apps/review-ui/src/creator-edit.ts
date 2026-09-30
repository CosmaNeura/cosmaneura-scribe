import type { components } from "../../capture/src/generated/capture-api";
import { isUuid } from "./contracts";

export type CreatorEditRequest = components["schemas"]["CreatorTranscriptEditBodyV1"];
export type CreatorEditReceipt = components["schemas"]["CreatorTranscriptEditReceiptV1"];
export type CreatorEdit = components["schemas"]["CreatorTranscriptEditV1"];
export type SpeakerConfirmation = components["schemas"]["CreatorSpeakerConfirmationV1"];
export interface PendingCreatorEdit { readonly key: string; readonly request: CreatorEditRequest }

/** Protected text: the authenticated host must provide encrypted, scoped storage. */
export interface CreatorEditJournal {
  load(): Promise<PendingCreatorEdit | null>;
  save(operation: PendingCreatorEdit): Promise<void>;
  clear(key: string): Promise<void>;
}

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new Error("Transcript edit is unavailable.");
}
function object(value: unknown): Record<string, unknown> {
  requireValue(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, fields: readonly string[]): void {
  requireValue(Object.keys(value).sort().join(",") === [...fields].sort().join(","));
}
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0; }
function validText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0 || code >= 0xdc00 && code <= 0xdfff) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    }
  }
  return true;
}

export function parseCreatorEditRequest(value: unknown): CreatorEditRequest {
  const request = object(value);
  keys(request, ["schema_version", "expected_source_transcript_version", "expected_working_transcript_id",
    "expected_working_transcript_version", "corrections", "speakers"]);
  requireValue(request.schema_version === "1.0" && positive(request.expected_source_transcript_version)
    && positive(request.expected_working_transcript_version) && isUuid(request.expected_working_transcript_id));
  requireValue(Array.isArray(request.corrections) && Array.isArray(request.speakers)
    && request.corrections.length <= 128 && request.speakers.length <= 128
    && request.corrections.length + request.speakers.length > 0);
  const correctionIds = new Set<string>(), speakerIds = new Set<string>();
  let chars = 0;
  for (const value of request.corrections) {
    const correction = object(value);
    keys(correction, ["source_segment_id", "expected_source_segment_version", "content"]);
    requireValue(isUuid(correction.source_segment_id) && !correctionIds.has(correction.source_segment_id)
      && positive(correction.expected_source_segment_version) && typeof correction.content === "string"
      && correction.content.trim().length > 0 && correction.content.length <= 100000 && validText(correction.content));
    correctionIds.add(correction.source_segment_id); chars += correction.content.length;
  }
  requireValue(chars <= 500000);
  for (const value of request.speakers) {
    const speaker = object(value);
    keys(speaker, ["speaker_id", "role", "display_name", "detail"]);
    requireValue(isUuid(speaker.speaker_id) && !speakerIds.has(speaker.speaker_id)
      && ["clinician", "patient", "other", "unknown"].includes(String(speaker.role))
      && (speaker.detail === null || (speaker.detail === "interpreter" || speaker.detail === "other") && speaker.role === "other")
      && (speaker.display_name === null || typeof speaker.display_name === "string"
        && speaker.display_name.trim().length > 0 && speaker.display_name.length <= 120
        && validText(speaker.display_name) && [...speaker.display_name].every(character => character.charCodeAt(0) >= 32) && speaker.role !== "unknown"));
    speakerIds.add(speaker.speaker_id);
  }
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 1048576) {
    throw new Error("This correction is too large to save. Edit a smaller section; nothing was truncated.");
  }
  return structuredClone(value) as CreatorEditRequest;
}

export function parsePendingCreatorEdit(value: unknown): PendingCreatorEdit {
  const operation = object(value);
  keys(operation, ["key", "request"]);
  requireValue(typeof operation.key === "string" && /^[A-Za-z0-9._-]{8,255}$/u.test(operation.key));
  return { key: operation.key, request: parseCreatorEditRequest(operation.request) };
}

export function parseCreatorEdit(value: unknown): CreatorEdit {
  const edit = object(value);
  keys(edit, ["edit_id", "working_transcript_version", "created_at", "request"]);
  const request = parseCreatorEditRequest(edit.request);
  requireValue(isUuid(edit.edit_id) && positive(edit.working_transcript_version)
    && edit.working_transcript_version === request.expected_working_transcript_version + 1
    && typeof edit.created_at === "string" && Number.isFinite(Date.parse(edit.created_at)));
  return { edit_id: edit.edit_id, working_transcript_version: Number(edit.working_transcript_version),
    created_at: String(edit.created_at), request };
}

export function currentSpeakerConfirmations(edits: readonly CreatorEdit[]): Map<string, SpeakerConfirmation> {
  const confirmations = new Map<string, SpeakerConfirmation>();
  for (const edit of edits) for (const speaker of edit.request.speakers ?? []) confirmations.set(speaker.speaker_id, speaker);
  return confirmations;
}
