// Actual compiled workspace; delayed synthetic reads only. No native source or service.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";
const [bundle, jsdomPath] = process.argv.slice(2);
if (!bundle || !jsdomPath) throw new Error("Usage: check-provider-cancel-opening.mjs provider.js jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomPath));
const code = await readFile(bundle, "utf8"), sessionId = webcrypto.randomUUID();
const scope = { workspaceId: webcrypto.randomUUID(), appointmentRef: "appointment_01j00000000000000000000000",
  bindingRef: "scribe_capture_binding_01j00000000000000000000000" };
const encounter = { appointmentRef: scope.appointmentRef, title: "Invented cancellation visit", detail: "Visit · 2026-09-30T10:26:45Z" };
const admission = { key: webcrypto.randomUUID(), languageMode: "en-US", attestation: { modality: "in_person",
  participant_regions: [], method: "verbal_attestation", all_parties_consented: true, granted_at: new Date().toISOString() } };
let checks = 0;
for (const stalledAt of ["mount", "journal", "discover", "status"]) for (const lateFailure of [false, true]) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "capacitor://localhost/index.html",
    runScripts: "outside-only", pretendToBeVisual: true });
  const window = dom.window, root = window.document.getElementById("root");
  Object.defineProperty(window, "crypto", { value: webcrypto });
  Object.assign(window, { Headers, Response, TextEncoder, TextDecoder, structuredClone });
  const forbidden = () => { throw new Error("Unexpected mutation, source or network access"); };
  window.fetch = forbidden;
  const module = new SourceTextModule(code, { context: dom.getInternalVMContext() });
  await module.link(forbidden); await module.evaluate();
  const abort = new window.AbortController();
  let release, waiting = false, opened = 0, firstSignal, recorderCalls = 0, writes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const hold = async () => { waiting = true; await gate; if (lateFailure) throw new Error("Private late failure"); };
  const host = { signal: abort.signal, listEncounters: async () => [encounter], createEncounter: forbidden,
    openEncounter: async (_ref, signal) => {
      const first = ++opened === 1;
      if (first) firstSignal = signal;
      if (first && stalledAt === "mount") await hold();
      return { encounter, scope, signal,
        journal: { load: async () => {
          if (first && stalledAt === "journal") await hold();
          return first && stalledAt === "status" ? { revision: "1", progress: {
            admission, sessionId, uploaded: false, pendingSave: null } } : { revision: null, progress: null };
        }, save: () => { writes++; forbidden(); } },
        recorder: () => { recorderCalls++; forbidden(); }, openInCore: forbidden, reviewJournal: forbidden,
        request: async (_path, body) => {
          if (first && (stalledAt === "discover" || stalledAt === "status")) await hold();
          return Response.json({ ...body, contract_version: "1", checked_at: new Date().toISOString(),
            operation: body.operation.kind, receipt: body.operation.kind === "creator_review"
              ? { schema_version: "1.0", session_id: sessionId, status: "created", source: null, working: null, review_queue: null }
              : { schema_version: "1.0", status: "not_prepared", review: null } });
        } };
    } };
  const until = async predicate => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error(`Cancellation state did not arrive: ${stalledAt}/${lateFailure}`);
  };
  const dispose = module.namespace.mountProviderWorkspace(root, host);
  try {
    await until(() => root.querySelector('[data-workspace-action="open"]') && !root.hasAttribute("aria-busy"));
    root.querySelector('[data-workspace-action="open"]').click(); await until(() => waiting);
    assert.equal(root.getAttribute("aria-busy"), "true");
    const cancel = root.querySelector('[data-workspace-action="cancel-opening"]');
    assert.ok(cancel); assert.equal(cancel.disabled, false);
    if (stalledAt === "mount" && !lateFailure) {
      await new Promise(resolve => setTimeout(resolve, 1050));
      assert.equal(root.querySelector("[data-workspace-progress]").hidden, false);
      assert.match(root.querySelector("[data-workspace-progress]").textContent, /Working · [1-9]\d*s/u);
    }
    cancel.click(); cancel.click();
    await until(() => root.querySelector('[data-workspace-action="open"]') && !root.hasAttribute("aria-busy"));
    assert.equal(firstSignal.aborted, true);
    assert.ok(root.textContent.includes("Opening cancelled. Your saved work is retained."));
    // Reopen before the stale read finishes; neither its success nor failure can replace this screen.
    root.querySelector('[data-workspace-action="open"]').click();
    await until(() => root.querySelector('[data-workspace-action="prepare"]') && !root.hasAttribute("aria-busy"));
    const consent = root.querySelector('[data-workspace-action="prepare"]');
    release(); await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(root.querySelector('[data-workspace-action="prepare"]'), consent);
    assert.equal(root.querySelector('[data-workspace-action="cancel-opening"]'), null);
    assert.equal(root.textContent.includes("Private late failure"), false);
    assert.equal(root.textContent.includes("could not be confirmed"), false);
    assert.equal(recorderCalls, 0); assert.equal(writes, 0); assert.equal(opened, 2); checks++;
  } finally { release(); await dispose(); dom.window.close(); }
}
console.log(JSON.stringify({ checks, synthetic_only: true, recorder_started: false, late_results_ignored: true }));
