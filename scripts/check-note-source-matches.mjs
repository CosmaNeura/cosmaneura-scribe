// Exercises compiled product code with invented data; never uses native capture or a service.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";
import { sourceMatchFixture } from "./fixtures/note-source-matches.mjs";

const [providerBundle, navigationBundle, jsdomPath] = process.argv.slice(2);
if (!providerBundle || !navigationBundle || !jsdomPath) throw new Error("Usage: check-note-source-matches.mjs provider.js navigation.js jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomPath));
const providerCode = await readFile(providerBundle, "utf8"), navigationCode = await readFile(navigationBundle, "utf8");
const results = [], forbidden = () => { throw new Error("Unexpected recording, external request or write"); };
async function environment(code, desktop = false) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://scribe-virtual.invalid/",
    runScripts: "outside-only", pretendToBeVisual: true });
  const window = dom.window, root = window.document.getElementById("root");
  Object.defineProperty(window, "crypto", { value: webcrypto });
  Object.assign(window, { Headers, Response, TextEncoder, TextDecoder, structuredClone });
  window.fetch = forbidden; window.matchMedia = () => ({ matches: desktop });
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.scrollTo = (x, y) => { window.scrollX = x; window.scrollY = y; };
  const scrolled = [];
  window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); window.scrollTo(0, 900); };
  const module = new SourceTextModule(code, { context: dom.getInternalVMContext() });
  await module.link(forbidden); await module.evaluate();
  return { dom, window, root, module, scrolled };
}
const until = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(done => setTimeout(done, 5)); }
  throw new Error("Expected synthetic UI state did not arrive");
};
const action = name => `[data-workspace-action="${name}"]`;

for (const desktop of [false, true]) {
  const env = await environment(providerCode, desktop), { dom, window, root, module, scrolled } = env;
  const f = await sourceMatchFixture(), abort = new window.AbortController(), encounterAbort = new window.AbortController();
  let journal = { revision: "1", progress: { admission: null, sessionId: f.session, uploaded: true, pendingSave: null } };
  let currentNote = f.note, finishSave = null, holdSave = false;
  const calls = [], writes = [], coreOpened = [];
  const selected = { scope: f.scope, encounter: f.encounter, signal: encounterAbort.signal, noteOpeningSupported: true,
    openingReview: { scope: f.scope, receivedAt: Date.now(), view: f.review }, recorder: forbidden, openInCore: async noteRef => { coreOpened.push(noteRef); },
    journal: { load: async () => journal, save: async (previous, progress) => {
      assert.equal(previous, journal); writes.push(structuredClone(progress));
      journal = { revision: String(Number(journal.revision) + 1), progress: structuredClone(progress) }; return journal;
    } }, reviewJournal: () => ({ load: async () => null, save: forbidden, clear: forbidden }),
    request: async (path, body, key) => {
      calls.push({ path, body: structuredClone(body), key });
      const envelope = { contract_version: "1", workspace_id: f.scope.workspaceId, binding_ref: f.scope.bindingRef,
        request_nonce: body.request_nonce, checked_at: new Date().toISOString() };
      if (path.endsWith("/note-opening")) return Response.json({ ...envelope, operation: "note_opening",
        receipt: { session_id: f.session, review: f.review, templates: [f.template], note: currentNote } });
      assert.ok(path.endsWith("/capture-notes")); assert.equal(body.action, "save");
      assert.equal(key, journal.progress.pendingSave.edit.client_key);
      assert.deepEqual(structuredClone(body.edit), journal.progress.pendingSave.edit);
      if (holdSave) await new Promise(done => { finishSave = done; });
      currentNote = { ...currentNote, fields: body.edit.fields, note_ref: currentNote.note_ref.slice(0, -1) + "1",
        note_sha256: await f.digest(body.edit.fields) };
      return Response.json({ ...envelope, action: "save", receipt: currentNote });
    } };
  const host = { signal: abort.signal, listEncounters: async () => [f.encounter], createEncounter: forbidden, openEncounter: async () => selected };
  const dispose = module.namespace.mountProviderWorkspace(root, host);
  try {
    await until(() => root.querySelector(action("open")) && root.getAttribute("aria-busy") !== "true");
    root.querySelector(action("open")).click();
    await until(() => root.querySelector('[data-review-action="continue"]')?.disabled === false && root.getAttribute("aria-busy") !== "true");
    root.querySelector('[data-review-action="continue"]').click();
    await until(() => root.querySelectorAll("[data-note-source-match]").length === 2 && root.getAttribute("aria-busy") !== "true");
    const fields = [...root.querySelectorAll("[data-note-field]")], [subjective, assessment, plan] = fields;
    const initialButtons = [...root.querySelectorAll("[data-note-source-match]")];
    assert.deepEqual(initialButtons.map(button => button.textContent), ["Check in transcript · 0:00", "Check in transcript · 3:50"]);
    assert.equal(root.querySelector(action("core")).textContent, "Open saved note in Core");
    assert.ok(initialButtons.every(button => button.closest("label") === null));
    assert.equal(root.querySelector("[data-transcript-evidence]"), null);
    assert.equal(calls.length, 1); assert.equal(writes.length, 0);
    assessment.value += " Unsaved clinician wording."; assessment.dispatchEvent(new window.Event("input", { bubbles: true }));
    assessment.focus(); assessment.setSelectionRange(4, 16, "backward");
    assessment.scrollTop = 31; assessment.scrollLeft = 3; assessment.parentElement.scrollTop = 18; window.scrollTo(2, 123);
    const editedValue = assessment.value, savedValue = assessment.defaultValue, beforeJournal = JSON.stringify(journal);
    const search = root.querySelector("[data-transcript-search]"); search.value = "absent phrase";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    const target = root.querySelector(`[data-transcript-segment="${f.review.source.segments.at(-1).source_segment_id}"]`);
    const pane = root.querySelector("[data-note-transcript-scroll]"), editor = root.querySelector(".provider-note-editor");
    Object.defineProperty(pane, "clientHeight", { value: 400 });
    Object.defineProperty(editor, "clientHeight", { value: 500 });
    pane.getBoundingClientRect = editor.getBoundingClientRect = () => ({ top: 200 });
    target.getBoundingClientRect = () => ({ top: 2200, height: 100 });
    plan.parentElement.getBoundingClientRect = () => ({ top: 800, height: 150 });
    assert.equal(target.hidden, true);
    initialButtons[1].click();
    assert.equal(root.querySelector(".provider-note").dataset.noteView, "transcript");
    assert.equal(root.querySelector(action("transcript-view")).getAttribute("aria-pressed"), "true");
    assert.equal(root.querySelector("[data-note-transcript]").open, true);
    assert.equal(search.value, ""); assert.equal(target.hidden, false); assert.equal(target.dataset.searchCurrent, "true");
    assert.equal(window.document.activeElement, target);
    assert.equal(scrolled.at(-1), root.querySelector(".provider-note-grid"));
    assert.ok(!scrolled.includes(target), "Late transcript row must not scroll the entire page");
    assert.equal(pane.scrollTop, 1850); assert.equal(editor.scrollTop, desktop ? 425 : 0);
    assert.equal(root.querySelector("[data-note-source-back]").parentElement.className, "provider-note-source-toolbar");
    assert.deepEqual([...root.querySelectorAll("[data-note-field]")], fields);
    assert.equal(assessment.value, editedValue); assert.equal(assessment.defaultValue, savedValue);
    assert.equal(root.querySelector("[data-note-save-state]").textContent, "Unsaved edits");
    assert.equal(JSON.stringify(journal), beforeJournal); assert.equal(calls.length, 1); assert.equal(writes.length, 0);
    root.querySelector("[data-note-source-back]").click();
    assert.equal(root.querySelector(".provider-note").dataset.noteView, "note");
    assert.equal(root.querySelector(action("note-view")).getAttribute("aria-pressed"), "true");
    assert.equal(window.document.activeElement, assessment);
    assert.deepEqual([assessment.selectionStart, assessment.selectionEnd, assessment.selectionDirection], [4, 16, "backward"]);
    assert.deepEqual([assessment.scrollTop, assessment.scrollLeft, assessment.parentElement.scrollTop, window.scrollX, window.scrollY], [31, 3, 18, 2, 123]);
    assert.equal(editor.scrollTop, 0, "The original editor pane scroll is restored");
    assert.equal(assessment.value, editedValue); assert.equal(JSON.stringify(journal), beforeJournal);
    root.querySelector(action("core")).click();
    await until(() => coreOpened.length === 1 && root.getAttribute("aria-busy") !== "true");
    assert.deepEqual(coreOpened, [f.note.note_ref], "Core opens the saved note reference, not unsaved editor contents");
    assert.deepEqual([...root.querySelectorAll("[data-note-field]")], fields);
    assert.equal(assessment.value, editedValue); assert.equal(JSON.stringify(journal), beforeJournal);
    assert.equal(calls.length, 1); assert.equal(writes.length, 0);
    results.push({ desktop, check: "matched row, search, unchanged dirty editor/journal, caret and scroll return", passed: true });

    plan.value += " Edited."; plan.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(initialButtons[1].parentElement.hidden, true); assert.equal(initialButtons[1].disabled, true);
    const jumps = scrolled.length; initialButtons[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    assert.equal(scrolled.length, jumps);
    plan.value = plan.defaultValue; plan.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(initialButtons[1].disabled, false); assert.equal(initialButtons[1].parentElement.hidden, false);
    plan.value += " Programmatic change without input."; initialButtons[1].click(); assert.equal(scrolled.length, jumps);
    plan.value = plan.defaultValue; plan.dispatchEvent(new window.Event("input", { bubbles: true }));
    // No parsing/remount on ordinary input: the exact existing match nodes survive.
    assert.deepEqual([...root.querySelectorAll("[data-note-source-match]")], initialButtons);
    results.push({ desktop, check: "target edit invalidation and exact undo without reparsing/remount", passed: true });

    // Existing navigation guard is still the only route out of a dirty note.
    root.querySelector(action("encounters")).click();
    await until(() => root.querySelector("dialog")?.open && root.getAttribute("aria-busy") !== "true");
    assert.deepEqual([...root.querySelectorAll("[data-note-field]")], fields); assert.equal(calls.length, 1); assert.equal(writes.length, 0);
    root.querySelector(action("keep-editing")).click();
    await until(() => !root.querySelector("dialog") && root.getAttribute("aria-busy") !== "true");
    assessment.value = subjective.value; assessment.dispatchEvent(new window.Event("input", { bubbles: true }));
    assessment.focus(); assessment.setSelectionRange(5, 8); holdSave = true;
    root.querySelector(action("save")).click(); await until(() => finishSave);
    const pending = JSON.stringify(journal), writeCount = writes.length, callCount = calls.length;
    assert.equal(assessment.readOnly, true); initialButtons[1].click(); root.querySelector("[data-note-source-back]").click();
    assert.equal(JSON.stringify(journal), pending); assert.equal(writes.length, writeCount); assert.equal(calls.length, callCount);
    assert.equal(assessment.readOnly, true); assert.equal(assessment.selectionStart, 5);
    finishSave(); await until(() => root.querySelectorAll("[data-note-source-match]").length === 3 && journal.progress.pendingSave === null
      && root.getAttribute("aria-busy") !== "true");
    assert.deepEqual([...root.querySelectorAll("[data-note-field]")], fields);
    assert.equal(assessment.value, subjective.value); assert.equal(assessment.defaultValue, subjective.value);
    assert.equal(assessment.selectionStart, 5); assert.equal(root.querySelector("[data-note-save-state]").textContent, "Saved · Not clinically reviewed");
    assert.equal(initialButtons[0].isConnected, false); assert.equal(initialButtons[1].isConnected, false);
    const savedJumps = scrolled.length; initialButtons[1].click(); assert.equal(scrolled.length, savedJumps);
    results.push({ desktop, check: "pending save unchanged by reading; confirmed save refreshes only links", passed: true });

    const oldButton = root.querySelector("[data-note-source-match]");
    encounterAbort.abort(); await until(() => !root.querySelector("[data-note-field]"));
    oldButton.click(); assert.equal(scrolled.length, savedJumps); assert.equal(root.querySelector("[data-note-field]"), null);
    results.push({ desktop, check: "authorization loss disposes all reading shortcuts", passed: true });
  } finally { finishSave?.(); await dispose(); dom.window.close(); }
}

// Directly compiled binder: mutation/replacement of its already validated paired
// inputs must not leave a stale shortcut operable between normal UI refreshes.
for (const fault of ["note-ref", "note-hash", "note-status", "note-source-id", "note-transcript-ref", "field-order", "saved-field", "working-wording", "working-resolution", "working-role", "schema", "source-hash", "draft-source", "working-version", "source-version", "segment-version", "working-segment-version", "timestamp", "source-refresh",
  "working-id", "continuity", "draft-replaced", "view-replaced", "owner-revoked", "detached", "button-detached", "disabled", "value", "default-value", "row-duplicate", "row-missing"]) {
  const { dom, window, root, module, scrolled } = await environment(navigationCode);
  const f = await sourceMatchFixture(); let pair = { draft: f.note, view: f.review }, reveals = 0;
  root.innerHTML = '<div class="provider-note-editor"><label>Plan<textarea data-note-field name="note-0"></textarea></label></div><aside class="provider-note-evidence"><details data-note-transcript><div data-transcript-surface><input data-transcript-search><ol><li tabindex="-1" data-transcript-segment></li></ol></div></details></aside>';
  pair.draft.field_order = ["Plan"]; pair.draft.fields = { Plan: f.note.fields.Plan };
  const field = root.querySelector("textarea"); field.defaultValue = pair.draft.fields.Plan;
  const row = root.querySelector("li"); row.dataset.transcriptSegment = f.review.source.segments.at(-1).source_segment_id;
  const binding = module.namespace.bindNoteSourceNavigation(root, { current: () => pair,
    revealTranscript: () => { reveals++; }, returnToNote: forbidden });
  const button = root.querySelector("[data-note-source-match]"); assert.ok(button);
  if (fault === "note-ref") pair.draft.note_ref += "1";
  if (fault === "note-hash") pair.draft.note_sha256 = "b".repeat(64);
  if (fault === "note-status") pair.draft.status = "not_prepared";
  if (fault === "note-source-id") pair.draft.scribe_source_id = f.session;
  if (fault === "note-transcript-ref") pair.draft.transcript_ref += "1";
  if (fault === "field-order") pair.draft.field_order = ["Changed"];
  if (fault === "saved-field") pair.draft.fields.Plan += " Altered saved baseline.";
  if (fault === "working-wording") pair.view.working.segments.at(-1).content += " Altered wording.";
  if (fault === "working-resolution") pair.view.working.segments.at(-1).resolution = "unresolved";
  if (fault === "working-role") pair.view.working.segments.at(-1).speaker_role = "patient";
  if (fault === "schema") pair.draft.schema_ref += "1";
  if (fault === "source-hash") pair.draft.source_sha256 = "b".repeat(64);
  if (fault === "draft-source") pair.draft.reviewed_source.working_version++;
  if (fault === "working-version") pair.view.working.working_transcript_version++;
  if (fault === "source-version") pair.view.source.source_transcript_version++;
  if (fault === "segment-version") pair.view.source.segments.at(-1).source_segment_version++;
  if (fault === "working-segment-version") pair.view.working.segments.at(-1).source_segment_version++;
  if (fault === "timestamp") pair.view.source.segments.at(-1).start_ms++;
  if (fault === "source-refresh") {
    pair.view.working.working_transcript_version++; pair.draft.reviewed_source.working_version++;
    binding.refresh(); assert.equal(root.querySelector("[data-note-source-match]"), null);
  }
  if (fault === "working-id") pair.view.working.working_transcript_id = f.session;
  if (fault === "continuity") pair.view.capture_continuity = { invalid: true };
  if (fault === "draft-replaced") pair = { ...pair, draft: structuredClone(pair.draft) };
  if (fault === "view-replaced") pair = { ...pair, view: structuredClone(pair.view) };
  if (fault === "owner-revoked") pair = null;
  if (fault === "detached") root.remove();
  if (fault === "button-detached") button.remove();
  if (fault === "disabled") button.disabled = true;
  if (fault === "value") field.value += " Unsaved.";
  if (fault === "default-value") field.defaultValue += " Changed baseline.";
  if (fault === "row-duplicate") row.after(row.cloneNode(true));
  if (fault === "row-missing") row.remove();
  button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(reveals, 0, fault); assert.equal(scrolled.length, 0, fault);
  binding.dispose(); dom.window.close(); results.push({ check: `stale/unsafe ${fault}`, passed: true });
}
process.stdout.write(JSON.stringify({ synthetic_only: true, source_started: false, external_requests: 0, checks: results.length, results }, null, 2) + "\n");
