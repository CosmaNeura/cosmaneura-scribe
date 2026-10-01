// Actual compiled review UI; invented names/views, no account, audio or network.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";

const [bundle, jsdomPath, providerBundle] = process.argv.slice(2);
if (!bundle || !jsdomPath || !providerBundle) {
  throw new Error("Usage: check-speaker-name-suggestions.mjs creator-review.js jsdom-module provider-capture.js");
}
const { JSDOM } = await import(pathToFileURL(jsdomPath));
const dom = new JSDOM('<!doctype html><div id="root"></div>', { runScripts: "outside-only", pretendToBeVisual: true });
const window = dom.window, root = window.document.getElementById("root");
Object.assign(window, { TextEncoder, TextDecoder, structuredClone, Headers, Response });
Object.defineProperty(window, "crypto", { value: webcrypto });
window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
window.fetch = () => { throw new Error("No network allowed"); };
const load = async path => {
  const module = new SourceTextModule(await readFile(path, "utf8"), { context: dom.getInternalVMContext() });
  await module.link(() => { throw new Error("Unexpected external dependency"); }); await module.evaluate();
  return module.namespace;
};
const review = await load(bundle);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const view = () => ({ schema_version: "1.0", session_id: id(1), status: "transcript_ready", editing_allowed: true,
  source: { source_transcript_version: 1, segments: [{ source_segment_id: id(2), source_segment_version: 1,
    speaker_id: id(4), speaker_role: "unknown", source_locale: "en-US", content: "Invented speech.", start_ms: 0, end_ms: 1000 }] },
  working: { source_transcript_version: 1, working_transcript_id: id(3), working_transcript_version: 1,
    note_ready: true, blockers: [], segments: [{ source_segment_id: id(2), source_segment_version: 1,
      speaker_role: "unknown", resolution: "english_source", content: "Invented speech." }] },
  review_queue: { schema_version: "1.0", session_id: id(1), source_transcript_version: 1,
    working_transcript_id: id(3), working_transcript_version: 1, status: "complete", items: [] }, review_edits: [] });
const turn = () => new Promise(done => setTimeout(done, 0));
const until = async condition => {
  for (let i = 0; i < 100; i++) { if (condition()) return; await turn(); }
  throw new Error("Expected synthetic review state did not arrive");
};
const button = action => root.querySelector(`[data-review-action="${action}"]`);
const field = name => root.querySelector(`[name="${name}"]`);
const select = value => { field("role").value = value; field("role").dispatchEvent(new window.Event("change", { bubbles: true })); };
let checks = 0;
async function check(suggestions, exercise, initial = view()) {
  const writes = [], saved = [];
  const editJournal = { load: async () => null, save: async value => saved.push(value), clear: async () => undefined };
  const dispose = review.mountCreatorReview(root, {
    read: async () => initial, decide: async () => { throw new Error("Unexpected review decision"); },
    edit: async request => { writes.push(request); return { working_transcript_version: 2 }; },
  }, { editJournal, speakerNameSuggestions: suggestions });
  try {
    await until(() => button("edit")); button("edit").click();
    await exercise({ writes, saved, dispose }); checks++;
  } finally { dispose(); }
}
try {
  await check({ patient: "Fictional Lucía Rivera", clinician: '<img src=x onerror="injected()">' }, async ({ writes, saved }) => {
    assert.equal(root.querySelector("img"), null);
    assert.equal(field("role").value, "unknown"); assert.equal(field("display_name").value, "");
    assert.equal(writes.length, 0); assert.equal(saved.length, 0);
    root.querySelector('[data-speaker-role="patient"]').click();
    assert.equal(field("role").value, "patient"); assert.equal(field("display_name").value, "Fictional Lucía Rivera");
    assert.equal(writes.length, 0); assert.equal(saved.length, 0);
    field("display_name").value = "Fictional manually corrected name";
    button("save-edit").click(); await until(() => writes.length === 1);
    assert.equal(saved.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(writes[0].speakers)), [
      { speaker_id: id(4), role: "patient", display_name: "Fictional manually corrected name", detail: null },
    ]);
  });
  await check({ clinician: "Fictional Avery" }, async ({ writes, saved }) => {
    root.querySelector('[data-speaker-role="clinician"]').click();
    assert.equal(field("role").value, "clinician");
    select("unknown"); assert.equal(field("display_name").disabled, true);
    field("content").value = "Corrected invented wording.";
    button("save-edit").click(); await until(() => writes.length === 1);
    assert.equal(writes[0].speakers.length, 0, "Not sure must not persist the previously suggested name");
    assert.equal(saved.length, 1);
  });
  await check({ patient: "Fictional River" }, async ({ writes, saved }) => {
    select("other"); field("display_name").value = "Fictional manually identified visitor";
    assert.equal(writes.length, 0); button("cancel-edit").click();
    assert.equal(writes.length, 0); assert.equal(saved.length, 0);
    assert.equal(root.querySelector("dialog"), null);
  });
  for (const suggestions of [undefined, { patient: "bad\u0000name", clinician: "x".repeat(121) }, { patient: "bad\ud800name" }]) {
    await check(suggestions, async () => {
      assert.equal(root.querySelectorAll('[data-review-action="use-speaker-name"]').length, 0);
      assert.equal(field("role").options.length, 5, "Manual and Not sure roles remain available");
    });
  }
  let finish;
  const delayed = new Promise(done => { finish = done; });
  const old = review.mountCreatorReview(root, { read: () => delayed, decide: async () => undefined }, {
    speakerNameSuggestions: { patient: "Fictional previous patient" },
  });
  old();
  await check({ patient: "Fictional current patient" }, async ({ writes }) => {
    finish(view()); await turn();
    assert.equal(root.textContent.includes("previous patient"), false);
    assert.ok(root.textContent.includes("current patient")); assert.equal(writes.length, 0);
  });
  // The post-upload capture screen has a separate review mount from reopening.
  // Exercise its actual compiled binding too, without acquiring any recorder.
  const provider = await load(providerBundle), abort = new window.AbortController();
  let posted = 0;
  const snapshot = { state: "complete", sessionId: id(1), elapsedSeconds: 1, recordedChunks: 1, queuedChunks: 0,
    maximumDurationSeconds: 3600, statusCode: "capture_complete" };
  const dispose = provider.mountProviderCapture(root, { sessionId: id(1), captureMode: "native_microphone",
    sourceKind: "microphone", languageMode: "english", signal: abort.signal,
    speakerNameSuggestions: { patient: "Fictional post-upload patient", clinician: "Fictional provider" },
    controller: { snapshot, subscribe: listener => { listener(snapshot); return () => undefined; } },
    authorizedRequest: async (_path, request) => { if (request.method !== "GET") posted++; return Response.json(view()); },
    journal: { load: async () => null }, editJournal: { load: async () => null, save: async () => undefined, clear: async () => undefined },
    deactivate: async () => undefined });
  try {
    await until(() => button("edit")); button("edit").click();
    assert.ok(root.textContent.includes("Fictional post-upload patient"));
    root.querySelector('[data-speaker-role="patient"]').click();
    assert.equal(posted, 0); abort.abort();
    assert.equal(root.textContent.includes("Fictional post-upload patient"), false);
    checks++;
  } finally { dispose(); }
  console.log(JSON.stringify({ checks, compiled_UI: true, explicit_form_choice_only: true,
    account_or_network: false, audio: false, suggestions_not_persisted_before_save: true }));
} finally { dom.window.close(); }
