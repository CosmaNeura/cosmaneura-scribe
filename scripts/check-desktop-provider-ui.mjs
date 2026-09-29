// Compiled provider DOM and fixed recorder bridge. All data, consent, responses
// and recorder states are invented; no Electron, native audio or service runs.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";
const [bundle, jsdomPath] = process.argv.slice(2);
if (!bundle || !jsdomPath) throw new Error("Usage: check-desktop-provider-ui.mjs provider-capture.js jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomPath));
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "app://cosmas/provider.html", runScripts: "outside-only", pretendToBeVisual: true });
const window = dom.window, root = window.document.getElementById("root");
Object.defineProperty(window, "crypto", { value: webcrypto });
Object.assign(window, { Headers, Response, TextEncoder, TextDecoder, structuredClone });
window.fetch = () => { throw new Error("Unexpected renderer network"); };
const module = new SourceTextModule(await readFile(bundle, "utf8"), { context: dom.getInternalVMContext() });
await module.link(() => { throw new Error("Unexpected external module"); }); await module.evaluate();
const sessionId = "10000000-0000-4000-8000-000000000001";
const scope = { workspaceId: "20000000-0000-4000-8000-000000000002",
  bindingRef: "scribe_capture_binding_01j00000000000000000000000", appointmentRef: "appointment_01j00000000000000000000000" };
const until = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("Expected desktop provider view did not arrive");
};
const button = id => root.querySelector(`[data-testid="${id}"]`);
function fixture() {
  const abort = new window.AbortController(), recorderId = webcrypto.randomUUID(), listeners = new Set(), calls = [];
  let sequence = 0, reviewStatus = "created", holdStart = null, failStop = false, saved = null, failUpload = false;
  let retryCalls = 0, finishFirstRetry;
  let snapshot = { sessionId, state: "ready", statusCode: "capture_ready", recordedChunks: 0, queuedChunks: 3, elapsedSeconds: 0,
    remainingBudgetSeconds: 30, remainingAuthoritySeconds: 30, transcriptionStatus: null, transcript: null,
    desktop: { phase: "ready", coverage: "not_started", trimmedStartMs: 0, trimmedEndMs: null } };
  const state = () => structuredClone({ recorderId, revision: sequence, snapshot });
  const change = (fields, desktop) => {
    snapshot = { ...snapshot, ...fields, desktop: { ...snapshot.desktop, ...desktop } }; sequence++;
    for (const listener of listeners) listener(state());
  };
  const port = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async request(command) {
      assert.deepEqual(Object.keys(command).sort(), ["kind", "recorderId", "requestId"]);
      calls.push(command.kind); let ok = true;
      if (command.kind !== "read") assert.equal(command.recorderId, recorderId);
      if (command.kind === "start") {
        change({ state: "recording" }, { phase: "starting" });
        if (holdStart) await holdStart.promise;
        else change({ recordedChunks: 2 }, { phase: "recording", coverage: "aligned", trimmedStartMs: 4 });
      } else if (command.kind === "stop") {
        if (holdStart) {
          change({ state: "paused" }, { phase: "interrupted", coverage: "incomplete" }); holdStart.resolve();
        } else if (failStop) {
          ok = false; failStop = false;
          change({ state: "paused" }, { phase: "stop_unconfirmed", coverage: "incomplete" });
        } else if (failUpload) {
          ok = false;
          change({ state: "uploading", statusCode: "capture_upload_pending" }, { phase: "stopped", coverage: "complete" });
        } else {
          reviewStatus = "processing";
          change({ state: "processing" }, { phase: "stopped", coverage: "incomplete" });
        }
      } else if (command.kind === "resume") {
        assert.equal(snapshot.state, "uploading"); assert.equal(snapshot.desktop.phase, "stopped");
        retryCalls++;
        if (retryCalls === 1) { await new Promise(resolve => { finishFirstRetry = resolve; }); ok = false; }
        else { reviewStatus = "processing"; change({ state: "processing", statusCode: "capture_processing" }, {}); }
      }
      return { requestId: command.requestId, ok, state: command.kind === "deactivate" ? null : state() };
    },
  };
  const host = { signal: abort.signal,
    async listEncounters() { return [{ appointmentRef: scope.appointmentRef, title: "Invented desktop visit", detail: "Invented all-party consent" }]; },
    async createEncounter() { throw new Error("No Core creation in this check"); },
    async openEncounter() {
      return { encounter: (await host.listEncounters())[0], scope, signal: abort.signal,
        async request(_path, body) {
          assert.equal(body.operation.kind, "creator_review");
          return Response.json({ ...body, contract_version: "1", checked_at: new Date().toISOString(), operation: "creator_review",
            receipt: { schema_version: "1.0", session_id: sessionId, status: reviewStatus, source: null, working: null, review_queue: null } });
        }, journal: { async load() { return saved ?? { revision: "1", progress: { sessionId, uploaded: false, pendingSave: null,
          admission: { key: webcrypto.randomUUID(), languageMode: "en-US+es-US", attestation: { modality: "virtual", participant_regions: ["US-NY"],
            method: "verbal_attestation", all_parties_consented: true, granted_at: new Date().toISOString() } } } }; },
        async save(_previous, progress) { saved = { revision: "2", progress }; return saved; } },
        reviewJournal: () => ({ async load() { return null; }, async save() { throw new Error("No review decision in this check"); }, async clear() {} }),
        recorder: id => module.namespace.connectDesktopRecorderView(port, id, abort.signal),
        async openInCore() { throw new Error("No navigation in this check"); } };
    },
  };
  return { host, abort, calls, listeners, change,
    hold() { let resolve; const promise = new Promise(done => { resolve = done; }); holdStart = { promise, resolve }; },
    failStop() { failStop = true; }, failUpload() { failUpload = true; }, finishFirstRetry() { finishFirstRetry(); } };
}
let checks = 0;
async function open(f) {
  const dispose = module.namespace.mountProviderWorkspace(root, f.host);
  await until(() => root.querySelector('[data-workspace-action="open"]'));
  root.querySelector('[data-workspace-action="open"]').click();
  await until(() => button("record-button")); return dispose;
}
try {
  const f = fixture(); f.hold(); let dispose = await open(f);
  try {
    assert.match(root.textContent, /selected application’s audio/u); assert.doesNotMatch(root.textContent, /Keep this app in the foreground/u);
    button("record-button").click(); await until(() => /Starting microphone/u.test(root.textContent));
    assert.equal(button("stop-button").disabled, false); assert.match(button("stop-button").textContent, /Cancel start/u);
    button("stop-button").click(); await until(() => /Recording interrupted/u.test(root.textContent));
    assert.deepEqual(f.calls.slice(0, 3), ["read", "start", "stop"]); checks++;
  } finally { await dispose(); }
  const expired = fixture(); dispose = await open(expired);
  try {
    expired.change({ state: "paused", statusCode: "capture_setup_expired", remainingAuthoritySeconds: 0 },
      { phase: "interrupted", coverage: "not_started" });
    await until(() => /Recording setup expired before any audio was saved/u.test(root.textContent));
    assert.doesNotMatch(root.textContent, /Recording interrupted/u);
    assert.equal(button("record-button").disabled, true);
    assert.equal(button("resume-recording").disabled, false);
    assert.deepEqual(expired.calls, ["read"]); checks++;
    expired.change({ statusCode: "capture_authority_expired" }, { coverage: "incomplete" });
    await until(() => /Recording interrupted/u.test(root.textContent));
    assert.doesNotMatch(root.textContent, /Recording setup expired before any audio was saved/u);
    assert.equal(button("stop-button").disabled, false); checks++;
  } finally { await dispose(); }
  const g = fixture(); dispose = await open(g);
  try {
    button("record-button").click(); await until(() => /audio are aligned/u.test(root.textContent));
    assert.match(root.textContent, /first 4 ms/u); g.failStop(); button("stop-button").click();
    await until(() => /stop is unconfirmed/u.test(root.textContent));
    assert.equal(button("record-button").disabled, true); assert.equal(button("stop-button").disabled, false);
    assert.equal(button("retry-upload"), null);
    button("stop-button").click(); await until(() => /Recording uploaded/u.test(root.textContent));
    assert.ok(root.querySelector("[data-provider-review]")); assert.match(root.textContent, /coverage is incomplete/u);
    checks++;
    g.abort.abort(); assert.equal(root.textContent.includes("Invented desktop visit"), false);
    await until(() => g.calls.includes("deactivate")); assert.equal(g.listeners.size, 0); checks++;
  } finally { await dispose(); }
  const retry = fixture(); retry.failUpload(); dispose = await open(retry);
  try {
    button("record-button").click(); await until(() => /audio are aligned/u.test(root.textContent));
    button("stop-button").click(); await until(() => button("retry-upload") && !button("retry-upload").disabled);
    assert.match(root.textContent, /saved recording is waiting for upload confirmation/u);
    assert.equal(button("record-button").disabled, true); assert.equal(button("stop-button").disabled, true);
    button("retry-upload").click();
    await until(() => retry.calls.filter(v => v === "resume").length === 1 && button("retry-upload").disabled);
    retry.finishFirstRetry(); await until(() => !button("retry-upload").disabled);
    button("retry-upload").click(); await until(() => /Recording uploaded/u.test(root.textContent));
    assert.deepEqual(retry.calls.slice(0, 5), ["read", "start", "stop", "resume", "resume"]);
    assert.equal(button("retry-upload"), null); assert.ok(root.querySelector("[data-provider-review]"));
    checks++;
  } finally { await dispose(); }
  process.stdout.write(JSON.stringify({ checks, compiled_provider_workspace: true, desktop_command_view: true,
    startup_cancel: true, expired_setup_recovery: true, real_interruption_preserved: true,
    stop_retry_and_review: true, upload_retry_and_review: true, immediate_revocation_clear: true,
    actual_electron: false, physical_recording: false }) + "\n");
} finally { dom.window.close(); }
