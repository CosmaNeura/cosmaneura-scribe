import { webcrypto } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { CoreCaptureClient, type AuthorizedCoreRequest } from "./core-client";
import { readNoteOpening } from "./note-opening";
import { sha256 } from "./core-notes";

const session = "10000000-0000-4000-8000-000000000001", working = "20000000-0000-4000-8000-000000000002";
const suffix = "01j" + "0".repeat(23), schema = "doctor_note_schema_" + suffix;
const scope = { workspaceId: session, bindingRef: "scribe_capture_binding_" + suffix, appointmentRef: "appointment_" + suffix };
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });
async function fixture() {
  const segment = "30000000-0000-4000-8000-000000000003", fields = { Plan: "Invented note; no patient." };
  const source = { kind: "reviewed_english", source_version: 1, working_transcript_id: working, working_version: 1 };
  const receipt = { session_id: session,
    review: { schema_version: "1.0", session_id: session, status: "transcript_ready",
      source: { source_transcript_version: 1, segments: [{ source_segment_id: segment, source_segment_version: 1,
        content: "Invented speech.", source_locale: "en-US", speaker_role: "unknown", start_ms: 0, end_ms: 1000 }] },
      working: { source_transcript_version: 1, working_transcript_id: working, working_transcript_version: 1,
        note_ready: true, blockers: [], segments: [{ source_segment_id: segment, source_segment_version: 1,
          resolution: "english_source", content: "Invented speech." }] },
      review_queue: { schema_version: "1.0", session_id: session, source_transcript_version: 1,
        working_transcript_id: working, working_transcript_version: 1, status: "complete", items: [] } },
    templates: [{ schema_ref: schema, note_type: "Synthetic SOAP", field_names: ["Plan"] }],
    note: { session_id: session, scribe_source_id: working, source_sha256: "a".repeat(64), schema_ref: schema,
      transcript_ref: "ai_visit_transcript_" + suffix, note_ref: "visit_note_" + suffix, status: "draft",
      note_type: "Synthetic SOAP", fields, field_order: ["Plan"], note_sha256: await sha256(JSON.stringify(Object.entries(fields))),
      created_at: new Date().toISOString(), review_required: true, reviewed_source: source } };
  const abort = new AbortController();
  const connect = (value: unknown = receipt, envelope = {}) => {
    const request = vi.fn<AuthorizedCoreRequest>(async (_path, body) => Response.json({ ...body,
      contract_version: "1", checked_at: new Date().toISOString(), operation: "note_opening", receipt: value, ...envelope }));
    return { request, client: new CoreCaptureClient(scope, request, abort.signal) };
  };
  return { receipt, connect, abort };
}

it("uses one scoped fresh request and the existing review/note hash parsers", async () => {
  const f = await fixture(), { client, request } = f.connect();
  const opened = await readNoteOpening(client, session);
  expect(opened?.draft?.fields).toEqual(f.receipt.note.fields);
  expect(opened?.view.session_id).toBe(session);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]![0]).toBe("/service/v1/agent/scribe/note-opening");
  expect(Object.keys(request.mock.calls[0]![1]).sort()).toEqual(["binding_ref", "expected_session_id", "request_nonce", "workspace_id"]);
});
it.each([0, 2])("preserves provider template choice for %s templates", async count => {
  const f = await fixture();
  const templates = Array.from({ length: count }, (_, i) => ({ ...f.receipt.templates[0], schema_ref: schema.slice(0, -1) + i }));
  const opened = await readNoteOpening(f.connect({ ...f.receipt, templates, note: null }).client, session);
  expect(opened?.templates).toHaveLength(count); expect(opened?.draft).toBeNull();
});
it("accepts only explicit size fallback without attempting another request", async () => {
  const f = await fixture(), { client, request } = f.connect({ session_id: session, separate_reads_required: true });
  expect(await readNoteOpening(client, session)).toBeNull(); expect(request).toHaveBeenCalledTimes(1);
});
it("returns current unready review without opening a template or note", async () => {
  const f = await fixture(), value = { ...f.receipt, review: { schema_version: "1.0", session_id: session,
    status: "processing", source: null, working: null, review_queue: null }, templates: null, note: null };
  expect((await readNoteOpening(f.connect(value).client, session))?.view.status).toBe("processing");
  await expect(readNoteOpening(f.connect({ ...value, templates: [] }).client, session)).rejects.toThrow();
});
it.each(["session", "review-session", "schema", "lineage", "hash", "template", "extra", "fallback-false", "fallback-extra"])(
  "fails closed for %s without a legacy retry", async fault => {
    const f = await fixture();
    let receipt: unknown = f.receipt;
    if (fault === "session") f.receipt.session_id = working;
    if (fault === "review-session") f.receipt.review.session_id = working;
    if (fault === "schema") f.receipt.note.schema_ref = schema.slice(0, -1) + "1";
    if (fault === "lineage") f.receipt.note.reviewed_source.working_version = 2;
    if (fault === "hash") f.receipt.note.note_sha256 = "b".repeat(64);
    if (fault === "template") f.receipt.templates.push({ ...f.receipt.templates[0]! });
    if (fault === "extra") receipt = { ...f.receipt, extra: true };
    if (fault === "fallback-false") receipt = { session_id: session, separate_reads_required: false };
    if (fault === "fallback-extra") receipt = { session_id: session, separate_reads_required: true, review: f.receipt.review };
    const { client, request } = f.connect(receipt);
    await expect(readNoteOpening(client, session)).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(1);
  });
it.each([{ operation: "creator_review" }, { workspace_id: working }, { binding_ref: schema },
  { request_nonce: working }, { checked_at: "invalid" }])("validates the current receiver envelope %j", async envelope => {
  const f = await fixture();
  await expect(readNoteOpening(f.connect(f.receipt, envelope).client, session)).rejects.toThrow();
});
it("does not return a reply after access cancellation", async () => {
  const f = await fixture(), { client } = f.connect(); f.abort.abort();
  await expect(readNoteOpening(client, session)).rejects.toThrow();
});
