// Actual compiled review UI with invented views; no recording, service or storage.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";

const [bundle, jsdomPath] = process.argv.slice(2);
if (!bundle || !jsdomPath) throw new Error("Usage: check-review-note-handoff.mjs creator-review.js jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomPath));
const dom = new JSDOM('<!doctype html><div id="root"></div>', { runScripts: "outside-only", pretendToBeVisual: true });
const root = dom.window.document.getElementById("root");
Object.assign(dom.window, { TextEncoder, TextDecoder, structuredClone });
const timers = new Map();
let nextTimer = 0, visibility = "visible";
dom.window.setTimeout = (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; };
dom.window.clearTimeout = id => timers.delete(id);
Object.defineProperty(dom.window.document, "visibilityState", { get: () => visibility });
const show = value => { visibility = value; dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); };
const tick = () => {
  assert.equal(timers.size, 1, "Only one processing read may be scheduled");
  const [id, { callback, delay }] = [...timers][0];
  assert.equal(delay, 3000); timers.delete(id); callback();
};
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
  } finally { dispose(); assert.equal(timers.size, 0); }
}
async function processing(readNext, exercise, journal) {
  let reads = 0;
  const passed = [];
  const dispose = module.namespace.mountCreatorReview(root, {
    read: async () => readNext(++reads),
    decide: async () => { throw new Error("Automatic refresh must not submit a decision"); },
  }, { journal, continueToNote: async fresh => { passed.push(fresh); } });
  try {
    await until(() => button("refresh")?.disabled === false || root.textContent.includes("previous decision"));
    await exercise({ reads: () => reads, passed, dispose }); checks++;
  } finally { dispose(); assert.equal(timers.size, 0); show("visible"); }
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
  const pollGate = deferred();
  await processing(reads => reads === 1 ? { ...pending, status: "uploaded" } : reads === 2 ? pollGate.promise : view(2),
    async ({ reads, passed }) => {
      assert.ok(root.textContent.includes("appear here automatically"));
      const before = root.innerHTML;
      tick(); assert.equal(reads(), 2); assert.equal(root.innerHTML, before, "Polling must not flash a loading screen");
      click("refresh"); assert.equal(reads(), 2, "Manual and automatic refresh must not overlap");
      assert.equal(timers.size, 0);
      pollGate.resolve(pending); await until(() => timers.size === 1);
      tick(); await until(() => button("continue"));
      assert.equal(reads(), 3); assert.equal(passed.length, 0, "Ready must not automatically open or prepare a note");
      assert.equal(timers.size, 0, "Ready transcripts must stop polling");
    });
  const hiddenGate = deferred();
  await processing(reads => reads === 1 ? pending : hiddenGate.promise, async ({ reads, dispose }) => {
    show("hidden"); assert.equal(timers.size, 0); assert.equal(reads(), 1);
    show("visible"); assert.equal(reads(), 2, "Returning to the screen checks current progress immediately");
    show("hidden"); show("visible"); assert.equal(reads(), 2, "Visibility changes cannot overlap pending reads");
    dispose(); hiddenGate.resolve(view(2)); await turn();
    assert.equal(root.textContent, ""); assert.equal(timers.size, 0, "Late replies cannot restore a disposed encounter");
    show("visible"); assert.equal(reads(), 2, "Disposal removes the visibility listener");
  });
  await processing(reads => {
    if (reads === 2) throw new Error("Invented access failure; never show raw error details");
    return reads === 1 ? pending : view(2);
  }, async ({ reads }) => {
    tick(); await until(() => root.textContent.includes("recording is unavailable"));
    assert.equal(timers.size, 0); show("hidden"); show("visible"); assert.equal(reads(), 2);
    assert.ok(!root.textContent.includes("raw error"));
    click("refresh"); await until(() => button("continue")); assert.equal(reads(), 3);
  });
  for (const status of ["created", "capturing", "speech_retryable", "speech_failed", "translation_pending", "quality_blocked", "review_required", "handed_off"]) {
    await processing(() => ({ ...pending, status }), async ({ reads }) => {
      assert.equal(timers.size, 0, `${status} needs an explicit action, not automatic transcription recovery`);
      show("hidden"); show("visible"); assert.equal(reads(), 1);
    });
  }
  const manualGate = deferred();
  await processing(reads => reads === 1 ? pending : manualGate.promise, async ({ reads }) => {
    click("refresh"); assert.equal(reads(), 2); assert.equal(timers.size, 0);
    manualGate.resolve(pending); await until(() => timers.size === 1);
  });
  const savedDecision = { key: "review-invented-pending", request: { schema_version: "1.0",
    expected_source_transcript_version: 1, source_segment_id: "20000000-0000-4000-8000-000000000002",
    expected_source_segment_version: 1, translation_id: "40000000-0000-4000-8000-000000000004",
    expected_translation_version: 1, decision: "accepted" } };
  await processing(() => pending, async ({ reads }) => {
    assert.ok(button("retry")); assert.equal(timers.size, 0);
    show("hidden"); show("visible"); assert.equal(reads(), 1);
  }, { load: async () => savedDecision });
  process.stdout.write(JSON.stringify({ checks, compiled_review_ui: true, fresh_same_action_handoff: true,
    readiness_and_access_fail_closed: true, disposal_and_refresh_cancel_late_handoff: true,
    visible_processing_auto_refresh: true, single_flight_no_automatic_writes: true, real_backend: false }) + "\n");
} finally { dom.window.close(); }
