// Actual compiled review UI with invented views; no recording, service or storage.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";

const [bundle, jsdomPath] = process.argv.slice(2);
if (!bundle || !jsdomPath) throw new Error("Usage: check-review-note-handoff.mjs creator-review.js jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomPath));
const dom = new JSDOM('<!doctype html><div id="root"></div>', { runScripts: "outside-only" });
const root = dom.window.document.getElementById("root");
const module = new SourceTextModule(await readFile(bundle, "utf8"), { context: dom.getInternalVMContext() });
await module.link(() => { throw new Error("Unexpected external module"); }); await module.evaluate();
const view = version => ({ schema_version: "1.0", session_id: "10000000-0000-4000-8000-000000000001", status: "transcript_ready",
  source: { source_transcript_version: version, segments: [{ source_segment_id: "20000000-0000-4000-8000-000000000002",
    source_segment_version: version, content: "Invented test speech.", source_locale: "en-US", speaker_role: "unknown", start_ms: 0, end_ms: 1000 }] },
  working: { source_transcript_version: version, working_transcript_id: "30000000-0000-4000-8000-000000000003",
    working_transcript_version: version, note_ready: true, blockers: [], segments: [{ source_segment_id: "20000000-0000-4000-8000-000000000002",
      source_segment_version: version, resolution: "english_source", content: "Invented test speech." }] },
  review_queue: { items: [] } });
const pending = { ...view(2), status: "processing", source: null, working: null, review_queue: null };
const button = action => root.querySelector(`[data-review-action="${action}"]`);
const click = action => { const target = button(action); assert.ok(target); assert.equal(target.disabled, false); target.click(); };
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const until = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await turn(); }
  throw new Error("Expected review state did not arrive");
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let checks = 0;
async function check(readNext, exercise) {
  let reads = 0;
  const passed = [];
  const dispose = module.namespace.mountCreatorReview(root, {
    read: async () => ++reads === 1 ? view(1) : readNext(reads),
    decide: async () => { throw new Error("Unexpected decision"); },
  }, { continueToNote: async fresh => { passed.push(fresh); } });
  try {
    await until(() => button("continue"));
    await exercise({ passed, dispose, reads: () => reads }); checks++;
  } finally { dispose(); }
}
try {
  const fresh = view(2), gate = deferred();
  await check(() => gate.promise, async ({ passed, reads }) => {
    click("continue");
    assert.equal(button("continue").disabled, true);
    button("continue").click(); // Disabled repeated taps must not issue more reads.
    assert.equal(reads(), 2);
    gate.resolve(fresh); await until(() => passed.length === 1);
    assert.equal(passed[0], fresh, "The host must receive this action's fresh result, not the displayed snapshot");
    assert.equal(reads(), 2);
  });
  await check(() => pending, async ({ passed }) => {
    click("continue"); await until(() => root.textContent.includes("transcript changed"));
    assert.equal(passed.length, 0); assert.equal(button("continue"), null);
  });
  await check(() => { throw new Error("Invented access failure"); }, async ({ passed }) => {
    click("continue"); await until(() => root.textContent.includes("note could not be opened"));
    assert.equal(passed.length, 0); assert.equal(button("continue"), null);
  });
  const revoked = deferred();
  await check(() => revoked.promise, async ({ passed, dispose }) => {
    click("continue"); dispose(); revoked.resolve(view(2)); await turn();
    assert.equal(passed.length, 0); assert.equal(root.textContent, "");
  });
  const superseded = deferred();
  await check(reads => reads === 2 ? superseded.promise : pending, async ({ passed, reads }) => {
    click("continue"); click("refresh");
    await until(() => root.textContent.includes("Transcribing your recording"));
    superseded.resolve(view(2)); await turn();
    assert.equal(reads(), 3); assert.equal(passed.length, 0);
    assert.equal(button("continue"), null, "A delayed handoff must not override a newer refresh");
  });
  process.stdout.write(JSON.stringify({ checks, compiled_review_ui: true, fresh_same_action_handoff: true,
    readiness_and_access_fail_closed: true, disposal_and_refresh_cancel_late_handoff: true, real_backend: false }) + "\n");
} finally { dom.window.close(); }
