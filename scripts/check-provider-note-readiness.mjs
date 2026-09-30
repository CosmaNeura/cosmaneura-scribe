// Actual compiled note recovery. Synthetic transcript, native host and controllable clock only.
import assert from "node:assert/strict";
import { webcrypto, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";
const [bundle, jsdomPath] = process.argv.slice(2);
if (!bundle || !jsdomPath) throw new Error("Usage: check-provider-note-readiness.mjs bundle jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomPath));
const code = await readFile(bundle, "utf8"), id = "01j" + "0".repeat(23);
const scope = { workspaceId: webcrypto.randomUUID(), appointmentRef: "appointment_" + id, bindingRef: "scribe_capture_binding_" + id };
const session = webcrypto.randomUUID(), working = webcrypto.randomUUID(), segment = webcrypto.randomUUID();
const encounter = { appointmentRef: scope.appointmentRef, title: "Synthetic note opening", detail: "Invented fixture" };
const review = { schema_version: "1.0", session_id: session, status: "transcript_ready",
  source: { source_transcript_version: 1, segments: [{ source_segment_id: segment, source_segment_version: 1,
    content: "Invented speech.", source_locale: "en-US", speaker_id: webcrypto.randomUUID(), speaker_role: "unknown", start_ms: 0, end_ms: 1000 }] },
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
const absent = { ...note, status: "not_prepared", transcript_ref: null, note_ref: null,
  fields: null, field_order: null, note_sha256: null, created_at: null };
const forbidden = () => { throw new Error("Unrequested write, recording, or external I/O"); };
const flush = async () => { await new Promise(done => setTimeout(done, 5)); };
const results = [];
for (const scenario of ["lost-reply", "delayed", "expired", "hidden", "departed", "revoked", "hung-manual",
  "changed-source", "invalid-draft", "access-denied", "review-failed", "read-only"]) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "capacitor://localhost/index.html",
    runScripts: "outside-only", pretendToBeVisual: true });
  const window = dom.window, root = window.document.getElementById("root");
  Object.defineProperty(window, "crypto", { value: webcrypto });
  Object.assign(window, { Headers, Response, TextEncoder, TextDecoder, structuredClone });
  window.fetch = forbidden;
  // Drive only long application deadlines. DOM/microtask delivery stays real.
  const timers = new Map(), realTimeout = window.setTimeout.bind(window), realClear = window.clearTimeout.bind(window);
  const origin = Date.now(); let elapsed = 0, timerId = 1_000_000, visible = true;
  window.Date.now = () => origin + elapsed;
  Object.defineProperty(window.document, "visibilityState", { get: () => visible ? "visible" : "hidden" });
  window.setTimeout = (fn, ms = 0, ...args) => {
    if (ms < 3000) return realTimeout(fn, ms, ...args);
    const id = timerId++; timers.set(id, { at: elapsed + ms, run: () => fn(...args) }); return id;
  };
  window.clearTimeout = id => { if (!timers.delete(id)) realClear(id); };
  const advance = async ms => {
    const end = elapsed + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      elapsed = next[1].at; timers.delete(next[0]); next[1].run(); await flush();
    }
    elapsed = end; await flush();
  };
  const visibility = async value => {
    visible = value; window.document.dispatchEvent(new window.Event("visibilitychange")); await flush();
  };
  const module = new SourceTextModule(code, { context: dom.getInternalVMContext() });
  await module.link(forbidden); await module.evaluate();
  const lifetime = new window.AbortController(), encounterLifetime = new window.AbortController();
  const calls = [], held = []; let available = false, readCount = 0;
  const currentReview = () => scenario === "changed-source" && calls.includes("prepare")
    ? { ...review, source: { ...review.source, source_transcript_version: 2 },
      working: { ...review.working, source_transcript_version: 2, working_transcript_version: 2 },
      review_queue: { ...review.review_queue, source_transcript_version: 2, working_transcript_version: 2 } }
    : review;
  const request = async (path, body, _key, signal) => {
    const action = path.split("/").at(-1), kind = body.action ?? body.operation?.kind ?? action;
    calls.push(kind);
    assert.equal(body.workspace_id, scope.workspaceId); assert.equal(body.binding_ref, scope.bindingRef);
    const envelope = { contract_version: "1", workspace_id: scope.workspaceId, binding_ref: scope.bindingRef,
      request_nonce: body.request_nonce, checked_at: new Date().toISOString() };
    if (action === "note-opening") return Response.json({ ...envelope, operation: "note_opening",
      receipt: { session_id: session, review, templates: [template], note: absent } });
    if (action === "capture-operations") {
      assert.equal(kind, "creator_review");
      if (scenario === "review-failed") return new Response(null, { status: 503 });
      return Response.json({ ...envelope, operation: kind, receipt: currentReview() });
    }
    assert.equal(action, "capture-notes"); assert.ok(["prepare", "read"].includes(kind));
    assert.equal(body.expected_session_id, session); assert.equal(body.schema_ref, schema);
    if (kind === "prepare") {
      if (scenario === "lost-reply") { available = true; return new Response(null, { status: 503 }); }
      return Response.json({ ...envelope, action: kind, receipt: absent });
    }
    readCount++;
    if (scenario === "access-denied") return new Response(null, { status: 403 });
    if (["departed", "revoked", "hidden"].includes(scenario) && readCount === 1
      || scenario === "hung-manual" && readCount === 2) {
      await new Promise(resolve => held.push({ resolve, signal }));
      // Ignore cancellation on purpose: a late native transport must not win.
      return Response.json({ ...envelope, action: kind, receipt: note });
    }
    const receipt = scenario === "invalid-draft" && !available ? { ...note, note_sha256: "b".repeat(64) }
      : scenario === "changed-source" ? { ...note, reviewed_source: { ...note.reviewed_source, source_version: 2, working_version: 2 } }
      : available || scenario === "read-only" ? note : absent;
    return Response.json({ ...envelope, action: kind, receipt });
  };
  const host = { signal: lifetime.signal, listEncounters: async () => [encounter], createEncounter: forbidden,
    openEncounter: async () => ({ encounter, scope, signal: encounterLifetime.signal, request, noteOpeningSupported: true,
      openingReview: { scope, receivedAt: window.Date.now(), view: review },
      journal: { load: async () => ({ revision: "1", progress: { admission: null, sessionId: session, uploaded: true, pendingSave: null } }), save: forbidden },
      recorder: forbidden, openInCore: forbidden, reviewJournal: () => ({ load: async () => null, save: forbidden, clear: forbidden }) }) };
  const until = async predicate => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await flush(); }
    throw new Error(`State did not arrive: ${scenario}: ${root.textContent}`);
  };
  const click = action => { const button = root.querySelector(`[data-workspace-action="${action}"]`); assert.ok(button); button.click(); };
  const fieldsReady = () => root.querySelector("[data-note-field]");
  const dispose = module.namespace.mountProviderWorkspace(root, host);
  try {
    await until(() => root.querySelector('[data-workspace-action="open"]') && !root.hasAttribute("aria-busy"));
    click("open"); await until(() => root.querySelector('[data-review-action="continue"]')?.disabled === false);
    root.querySelector('[data-review-action="continue"]').click();
    await until(() => root.querySelector('[data-workspace-action="generate"]') && !root.hasAttribute("aria-busy"));
    click(scenario === "read-only" ? "check-note" : "generate");
    if (scenario === "review-failed") {
      await until(() => !root.hasAttribute("aria-busy") && root.textContent.includes("could not be confirmed"));
      assert.equal(calls.filter(c => c === "prepare").length, 0); assert.equal(readCount, 0);
      assert.ok(root.querySelector('[data-workspace-action="generate"]')); await advance(120_000);
    } else if (["lost-reply", "read-only"].includes(scenario)) {
      await until(fieldsReady);
    } else {
      await until(() => readCount === 1 && !root.hasAttribute("aria-busy"));
      if (["delayed", "expired"].includes(scenario)) {
        assert.match(root.querySelector("[data-note-readiness]").textContent, /automatically/);
        assert.equal(root.querySelector(".provider-note-options").open, false);
        assert.match(root.querySelector("[data-note-wait-time]").textContent, /Checking automatically/);
      }
      if (scenario === "delayed") { available = true; await advance(3000); await until(fieldsReady); }
      if (scenario === "expired") {
        await advance(90_000); assert.equal(readCount, 30);
        const count = readCount; await advance(120_000); await visibility(false); await visibility(true);
        assert.equal(readCount, count); assert.match(root.textContent, /Choose Check for note/);
        assert.equal(root.querySelector(".provider-note-options").open, true);
        assert.equal(root.querySelector("[data-note-wait-time]").textContent, "Automatic checking paused.");
        available = true; click("check-note"); await until(fieldsReady);
      }
      if (scenario === "hidden") {
        await until(() => held.length === 1); await visibility(false);
        assert.equal(held[0].signal.aborted, true); await advance(12_000); assert.equal(readCount, 1);
        available = true; await visibility(true); await until(fieldsReady); held[0].resolve(); await flush();
      }
      if (["departed", "revoked"].includes(scenario)) {
        await until(() => held.length === 1);
        if (scenario === "departed") { click("encounters"); await until(() => root.querySelector('[data-workspace-action="open"]')); }
        else { encounterLifetime.abort(); await until(() => root.textContent.includes("Encounter access ended")); }
        assert.equal(held[0].signal.aborted, true); held[0].resolve(); await flush(); await advance(120_000);
        assert.equal(fieldsReady(), null); assert.equal(readCount, 1);
      }
      if (scenario === "hung-manual") {
        await until(() => root.querySelector('[data-workspace-action="check-note"]')?.disabled === false);
        click("check-note"); await until(() => held.length === 1);
        assert.equal(root.hasAttribute("aria-busy"), false); click("check-note"); assert.equal(readCount, 2);
        await advance(30_000); assert.equal(held[0].signal.aborted, true);
        assert.equal(root.querySelector('[data-workspace-action="check-note"]').disabled, false);
        available = true; click("check-note"); await until(fieldsReady);
        held[0].resolve(); await flush(); assert.equal(readCount, 3);
      }
      if (["changed-source", "invalid-draft", "access-denied"].includes(scenario)) {
        await until(() => root.textContent.includes("note check could not be confirmed"));
        assert.equal(root.querySelector(".provider-note-options").open, true);
        assert.equal(fieldsReady(), null); await advance(120_000); assert.equal(readCount, 1);
        if (scenario === "invalid-draft") { available = true; click("check-note"); await until(fieldsReady); }
      }
    }
    if (fieldsReady()) {
      assert.equal(root.querySelector("[data-note-wait-time]"), null);
      assert.equal(fieldsReady().value, fields.Plan);
      fieldsReady().value += " Unsubmitted synthetic edit.";
      fieldsReady().dispatchEvent(new window.Event("input", { bubbles: true }));
      assert.equal(root.querySelector("[data-note-save-state]").textContent, "Unsaved edits");
      const count = readCount; await advance(120_000); await visibility(false); await visibility(true);
      assert.equal(readCount, count); assert.match(fieldsReady().value, /Unsubmitted synthetic edit/);
    }
    assert.equal(calls.filter(c => c === "prepare").length, ["review-failed", "read-only"].includes(scenario) ? 0 : 1);
    assert.ok(calls.every(c => ["note-opening", "creator_review", "prepare", "read"].includes(c)));
    results.push({ scenario, prepare_calls: calls.filter(c => c === "prepare").length, read_calls: readCount, passed: true });
  } finally { for (const pending of held) pending.resolve(); await dispose(); dom.window.close(); }
}
process.stdout.write(JSON.stringify({ compiled_workspace: true, synthetic_only: true, actual_device: false,
  microphone_calls: 0, save_calls: 0, checks: results.length, results }, null, 2) + "\n");
