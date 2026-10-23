import { parseCaptureContinuity, type CaptureContinuity, type CreatorReviewView } from "../../../review-ui/src/creator-review-api";
import { isUuid } from "../../../review-ui/src/contracts";
import { type CoreCaptureClient, record, reference, requireValue } from "./core-client";

export interface ReviewedSource {
  readonly kind: "reviewed_english";
  readonly source_version: number;
  readonly working_transcript_id: string;
  readonly working_version: number;
  readonly capture_continuity?: CaptureContinuity;
}
export interface CoreNoteTemplate { schema_ref: string; note_type: string; field_names: string[] }
export interface CoreDraft {
  session_id: string; scribe_source_id: string; source_sha256: string; schema_ref: string;
  transcript_ref: string | null; note_ref: string | null; status: "draft" | "not_prepared";
  note_type: string; fields: Record<string, string> | null; field_order: string[] | null;
  note_sha256: string | null; created_at: string | null; review_required: true;
  reviewed_source: ReviewedSource;
}
export interface CoreNoteEdit {
  client_key: string; expected_note_ref: string; expected_note_sha256: string;
  expected_source_sha256: string; fields: Record<string, string>;
}
export interface PendingNoteSave {
  schema: string; source: ReviewedSource; fieldOrder: string[]; edit: CoreNoteEdit;
}

export function reviewedSource(view: CreatorReviewView): ReviewedSource {
  requireValue(view.status === "transcript_ready" && view.working?.note_ready && view.source);
  return { kind: "reviewed_english", source_version: view.source.source_transcript_version,
    working_transcript_id: view.working.working_transcript_id,
    working_version: view.working.working_transcript_version,
    ...(view.capture_continuity ? { capture_continuity: parseCaptureContinuity(view.capture_continuity) } : {}) };
}
export function sameSource(left: ReviewedSource, right: ReviewedSource): boolean {
  return left.kind === right.kind && left.source_version === right.source_version
    && left.working_transcript_id === right.working_transcript_id && left.working_version === right.working_version
    && canonical(left.capture_continuity ?? null) === canonical(right.capture_continuity ?? null);
}
export async function noteTemplates(client: CoreCaptureClient, session: string): Promise<CoreNoteTemplate[]> {
  return parseNoteTemplates(await client.note(session, "templates"), session);
}
export function parseNoteTemplates(value: unknown, session: string): CoreNoteTemplate[] {
  requireValue(closed(value, "session_id,templates") && value.session_id === session
    && Array.isArray(value.templates) && value.templates.length <= 100);
  const ids = new Set<string>();
  for (const item of value.templates) {
    requireValue(closed(item, "schema_ref,note_type,field_names") && reference(item.schema_ref, "doctor_note_schema")
      && content(item.note_type, 160) && Array.isArray(item.field_names) && item.field_names.length > 0
      && item.field_names.length <= 100 && item.field_names.every(key => content(key, 200))
      && new Set(item.field_names).size === item.field_names.length && !ids.has(item.schema_ref));
    ids.add(item.schema_ref);
  }
  return value.templates as CoreNoteTemplate[];
}

/** Same canonical Core note receipt/hash; configured sources retain review lineage. */
export async function parseDraft(value: unknown, session: string, schema: string, source: ReviewedSource): Promise<CoreDraft> {
  requireValue(closed(value, "session_id,scribe_source_id,source_sha256,schema_ref,transcript_ref,note_ref,status,note_type,fields,field_order,note_sha256,created_at,review_required,reviewed_source")
    && value.session_id === session && value.schema_ref === schema && value.scribe_source_id === source.working_transcript_id
    && isDigest(value.source_sha256) && value.review_required === true && content(value.note_type, 160)
    && (value.transcript_ref === null || reference(value.transcript_ref, "ai_visit_transcript"))
    && validSource(value.reviewed_source) && sameSource(value.reviewed_source, source));
  if (value.status === "not_prepared") {
    requireValue([value.note_ref, value.fields, value.field_order, value.note_sha256, value.created_at].every(v => v === null));
  } else {
    requireValue(value.status === "draft" && reference(value.note_ref, "visit_note")
      && reference(value.transcript_ref, "ai_visit_transcript") && validFields(value.fields, value.field_order)
      && typeof value.created_at === "string" && Number.isFinite(Date.parse(value.created_at)));
    const fields = value.fields as Record<string, string>, order = value.field_order as string[];
    requireValue(await sha256(JSON.stringify(order.map(key => [key, fields[key]]))) === value.note_sha256);
  }
  return value as unknown as CoreDraft;
}
export function pendingSave(base: CoreDraft, fields: Record<string, string>): PendingNoteSave {
  requireValue(base.status === "draft" && base.note_ref && base.note_sha256 && base.field_order
    && validFields(fields, base.field_order));
  return { schema: base.schema_ref, source: base.reviewed_source, fieldOrder: [...base.field_order], edit: {
    client_key: crypto.randomUUID(), expected_note_ref: base.note_ref, expected_note_sha256: base.note_sha256,
    expected_source_sha256: base.source_sha256,
    fields: Object.fromEntries(base.field_order.map(key => [key, fields[key]!])),
  } };
}
export async function saveNote(client: CoreCaptureClient, session: string, pending: PendingNoteSave): Promise<CoreDraft> {
  const value = await client.note(session, "save", pending.schema, pending.edit, pending.edit.client_key);
  const draft = await parseDraft(value, session, pending.schema, pending.source);
  requireValue(draft.status === "draft" && draft.note_ref !== pending.edit.expected_note_ref
    && draft.source_sha256 === pending.edit.expected_source_sha256
    && JSON.stringify(draft.field_order) === JSON.stringify(pending.fieldOrder)
    && pending.fieldOrder.every(key => draft.fields?.[key] === pending.edit.fields[key]));
  return draft;
}

/** Resolution fences an unsaved request, then the caller must read the current draft. */
export async function resolveNote(client: CoreCaptureClient, session: string, pending: PendingNoteSave): Promise<"saved" | "closed"> {
  const value = await client.note(session, "resolve", pending.schema, pending.edit, pending.edit.client_key);
  requireValue(closed(value, "session_id,schema_ref,client_key,request_sha256,status,result_note_ref,result_sha256")
    && value.session_id === session && value.schema_ref === pending.schema && value.client_key === pending.edit.client_key
    && value.request_sha256 === await sha256(canonical({ edit: pending.edit, schema: pending.schema,
      session, workspace: client.scope.workspaceId })));
  if (value.status === "saved") {
    requireValue(reference(value.result_note_ref, "visit_note") && value.result_note_ref !== pending.edit.expected_note_ref
      && value.result_sha256 === await sha256(JSON.stringify(pending.fieldOrder.map(key => [key, pending.edit.fields[key]]))));
  } else requireValue(value.status === "closed" && value.result_note_ref === null && value.result_sha256 === null);
  return value.status;
}

/** Read-only receipt check. A missing receipt never closes the pending save. */
export async function checkNoteSave(client: CoreCaptureClient, session: string,
  pending: PendingNoteSave): Promise<"saved" | "closed" | "pending"> {
  const value = await client.note(session, "save_status", pending.schema, pending.edit, pending.edit.client_key);
  requireValue(closed(value, "session_id,schema_ref,client_key,request_sha256,status,result_note_ref,result_sha256")
    && value.session_id === session && value.schema_ref === pending.schema
    && value.client_key === pending.edit.client_key
    && value.request_sha256 === await sha256(canonical({ edit: pending.edit, schema: pending.schema,
      session, workspace: client.scope.workspaceId })));
  if (value.status === "saved") {
    requireValue(reference(value.result_note_ref, "visit_note") && value.result_note_ref !== pending.edit.expected_note_ref
      && value.result_sha256 === await sha256(JSON.stringify(pending.fieldOrder.map(key => [key, pending.edit.fields[key]]))));
  } else requireValue((value.status === "pending" || value.status === "closed")
    && value.result_note_ref === null && value.result_sha256 === null);
  return value.status;
}

export function validPendingSave(value: unknown): value is PendingNoteSave {
  if (!closed(value, "schema,source,fieldOrder,edit") || !reference(value.schema, "doctor_note_schema")
    || !validSource(value.source) || !closed(value.edit, "client_key,expected_note_ref,expected_note_sha256,expected_source_sha256,fields")) return false;
  return isUuid(value.edit.client_key) && reference(value.edit.expected_note_ref, "visit_note")
    && isDigest(value.edit.expected_note_sha256) && isDigest(value.edit.expected_source_sha256)
    && validFields(value.edit.fields, value.fieldOrder);
}
export function validSource(value: unknown): value is ReviewedSource {
  const withContinuity = record(value) && Object.hasOwn(value, "capture_continuity");
  if (withContinuity) { try { parseCaptureContinuity(value.capture_continuity); } catch { return false; } }
  return closed(value, "kind,source_version,working_transcript_id,working_version" + (withContinuity ? ",capture_continuity" : "")) && value.kind === "reviewed_english"
    && isUuid(value.working_transcript_id) && Number.isSafeInteger(value.source_version) && Number(value.source_version) > 0
    && Number.isSafeInteger(value.working_version) && Number(value.working_version) > 0;
}
function validFields(fields: unknown, order: unknown): boolean {
  return record(fields) && Array.isArray(order) && order.length > 0 && order.length <= 100
    && Object.keys(fields).length === order.length && new Set(order).size === order.length
    && order.every(key => content(key, 200) && Object.hasOwn(fields, key) && typeof fields[key] === "string"
      && !fields[key].includes("\0")) && new TextEncoder().encode(JSON.stringify(fields)).length <= 262144;
}
export function closed(value: unknown, keys: string): value is Record<string, unknown> {
  return record(value) && Object.keys(value).sort().join(",") === keys.split(",").sort().join(",");
}
function content(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !value.includes("\0");
}
function isDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
// Match Core's UTF-8 object-key ordering, including non-BMP template names.
export function canonical(value: unknown): string {
  if (record(value)) {
    const keys = Object.keys(value).sort((left, right) => {
      const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right);
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
      return a.length - b.length;
    });
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return JSON.stringify(value);
}
