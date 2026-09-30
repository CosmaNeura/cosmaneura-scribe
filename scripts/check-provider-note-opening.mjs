// Actual compiled workspace/desktop renderer. Invented reads only; no microphone or service.
import assert from "node:assert/strict";
import { webcrypto, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";
const [bundle, jsdomPath] = process.argv.slice(2);
if (!bundle || !jsdomPath) throw new Error("Usage: check-provider-note-opening.mjs bundle jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomPath));
const code = await readFile(bundle, "utf8"), id = "01j" + "0".repeat(23);
const scope = { workspaceId: webcrypto.randomUUID(), appointmentRef: "appointment_" + id, bindingRef: "scribe_capture_binding_" + id };
const session = webcrypto.randomUUID(), working = webcrypto.randomUUID(), segment = webcrypto.randomUUID();
const encounter = { appointmentRef: scope.appointmentRef, title: "Synthetic note opening", detail: "Invented fixture" };
const review = { schema_version: "1.0", session_id: session, status: "transcript_ready",
  source: { source_transcript_version: 1, segments: [{ source_segment_id: segment, source_segment_version: 1,
    content: "Invented speech.", source_locale: "en-US", speaker_role: "unknown", start_ms: 0, end_ms: 1000 }] },
  working: { source_transcript_version: 1, working_transcript_id: working, working_transcript_version: 1,
    note_ready: true, blockers: [], segments: [{ source_segment_id: segment, source_segment_version: 1,
      resolution: "english_source", content: "Invented speech." }] },
  review_queue: { schema_version: "1.0", session_id: session, source_transcript_version: 1,
    working_transcript_id: working, working_transcript_version: 1, status: "complete", items: [] } };
const schema = "doctor_note_schema_" + id, fields = { Plan: "Invented saved note; no patient." };
const template = { schema_ref: schema, note_type: "Synthetic SOAP", field_names: ["Plan"] };
const note = { session_id: session, scribe_source_id: working, source_sha256: "a".repeat(64), schema_ref: schema,
  transcript_ref: "ai_visit_transcript_" + id, note_ref: "visit_note_" + id, status: "draft", note_type: "Synthetic SOAP",
  fields, field_order: ["Plan"], note_sha256: createHash("sha256").update(JSON.stringify(Object.entries(fields))).digest("hex"),
  created_at: new Date().toISOString(), review_required: true,
  reviewed_source: { kind: "reviewed_english", source_version: 1, working_transcript_id: working, working_version: 1 } };
const forbidden = () => { throw new Error("Unrequested source, write or external I/O"); };
const scenarios = ["combined", "legacy", "fallback", "no-template", "multiple", "unready", "invalid", "revoked", "departed", "refreshed"];
const results = [];
for (const mode of ["workspace", "desktop"]) for (const scenario of scenarios) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "capacitor://localhost/index.html",
    runScripts: "outside-only", pretendToBeVisual: true });
  const window = dom.window, root = window.document.getElementById("root");
  Object.defineProperty(window, "crypto", { value: webcrypto });
  Object.assign(window, { Headers, Response, TextEncoder, TextDecoder, structuredClone }); window.fetch = forbidden;
  const module = new SourceTextModule(code, { context: dom.getInternalVMContext() });
  await module.link(forbidden); await module.evaluate();
  const abort = new window.AbortController(), encounterAbort = new window.AbortController();
  const calls = [], openingReview = { scope, receivedAt: Date.now(), view: review };
  const progress = { admission: null, sessionId: session, uploaded: true, pendingSave: null };
  const journal = { load: async () => ({ revision: "1", progress }), save: forbidden };
  let finishLate;
  const readCore = async (path, body) => {
    const action = path.split("/").at(-1);
    calls.push(action); assert.equal(body.workspace_id, scope.workspaceId); assert.equal(body.binding_ref, scope.bindingRef);
    const value = { contract_version: "1", workspace_id: scope.workspaceId, binding_ref: scope.bindingRef,
      request_nonce: body.request_nonce, checked_at: new Date().toISOString() };
    if (action === "note-opening") {
      assert.equal(body.expected_session_id, session);
      if (["departed", "refreshed"].includes(scenario)) await new Promise(done => { finishLate = done; });
      if (scenario === "revoked") encounterAbort.abort();
      const templates = scenario === "no-template" ? [] : scenario === "multiple"
        ? [template, { ...template, schema_ref: schema.slice(0, -1) + "1" }] : [template];
      const currentReview = scenario === "unready" ? { schema_version: "1.0", session_id: session,
        status: "processing", source: null, working: null, review_queue: null } : review;
      return { ...value, operation: "note_opening", receipt: scenario === "fallback"
        ? { session_id: session, separate_reads_required: true }
        : { session_id: session, review: currentReview, templates: scenario === "unready" ? null : templates,
          note: scenario === "unready" || templates.length !== 1 ? null : scenario === "invalid" ? { ...note, note_sha256: "b".repeat(64) } : note } };
    }
    if (action === "capture-operations") {
      assert.equal(body.operation.kind, "creator_review"); return { ...value, operation: "creator_review", receipt: review };
    }
    assert.equal(action, "capture-notes"); assert.ok(["templates", "read"].includes(body.action));
    return { ...value, action: body.action, receipt: body.action === "templates" ? { session_id: session, templates: [template] } : note };
  };
  const selected = { scope, encounter, signal: encounterAbort.signal, journal, openingReview,
    ...(scenario !== "legacy" ? { noteOpeningSupported: true } : {}),
    request: async (path, body) => Response.json(await readCore(path, body)), recorder: forbidden, openInCore: forbidden,
    reviewJournal: () => ({ load: async () => null, save: forbidden, clear: forbidden }) };
  let host = { signal: abort.signal, listEncounters: async () => [encounter], createEncounter: forbidden, openEncounter: async () => selected }, desktop;
  if (mode === "desktop") {
    const revision = webcrypto.randomUUID(), connectionId = webcrypto.randomUUID(), encounterId = webcrypto.randomUUID();
    let event;
    encounterAbort.signal.addEventListener("abort", () => event?.({ kind: "encounter_closed", id: encounterId }));
    const port = { subscribe: listener => { event = listener; return () => {}; }, request: async request => {
      let result;
      switch (request.method) {
        case "session_read": result = { phase: "ready", revision }; break;
        case "connect": result = { connectionId, revision }; break;
        case "list": result = [encounter]; break;
        case "encounter_setup":
          assert.equal(request.payload.action, "info");
          assert.deepEqual(Object.keys(request.payload), ["action"]);
          result = { enabled: false, account: null }; break;
        case "open": result = { encounterId, encounter, scope, openingReview,
          ...(scenario !== "legacy" ? { noteOpeningSupported: true } : {}) }; break;
        case "journal_load": result = await journal.load(); break;
        case "review_load": result = null; break;
        case "core": result = { status: 200, body: await readCore(request.payload.path, request.payload.body) }; break;
        case "disconnect": case "cancel": case "close": result = null; break;
        default: forbidden();
      }
      return { requestId: request.requestId, ok: true, result };
    } };
    desktop = module.namespace.createDesktopProviderApplicationHost(port, { subscribe: () => () => {}, request: forbidden });
    await desktop.host.session.getState(); host = (await desktop.host.connect(abort.signal)).workspace;
  }
  const until = async predicate => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(done => setTimeout(done, 5)); }
    throw new Error(`State did not arrive: ${mode}/${scenario}: ${root.textContent}`);
  };
  const dispose = module.namespace.mountProviderWorkspace(root, host);
  try {
    await until(() => root.querySelector('[data-workspace-action="open"]') && !root.hasAttribute("aria-busy"));
    root.querySelector('[data-workspace-action="open"]').click();
    await until(() => root.querySelector('[data-review-action="continue"]')?.disabled === false);
    assert.equal(calls.length, 0);
    root.querySelector('[data-review-action="continue"]').click();
    if (scenario === "departed") {
      await until(() => finishLate); root.querySelector('[data-workspace-action="encounters"]').click();
      await until(() => root.querySelector('[data-workspace-action="open"]')); finishLate();
      await new Promise(done => setTimeout(done, 20)); assert.equal(root.querySelector("[data-note-field]"), null);
    } else if (scenario === "refreshed") {
      await until(() => finishLate); root.querySelector('[data-review-action="refresh"]').click();
      await until(() => calls.length === 2 && root.querySelector('[data-review-action="refresh"]')?.disabled === false);
      finishLate(); await new Promise(done => setTimeout(done, 20));
      assert.equal(root.querySelector("[data-note-field]"), null);
    } else if (scenario === "revoked") {
      await until(() => root.textContent.includes("Encounter access ended")); assert.equal(root.querySelector("[data-note-field]"), null);
    } else if (["no-template", "multiple", "unready", "invalid"].includes(scenario)) {
      const text = { "no-template": "No templates are available", multiple: "Choose your note template",
        unready: "transcript changed", invalid: "note could not be opened" }[scenario];
      await until(() => root.textContent.includes(text)); assert.equal(root.querySelector("[data-note-field]"), null);
    } else {
      await until(() => root.querySelector("[data-note-field]"));
      assert.equal(root.querySelector("[data-note-field]").value, fields.Plan);
    }
    assert.equal(calls.length, scenario === "legacy" ? 4 : scenario === "fallback" ? 5 : scenario === "refreshed" ? 2 : 1);
    results.push({ mode, scenario, requests: calls.length, passed: true });
  } finally { finishLate?.(); await dispose(); await desktop?.dispose(); dom.window.close(); }
}
process.stdout.write(JSON.stringify({ synthetic_only: true, source_started: false, checks: results.length, results }, null, 2) + "\n");
