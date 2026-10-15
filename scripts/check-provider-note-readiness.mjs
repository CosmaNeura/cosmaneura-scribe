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
const identity = { state: "provisional", version: 0, canonicalPatientRef: "patient_" + id, name: "Synthetic note opening", dateOfBirth: null };
const encounter = { appointmentRef: scope.appointmentRef, patientRef: identity.canonicalPatientRef, identity, dateOfBirth: "1990-01-01", title: identity.name, detail: "Invented fixture" };
const review = { schema_version: "1.0", session_id: session, status: "transcript_ready",
  source: { source_transcript_version: 1, segments: [{ source_segment_id: segment, source_segment_version: 1,
    content: "Invented speech.", source_locale: "en-US", speaker_id: webcrypto.randomUUID(), speaker_role: "unknown", start_ms: 0, end_ms: 1000 }] },
  working: { source_transcript_version: 1, working_transcript_id: working, working_transcript_version: 1,
    note_ready: true, blockers: [], segments: [{ source_segment_id: segment, source_segment_version: 1,
      resolution: "english_source", content: "Invented speech." }] },
  review_queue: { schema_version: "1.0", session_id: session, source_transcript_version: 1,
    working_transcript_id: working, working_transcript_version: 1, status: "complete", items: [] } };
const schema = "doctor_note_schema_" + id, legacyHeading = "Exam deferred to in-person visit 08/26/2026";
const fields = { Plan: "Invented saved note; no patient.", [legacyHeading]: "Not mentioned in transcript." };
const template = { schema_ref: schema, note_type: "Synthetic SOAP", field_names: Object.keys(fields) };
const note = { session_id: session, scribe_source_id: working, source_sha256: "a".repeat(64), schema_ref: schema,
  transcript_ref: "ai_visit_transcript_" + id, note_ref: "visit_note_" + id, status: "draft", note_type: "Synthetic SOAP",
  fields, field_order: Object.keys(fields), note_sha256: createHash("sha256").update(JSON.stringify(Object.entries(fields))).digest("hex"),
  created_at: new Date().toISOString(), review_required: true,
  reviewed_source: { kind: "reviewed_english", source_version: 1, working_transcript_id: working, working_version: 1 } };
const absent = { ...note, status: "not_prepared", transcript_ref: null, note_ref: null,
  fields: null, field_order: null, note_sha256: null, created_at: null };
const forbidden = () => { throw new Error("Unrequested write, recording, or external I/O"); };
const flush = async () => { await new Promise(done => setTimeout(done, 5)); };
const results = [];
for (const scenario of ["pending-review", "lost-reply", "delayed", "expired", "hidden", "departed", "revoked", "hung-manual",
  "changed-source", "invalid-draft", "access-denied", "review-failed", "retain-failed", "read-only", "invalid-dob", "saved-invalid-dob", "canonical-match"]) {
  const readOnly = ["read-only", "invalid-dob", "saved-invalid-dob", "canonical-match"].includes(scenario);
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "capacitor://localhost/index.html",
    runScripts: "outside-only", pretendToBeVisual: true });
  const window = dom.window, root = window.document.getElementById("root");
  Object.defineProperty(window, "crypto", { value: webcrypto });
  Object.assign(window, { Headers, Response, TextEncoder, TextDecoder, structuredClone });
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.matchMedia = () => ({ matches: false });
  window.fetch = forbidden;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  // Drive only long application deadlines. DOM/microtask delivery stays real.
  const timers = new Map(), realTimeout = window.setTimeout.bind(window), realClear = window.clearTimeout.bind(window);
  const origin = Date.now(); let elapsed = 0, timerId = 1_000_000, visible = true;
  window.Date.now = () => origin + elapsed;
  Object.defineProperty(window.performance, "now", { value: () => elapsed });
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
  const calls = [], held = []; let available = false, readCount = 0, releaseReview;
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
      if (scenario === "pending-review" && !releaseReview) await new Promise(resolve => { releaseReview = resolve; });
      if (scenario === "review-failed") return new Response(null, { status: 503 });
      return Response.json({ ...envelope, operation: kind, receipt: currentReview() });
    }
    assert.equal(action, "capture-notes");
    if (["save", "save_status"].includes(kind)) return new Response(null, { status: 503 });
    assert.ok(["prepare", "read"].includes(kind));
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
      : available || readOnly ? note : absent;
    return Response.json({ ...envelope, action: kind, receipt });
  };
  let pendingMatch = scenario === "saved-invalid-dob" ? { key: webcrypto.randomUUID(), expectedVersion: 0, selection: { kind: "confirm_new", dateOfBirth: "9999-01-01" } } : null;
  let matchWrites = 0, matches = 0;
  const host = { signal: lifetime.signal, listEncounters: async () => [encounter], createEncounter: forbidden,
    encounterSetup: { patientCandidates: async () => ({ identity, moreResults: false, patients: [{ patientRef: "patient_" + "01j" + "1".repeat(23), name: "Canonical invented name", dateOfBirth: "1985-02-03" }] }),
      matchPatient: async (_encounter, selection) => { matches++; assert.deepEqual(JSON.parse(JSON.stringify(pendingMatch.selection)), JSON.parse(JSON.stringify(selection))); return { encounter, identity: { ...identity, state: "matched", version: 1, name: "Canonical invented name", dateOfBirth: "1985-02-03" } }; } },
    openEncounter: async () => ({ encounter, scope, signal: encounterLifetime.signal, request, noteOpeningSupported: true,
      openingReview: { scope, receivedAt: window.Date.now(), view: review },
      journal: { load: async () => ({ revision: "1", progress: { admission: null, sessionId: session, uploaded: true, pendingSave: null, pendingPatientMatch: pendingMatch } }), save: async (_previous, progress) => { if (scenario === "retain-failed" && progress.notePreparation?.state === "submitted") throw new Error("Storage unavailable"); if (JSON.stringify(pendingMatch) !== JSON.stringify(progress.pendingPatientMatch ?? null)) { matchWrites++; pendingMatch = progress.pendingPatientMatch ?? null; } return { revision: "2", progress }; } },
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
    const prepareButton = root.querySelector('[data-workspace-action="generate"]');
    click(readOnly ? "check-note" : "generate");
    if (scenario === "pending-review") {
      assert.match(root.querySelector("h1").textContent, /Preparing your draft note/);
      assert.equal(root.querySelector('[data-workspace-action="generate"]'), null);
      prepareButton.click();
      await until(() => releaseReview);
      assert.equal(calls.filter(c => c === "prepare").length, 0);
      assert.equal(calls.filter(c => c === "creator_review").length, 1);
      releaseReview();
    }
    if (["review-failed", "retain-failed"].includes(scenario)) {
      await until(() => !root.hasAttribute("aria-busy") && root.textContent.includes("could not be confirmed"));
      assert.equal(calls.filter(c => c === "prepare").length, 0); assert.equal(readCount, 0);
      assert.equal(root.querySelector("[data-note-readiness]"), null);
      assert.ok(!root.textContent.includes("Writing your visit note"));
      assert.ok(root.querySelector('[data-workspace-action="generate"]')); await advance(120_000);
    } else if (scenario === "lost-reply" || readOnly) {
      await until(fieldsReady);
    } else {
      await until(() => readCount === 1 && !root.hasAttribute("aria-busy"));
      if (["delayed", "expired"].includes(scenario)) {
        assert.match(root.querySelector("[data-note-readiness]").textContent, /automatically/);
        assert.equal(root.querySelector(".provider-note-options").open, false);
        assert.match(root.querySelector("[data-note-wait-time]").textContent, /Checking automatically/);
      }
      if (["delayed", "pending-review"].includes(scenario)) { available = true; await advance(3000); await until(fieldsReady); }
      if (scenario === "expired") {
        await advance(300_000); assert.equal(readCount, 100);
        const count = readCount; await advance(120_000); await visibility(false); await visibility(true);
        assert.equal(readCount, count); assert.match(root.textContent, /Choose Check for note/);
        assert.equal(root.querySelector(".provider-note-options").open, true);
        assert.equal(root.querySelector("[data-note-wait-time]").textContent, "Automatic checking paused.");
        available = true; click("check-note"); await until(fieldsReady);
      }
      if (scenario === "hidden") {
        await until(() => held.length === 1); await visibility(false);
        assert.equal(held[0].signal.aborted, true); await advance(12_000); assert.equal(readCount, 1);
        available = true; await visibility(true); await flush();
        assert.equal(readCount, 1, "Visibility must not overlap a still-settling wire read");
        held[0].resolve(); await flush(); await advance(3000); await until(fieldsReady);
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
        assert.equal(root.querySelector('[data-workspace-action="check-note"]').disabled, true);
        available = true; click("check-note"); await flush();
        assert.equal(readCount, 2, "Timeout must not overlap a still-settling wire read");
        held[0].resolve(); await flush(); click("check-note"); await until(fieldsReady);
        assert.equal(readCount, 3);
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
      const legacyField = root.querySelector('[name="note-1"]');
      assert.equal(legacyField.value, fields[legacyHeading]);
      assert.match(legacyField.closest("label").textContent, /^Deferred examination/);
      assert.equal(legacyField.closest("label").textContent.includes("08/26/2026"), false);
      assert.ok(legacyField.closest("label").textContent.includes("Deferred examination"));
      fieldsReady().value += " Unsubmitted synthetic edit.";
      fieldsReady().dispatchEvent(new window.Event("input", { bubbles: true }));
      assert.equal(root.querySelector("[data-note-save-state]").textContent, "Saving…");
      const count = readCount; await advance(120_000); await visibility(false); await visibility(true);
      assert.equal(readCount, count); assert.match(fieldsReady().value, /Unsubmitted synthetic edit/);
      if (readOnly && scenario !== "read-only") {
        const edited = fieldsReady().value; click("match-patient");
        await until(() => root.querySelector(scenario === "saved-invalid-dob" ? "[data-match-correct]" : "[data-match-new]")?.disabled === false);
        const dob = root.querySelector('[name="match-dob"]'); assert.equal(dob.max, new Date().toISOString().slice(0, 10));
        if (scenario === "saved-invalid-dob") { assert.equal(root.querySelector("[data-match-retry]"), null); root.querySelector("[data-match-correct]").click(); await until(() => root.querySelector("[data-match-new]")?.disabled === false); assert.equal(matchWrites, 1); assert.equal(pendingMatch, null); }
        if (scenario !== "canonical-match") {
          const before = matchWrites; dob.value = "9999-01-01"; root.querySelector("[data-match-new]").click(); await flush();
          assert.equal(matchWrites, before); assert.equal(matches, 0); assert.match(root.querySelector("[data-match-status]").textContent, /valid date/);
          dob.value = ""; root.querySelector("[data-match-new]").click();
        } else { await until(() => root.querySelector("[data-match-patient]")?.disabled === false); root.querySelector("[data-match-patient]").click(); }
        await until(() => !root.querySelector("dialog")); assert.equal(matches, 1);
        assert.equal(root.querySelector("[data-provider-patient-detail]").textContent, "DOB: 1985-02-03");
        assert.match(root.querySelector("[data-provider-encounter]").textContent, /Canonical invented name/);
        assert.equal(fieldsReady().value, edited); assert.equal(root.querySelector('[data-workspace-action="add-dob"]'), null);
      }
    }
    assert.equal(calls.filter(c => c === "prepare").length, readOnly || ["review-failed", "retain-failed"].includes(scenario) ? 0 : 1);
    assert.ok(calls.every(c => ["note-opening", "creator_review", "prepare", "read", "save", "save_status"].includes(c)));
    results.push({ scenario, prepare_calls: calls.filter(c => c === "prepare").length, read_calls: readCount, passed: true });
  } finally { for (const pending of held) pending.resolve(); await dispose(); dom.window.close(); }
}
process.stdout.write(JSON.stringify({ compiled_workspace: true, synthetic_only: true, actual_device: false,
  microphone_calls: 0, save_recovery_checked: true, checks: results.length, results }, null, 2) + "\n");
