// Actual compiled workspace and desktop renderer; all I/O is an offline fixture.
// No native source, microphone, credentials, external service or key operation.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";
const [bundle, jsdomPath] = process.argv.slice(2);
if (!bundle || !jsdomPath) throw new Error("Usage: check-provider-opening-ui.mjs bundle jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomPath));
const code = await readFile(bundle, "utf8"), id = "01j" + "0".repeat(23);
const scope = { workspaceId: webcrypto.randomUUID(), appointmentRef: "appointment_" + id, bindingRef: "scribe_capture_binding_" + id };
const sessionId = webcrypto.randomUUID(), otherSession = webcrypto.randomUUID();
const encounter = { appointmentRef: scope.appointmentRef, title: "Synthetic opening test", detail: "Invented fixture" };
const view = (status = "uploaded", session = sessionId) => ({ schema_version: "1.0", session_id: session, status,
  source: null, working: null, review_queue: null, translation_progress: [] });
const progress = { admission: null, sessionId, uploaded: true, pendingSave: null };
const pendingSave = { schema: "doctor_note_schema_" + id, source: { kind: "reviewed_english", source_version: 1,
  working_transcript_id: webcrypto.randomUUID(), working_version: 1 }, fieldOrder: ["Plan"], edit: {
  client_key: webcrypto.randomUUID(), expected_note_ref: "visit_note_" + id, expected_note_sha256: "a".repeat(64),
  expected_source_sha256: "b".repeat(64), fields: { Plan: "Invented retained edit" } } };
const admission = { key: webcrypto.randomUUID(), languageMode: "en-US", attestation: { modality: "in_person",
  participant_regions: ["US-NY"], method: "verbal_attestation", all_parties_consented: true, granted_at: new Date().toISOString() } };
const forbidden = () => { throw new Error("Unrequested source, credential, mutation or external I/O"); };
const scenarios = [
  { name: "new", opening: null, text: "Prepare recording", calls: 0 },
  { name: "recovered-review", opening: view(), text: "Recording uploaded", calls: 0, refresh: true },
  { name: "saved-review", opening: view(), progress, text: "Recording uploaded", calls: 0, refresh: true },
  { name: "stale", opening: view(), progress, age: 6000, text: "Recording uploaded", calls: 1 },
  { name: "other-session", opening: view("uploaded", otherSession), progress, text: "Recording uploaded", calls: 1 },
  { name: "legacy", progress, text: "Recording uploaded", calls: 1 },
  { name: "foreign-custody", opening: view("capturing"), text: "Recording access needed on this device", calls: 0 },
  { name: "pending-save", opening: view(), progress: { ...progress, pendingSave }, text: "Confirm your previous save", calls: 0 },
  { name: "pending-admission", opening: null, progress: { admission, sessionId: null, uploaded: false, pendingSave: null },
    text: "Recover recording preparation", calls: 0 },
  { name: "access-ended-during-journal", opening: view(), revoke: true, text: "Encounter access ended", calls: 0 },
];
const results = [];
for (const mode of ["workspace", "desktop"]) for (const scenario of scenarios) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "capacitor://localhost/index.html",
    runScripts: "outside-only", pretendToBeVisual: true });
  const window = dom.window, root = window.document.getElementById("root");
  Object.defineProperty(window, "crypto", { value: webcrypto });
  Object.assign(window, { Headers, Response, TextEncoder, TextDecoder, structuredClone });
  window.fetch = forbidden;
  const module = new SourceTextModule(code, { context: dom.getInternalVMContext() });
  await module.link(forbidden); await module.evaluate();
  const abort = new window.AbortController(), encounterAbort = new window.AbortController();
  const coreCalls = [], journalWrites = [];
  let saved = { revision: scenario.progress ? "1" : null, progress: structuredClone(scenario.progress ?? null) };
  const original = structuredClone(saved);
  const openingReview = "opening" in scenario ? { scope, receivedAt: Date.now() - (scenario.age ?? 0), view: scenario.opening } : undefined;
  const readCore = body => {
    coreCalls.push(body.operation.kind);
    assert.equal(body.workspace_id, scope.workspaceId); assert.equal(body.binding_ref, scope.bindingRef);
    assert.equal(body.operation.kind, saved.progress ? "creator_review" : "provider_encounter");
    return { contract_version: "1", binding_ref: scope.bindingRef, workspace_id: scope.workspaceId,
      request_nonce: body.request_nonce, checked_at: new Date().toISOString(), operation: body.operation.kind,
      receipt: body.operation.kind === "creator_review" ? view() : { schema_version: "1.0", status: "available", review: view() } };
  };
  const journal = { load: async () => { if (scenario.revoke) encounterAbort.abort(); return structuredClone(saved); },
    save: async (_previous, next) => { journalWrites.push(structuredClone(next)); saved = { revision: "2", progress: next }; return saved; } };
  const selected = { scope, encounter, signal: encounterAbort.signal, journal,
    ...(openingReview ? { openingReview } : {}),
    request: async (_path, body) => Response.json(readCore(body)), recorder: forbidden, openInCore: forbidden,
    reviewJournal: () => ({ load: async () => null, save: forbidden, clear: forbidden }) };
  let host = { signal: abort.signal, listEncounters: async () => [encounter], createEncounter: forbidden,
    openEncounter: async () => selected }, desktop;
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
        case "open": result = { encounterId, encounter, scope, ...(openingReview ? { openingReview } : {}) }; break;
        case "journal_load": result = await journal.load(); break;
        case "journal_save": result = await journal.save(request.payload.previous, request.payload.progress); break;
        case "review_load": result = null; break;
        case "core": result = { status: 200, body: readCore(request.payload.body) }; break;
        case "disconnect": case "cancel": result = null; break;
        default: forbidden();
      }
      return { requestId: request.requestId, ok: true, result };
    } };
    desktop = module.namespace.createDesktopProviderApplicationHost(port, { subscribe: () => () => {}, request: forbidden });
    await desktop.host.session.getState();
    host = (await desktop.host.connect(abort.signal)).workspace;
  }
  const until = async predicate => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(done => setTimeout(done, 5)); }
    throw new Error(`Opening screen did not arrive: ${mode}/${scenario.name}`);
  };
  const dispose = module.namespace.mountProviderWorkspace(root, host);
  try {
    await until(() => root.querySelector('[data-workspace-action="open"]') && !root.hasAttribute("aria-busy"));
    root.querySelector('[data-workspace-action="open"]').click();
    await until(() => (scenario.revoke ? !root.textContent.includes("Recording uploaded")
      : root.textContent.includes(scenario.text)) && !root.hasAttribute("aria-busy"));
    assert.equal(coreCalls.length, scenario.calls, `${mode}/${scenario.name} opening calls`);
    if (scenario.progress || scenario.name === "foreign-custody" || scenario.revoke || scenario.name === "new") {
      assert.deepEqual(journalWrites, []); assert.deepEqual(saved, original);
    } else assert.equal(saved.progress.sessionId, sessionId);
    if (scenario.refresh) {
      root.querySelector('[data-review-action="refresh"]').click();
      await until(() => coreCalls.length === scenario.calls + 1 && root.textContent.includes("Recording uploaded")
        && !root.querySelector('[data-review-action="refresh"]')?.disabled);
      assert.equal(coreCalls.at(-1), "creator_review");
    }
    results.push({ mode, scenario: scenario.name, passed: true });
  } finally { await dispose(); await desktop?.dispose(); dom.window.close(); }
}
process.stdout.write(JSON.stringify({ synthetic_only: true, source_started: false, checks: results.length, results }, null, 2) + "\n");
