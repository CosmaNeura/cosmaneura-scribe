// Fixed synthetic Core boundary; state survives page death, never browser contexts.
import { createHash, randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

const ref = (kind, suffix = "0") => `${kind}_01j${"0".repeat(22)}${suffix}`;
const digest = value => createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);

export async function installNoteServer(context, { loseSaveResponse, origin = "http://127.0.0.1:5173", saveDelayMs = 0,
  statusPending = false, draftPending = false, fields, visitTitle = "Synthetic saved visit", clockNow = () => new Date().toISOString() }) {
  const scope = { workspaceId: randomUUID(), appointmentRef: ref("appointment"), bindingRef: ref("scribe_capture_binding") };
  const session = randomUUID(), working = randomUUID(), segment = randomUUID();
  const source = { kind: "reviewed_english", source_version: 1, working_transcript_id: working, working_version: 1 };
  const review = { schema_version: "1.0", session_id: session, status: "transcript_ready",
    source: { source_transcript_version: 1, segments: [{ source_segment_id: segment, source_segment_version: 1,
      content: "Synthetic speech. No treatment plan was discussed.", source_locale: "en-US", speaker_role: "unknown", start_ms: 0, end_ms: 1000 }] },
    working: { source_transcript_version: 1, working_transcript_id: working, working_transcript_version: 1,
      note_ready: true, blockers: [], segments: [{ source_segment_id: segment, source_segment_version: 1,
        resolution: "english_source", content: "Synthetic speech. No treatment plan was discussed." }] },
    review_queue: { schema_version: "1.0", session_id: session, source_transcript_version: 1,
      working_transcript_id: working, working_transcript_version: 1, status: "complete", items: [] } };
  const template = { schema_ref: ref("doctor_note_schema"), note_type: "Synthetic SOAP", field_names: fields ? Object.keys(fields) : ["Patient", "Plan"] };
  const initialFields = fields ?? { Patient: "Invented patient — no real patient.", Plan: "No treatment plan discussed." };
  let note = { session_id: session, scribe_source_id: working, source_sha256: "a".repeat(64),
    schema_ref: template.schema_ref, transcript_ref: ref("ai_visit_transcript"), note_ref: ref("visit_note"),
    status: "draft", note_type: template.note_type, fields: initialFields, field_order: template.field_names,
    note_sha256: digest(JSON.stringify(Object.entries(initialFields))), created_at: new Date().toISOString(),
    review_required: true, reviewed_source: source };
  const original = structuredClone(note), calls = [], failures = [], rejectedOrigins = [];
  let savedEdit, savedKey, pendingStatus = statusPending;
  let pendingDraft = draftPending;
  const visibleNote = () => pendingDraft ? { ...note, status: "not_prepared", note_ref: null,
    fields: null, field_order: null, note_sha256: null, created_at: null } : note;
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { rejectedOrigins.push(url.origin); await route.abort(); return; }
    if (!url.pathname.startsWith("/note-lab/")) { await route.continue(); return; }
    try {
      if (url.pathname === "/note-lab/context") {
        await route.fulfill({ json: { scope, review, encounters: [
          { appointmentRef: scope.appointmentRef, title: visitTitle, detail: "Target visit" },
          { appointmentRef: ref("appointment", "1"), title: "Synthetic saved visit", detail: "Different visit" },
        ] } }); return;
      }
      const body = route.request().postDataJSON(), action = url.pathname.split("/").at(-1);
      expect(route.request().method()).toBe("POST");
      expect(body.workspace_id).toBe(scope.workspaceId); expect(body.binding_ref).toBe(scope.bindingRef);
      expect(body.request_nonce).toMatch(/^[a-f0-9-]{36}$/u);
      const envelope = { contract_version: "1", workspace_id: scope.workspaceId, binding_ref: scope.bindingRef,
        request_nonce: body.request_nonce, checked_at: await clockNow() };
      calls.push(action === "capture-notes" ? body.action : action);
      if (action === "note-opening") {
        expect(body.expected_session_id).toBe(session);
        await route.fulfill({ json: { ...envelope, operation: "note_opening", receipt: {
          session_id: session, review, templates: [template], note: visibleNote(),
        } } }); return;
      }
      if (action === "capture-operations") {
        expect(body.operation).toEqual({ kind: "creator_review" });
        await route.fulfill({ json: { ...envelope, operation: "creator_review", receipt: review } }); return;
      }
      expect(action).toBe("capture-notes"); expect(body.expected_session_id).toBe(session);
      expect(body.schema_ref).toBe(template.schema_ref);
      let receipt;
      if (body.action === "save") {
        expect(savedEdit).toBeUndefined();
        expect(body.edit.expected_note_ref).toBe(original.note_ref);
        expect(body.edit.expected_note_sha256).toBe(original.note_sha256);
        expect(body.edit.expected_source_sha256).toBe(original.source_sha256);
        savedEdit = structuredClone(body.edit); savedKey = route.request().headers()["idempotency-key"];
        expect(savedKey).toBe(savedEdit.client_key);
        note = { ...note, note_ref: ref("visit_note", "2"), fields: savedEdit.fields,
          note_sha256: digest(JSON.stringify(template.field_names.map(key => [key, savedEdit.fields[key]]))) };
        if (saveDelayMs) await new Promise(resolve => setTimeout(resolve, saveDelayMs));
        if (loseSaveResponse) { await route.abort("failed"); return; }
        receipt = note;
      } else if (body.action === "resolve" || body.action === "save_status") {
        expect(body.edit).toEqual(savedEdit); expect(route.request().headers()["idempotency-key"]).toBe(savedKey);
        receipt = { session_id: session, schema_ref: template.schema_ref, client_key: savedKey,
          request_sha256: digest(canonical({ edit: savedEdit, schema: template.schema_ref, session, workspace: scope.workspaceId })),
          status: body.action === "save_status" && pendingStatus ? "pending" : "saved",
          result_note_ref: body.action === "save_status" && pendingStatus ? null : note.note_ref,
          result_sha256: body.action === "save_status" && pendingStatus ? null : note.note_sha256 };
      } else { expect(["read", "prepare"]).toContain(body.action); receipt = visibleNote(); }
      await route.fulfill({ json: { ...envelope, action: body.action, receipt } });
    } catch (error) { failures.push(error); await route.abort(); }
  });
  return { scope, calls, original, current: () => note, releaseStatus: () => { pendingStatus = false; },
    releaseDraft: () => { pendingDraft = false; },
    assertHealthy: () => { expect(failures).toEqual([]); expect(rejectedOrigins).toEqual([]); } };
}
