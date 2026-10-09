// Compiled workspace plus the actual desktop bootstrap; invented data and a
// counted fixed app-close action. No Electron, native helper, audio or service starts.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";
import { sourceMatchFixture } from "./fixtures/note-source-matches.mjs";

const [bundle, jsdomPath] = process.argv.slice(2);
if (!bundle || !jsdomPath) throw new Error("Usage: check-desktop-close.mjs provider.js jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomPath));
const dom = new JSDOM('<!doctype html><main id="scribe-provider"></main>', {
  url: "app://cosmas/provider.html", runScripts: "outside-only", pretendToBeVisual: true,
});
const window = dom.window, root = window.document.getElementById("scribe-provider");
Object.defineProperty(window, "crypto", { value: webcrypto });
Object.assign(window, { Headers, Response, TextEncoder, TextDecoder, structuredClone });
const forbidden = () => { throw new Error("Unexpected recording, external request or write"); };
window.fetch = forbidden; window.matchMedia = () => ({ matches: true });
window.ResizeObserver = class { observe() {} disconnect() {} };
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; };
window.scrollTo = () => {};
const destroyDOM = window.close.bind(window);
let closes = 0; window.close = forbidden;
window.scribeApplication = { close: async () => { closes++; } };
const f = await sourceMatchFixture(), revision = webcrypto.randomUUID();
const connectionId = webcrypto.randomUUID(), encounterId = webcrypto.randomUUID();
let journal = { revision: "1", progress: { admission: null, sessionId: f.session, uploaded: true, pendingSave: null } };
let currentNote = f.note, events, heldJournal, releaseJournal, rejectSave = false;
const writes = [], requests = [], sourceStarts = [];
const readCore = async (path, body, key) => {
  requests.push({ path, body: structuredClone(body), key });
  const envelope = { contract_version: "1", workspace_id: f.scope.workspaceId, binding_ref: f.scope.bindingRef,
    request_nonce: body.request_nonce, checked_at: new Date().toISOString() };
  if (path.endsWith("/note-opening")) return { ...envelope, operation: "note_opening",
    receipt: { session_id: f.session, review: f.review, templates: [f.template], note: currentNote } };
  assert.ok(path.endsWith("/capture-notes"));
  if (body.action === "check_save") throw new Error("Invented offline save check");
  assert.equal(body.action, "save");
  assert.equal(key, journal.progress.pendingSave.edit.client_key);
  assert.deepEqual(structuredClone(body.edit), journal.progress.pendingSave.edit);
  if (rejectSave) throw new Error("Invented lost save response");
  currentNote = { ...currentNote, fields: body.edit.fields,
    note_ref: currentNote.note_ref.slice(0, -1) + "1", note_sha256: await f.digest(body.edit.fields) };
  return { ...envelope, action: "save", receipt: currentNote };
};
window.scribeProvider = { subscribe: listener => { events = listener; return () => {}; }, request: async request => {
  let result;
  switch (request.method) {
    case "session_read": result = { phase: "ready", revision }; break;
    case "connect": result = { connectionId, revision }; break;
    case "list": result = [f.encounter]; break;
    case "encounter_setup": result = { enabled: false, account: null }; break;
    case "open": result = { encounterId, encounter: f.encounter, scope: f.scope,
      openingReview: { scope: f.scope, receivedAt: Date.now(), view: f.review }, noteOpeningSupported: true }; break;
    case "journal_load": result = structuredClone(journal); break;
    case "journal_save": {
      const progress = structuredClone(request.payload.progress);
      if (heldJournal) await new Promise(done => { releaseJournal = done; });
      writes.push(progress); journal = { revision: String(Number(journal.revision) + 1), progress }; result = structuredClone(journal); break;
    }
    case "review_load": case "edit_load": result = null; break;
    case "core": result = { status: 200, body: await readCore(request.payload.path, request.payload.body, request.payload.key) }; break;
    case "disconnect": case "cancel": case "close": result = null; break;
    default: forbidden();
  }
  return { requestId: request.requestId, ok: true, result };
} };
window.scribeRecorder = { subscribe: () => () => {}, request: value => { sourceStarts.push(value); return forbidden(); } };
const context = dom.getInternalVMContext();
const provider = new SourceTextModule(await readFile(bundle, "utf8"), { context });
await provider.link(forbidden); await provider.evaluate();
const bootstrap = new SourceTextModule(await readFile(new URL("../apps/desktop-companion/standalone/desktop-start.js", import.meta.url), "utf8"), { context });
await bootstrap.link(specifier => { assert.equal(specifier, "./provider-capture.js"); return provider; });
await bootstrap.evaluate();
const until = async predicate => {
  for (let i = 0; i < 250; i++) {
    if (predicate() && root.querySelector(".provider-workspace")?.getAttribute("aria-busy") !== "true") return;
    await new Promise(done => setTimeout(done, 5));
  }
  throw new Error(`Synthetic desktop state did not arrive: ${root.textContent}`);
};
const action = name => `[data-workspace-action="${name}"]`;
const click = selector => { const button = root.querySelector(selector); assert.ok(button); assert.equal(button.disabled, false); button.click(); };
const edit = value => {
  const field = root.querySelector("[data-note-field]"); field.value = value;
  field.dispatchEvent(new window.Event("input", { bubbles: true })); return field;
};
const openNote = async () => {
  click(action("open")); await until(() => root.querySelector('[data-review-action="continue"]')?.disabled === false);
  click('[data-review-action="continue"]'); await until(() => root.querySelector("[data-note-field]"));
};
const checks = [];
try {
  await until(() => root.querySelector(action("open")));
  const close = root.querySelector(".scribe-desktop-close"); assert.equal(close.textContent, "Close Scribe");
  close.click(); assert.equal(closes, 1); assert.equal(requests.length, 0); assert.equal(writes.length, 0);
  checks.push("idle close invokes only fixed app-close action with no writes or recording");
  await openNote();
  close.click(); assert.equal(closes, 2); assert.equal(writes.length, 0);
  checks.push("unchanged note closes without an unnecessary discard prompt");
  const field = edit("Synthetic unsaved note edit."); field.focus(); field.setSelectionRange(4, 11);
  const beforeRequests = requests.length;
  close.click(); await until(() => root.querySelector("dialog")?.open);
  assert.equal(closes, 2); assert.equal(root.querySelector("[data-note-field]"), field);
  assert.equal(field.value, "Synthetic unsaved note edit."); assert.equal(writes.length, 0); assert.equal(requests.length, beforeRequests);
  click(action("keep-editing")); await until(() => !root.querySelector("dialog"));
  assert.equal(closes, 2); assert.equal(window.document.activeElement, field);
  assert.deepEqual([field.selectionStart, field.selectionEnd], [4, 11]);
  checks.push("dirty close reuses keep-editing dialog and retains exact editor and caret without writing");
  close.click(); await until(() => root.querySelector("dialog")?.open);
  root.querySelector("dialog").dispatchEvent(new window.Event("cancel", { cancelable: true }));
  assert.equal(root.querySelector("dialog"), null); assert.equal(closes, 2); assert.equal(field.value, "Synthetic unsaved note edit.");
  checks.push("Escape cancels closing and retains unsaved edits");
  close.click(); await until(() => root.querySelector("dialog")?.open);
  click(action("discard-edits")); await until(() => closes === 3);
  assert.equal(writes.length, 0); assert.equal(currentNote, f.note);
  checks.push("explicit discard closes without saving or modifying the saved note");
  // The counted close deliberately leaves this synthetic renderer alive.
  close.click(); await until(() => root.querySelector("dialog")?.open);
  click(action("save-and-leave")); await until(() => closes === 4);
  assert.equal(journal.progress.pendingSave, null); assert.equal(currentNote.fields.Subjective, field.value);
  assert.equal(writes.length, 2); assert.equal(field.value, field.defaultValue);
  checks.push("Save and continue closes only after the exact journaled save is confirmed");
  edit("Synthetic save still entering the journal."); heldJournal = true; click(action("save"));
  for (let i = 0; i < 200 && !releaseJournal; i++) await new Promise(done => setTimeout(done, 5));
  assert.ok(releaseJournal); close.click();
  assert.equal(closes, 4); assert.equal(journal.progress.pendingSave, null);
  assert.ok(root.textContent.includes("Your note edits are still being saved."));
  heldJournal = false; rejectSave = true; releaseJournal(); releaseJournal = null;
  await until(() => journal.progress.pendingSave && root.querySelector('[data-workspace-action="resolve"]'));
  const pending = JSON.stringify(journal), beforeCloseWrites = writes.length;
  close.click(); assert.equal(closes, 5); assert.equal(JSON.stringify(journal), pending); assert.equal(writes.length, beforeCloseWrites);
  checks.push("unjournaled save blocks close; lost-response pending save closes without losing edits or replaying save");
  events({ kind: "session", state: { phase: "signedOut", revision: webcrypto.randomUUID() } });
  await until(() => !root.querySelector("[data-note-field]"));
  assert.equal(root.querySelector("dialog"), null); close.click(); assert.equal(closes, 6);
  assert.equal(sourceStarts.length, 0);
  checks.push("access revocation clears the editor and close remains available");
  console.log(JSON.stringify({ synthetic_only: true, actual_bootstrap: true, actual_compiled_workspace: true,
    actual_electron: false, source_started: false, passed: checks.length, checks }, null, 2));
} finally { releaseJournal?.(); destroyDOM(); }
