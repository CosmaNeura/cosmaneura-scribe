// Offline rendering of the built provider entry with no AbortSignal.any.
// No browser, native app, network, identity provider or audio source is started.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";

const [bundlePath, jsdomModule] = process.argv.slice(2);
if (!bundlePath || !jsdomModule) throw new Error("Usage: check-provider-ios17.mjs provider-capture.js installed-jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomModule));
const bundle = await readFile(bundlePath, "utf8");
const first = "appointment_01j00000000000000000000000";
const second = "appointment_01j00000000000000000000001";
const nextTick = () => new Promise(resolve => setTimeout(resolve, 10));

async function fixture(discovery = "new") {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "capacitor://localhost/index.html", runScripts: "outside-only", pretendToBeVisual: true,
  });
  const window = dom.window;
  Object.defineProperty(window.AbortSignal, "any", { value: undefined, configurable: true });
  Object.defineProperty(window, "crypto", { value: webcrypto });
  Object.assign(window, { Headers, Response, TextEncoder, TextDecoder, structuredClone });
  window.fetch = () => { throw new Error("Unexpected network request"); };
  const module = new SourceTextModule(bundle, { context: dom.getInternalVMContext() });
  await module.link(() => { throw new Error("Unexpected external module"); });
  await module.evaluate();
  const root = window.document.getElementById("root");
  const hostAbort = new window.AbortController();
  const revoked = new Map();
  const openedSignals = [];
  let finishOpen, deferOpen = false, journalReads = 0, saved = null, discoveryReads = 0;
  const list = [first, second].map((ref, i) => ({ appointmentRef: ref,
    title: `Invented visit ${i + 1}`, detail: "Invented provider-owned encounter" }));
  const unavailable = () => { throw new Error("Unrequested recorder or Core operation"); };
  const dispose = module.namespace.mountProviderWorkspace(root, {
    signal: hostAbort.signal,
    listEncounters: async () => list,
    createEncounter: unavailable,
    openEncounter: async (ref, signal) => {
      openedSignals.push(signal);
      const control = new window.AbortController();
      revoked.set(ref, control);
      const result = {
        encounter: list.find(item => item.appointmentRef === ref),
        scope: { workspaceId: "10000000-0000-4000-8000-000000000001", appointmentRef: ref,
          bindingRef: "scribe_capture_binding_01j00000000000000000000000" },
        signal: control.signal, request: async (_path, body) => {
          assert.equal(body.operation.kind, "provider_encounter"); discoveryReads++;
          if (discovery === "failed") return new Response(null, { status: 409 });
          return Response.json({ ...body, contract_version: "1", checked_at: new Date().toISOString(), operation: "provider_encounter",
            receipt: { schema_version: "1.0", status: discovery === "new" ? "not_prepared" : "available",
              review: discovery === "new" ? null : { schema_version: "1.0", session_id: "20000000-0000-4000-8000-000000000002",
                status: discovery === "uploaded" ? "processing" : "capturing", source: null, working: null, review_queue: null } } });
        }, reviewJournal: () => ({ load: async () => null, save: unavailable, clear: unavailable }),
        recorder: unavailable, openInCore: unavailable,
        journal: { load: async () => { journalReads++; return saved ?? { revision: null, progress: null }; },
          save: async (_previous, progress) => { assert.equal(progress.admission, null); assert.equal(progress.uploaded, true);
            saved = { revision: "1", progress }; return saved; } },
      };
      return deferOpen ? new Promise(resolve => { finishOpen = () => resolve(result); }) : result;
    },
  });
  async function settle() { for (let i = 0; i < 5; i++) await nextTick(); }
  await settle();
  return {
    root, hostAbort, openedSignals, revoked,
    text: () => root.textContent,
    async click(action, ref) {
      const selector = `button[data-workspace-action="${action}"]${ref ? `[data-appointment="${ref}"]` : ""}`;
      const button = root.querySelector(selector);
      assert.ok(button, `Missing provider action ${action}`);
      button.click(); await settle();
    },
    defer: () => { deferOpen = true; }, finish: async () => { finishOpen(); await settle(); },
    journalReads: () => journalReads, settle,
    discoveryReads: () => discoveryReads, saved: () => saved,
    async close() { await dispose(); dom.window.close(); },
  };
}

const opening = await fixture();
try {
  await opening.click("open", first);
  assert.ok(opening.text().includes("Prepare recording"),
    "Opening an encounter must work when AbortSignal.any is unavailable");
  assert.equal(opening.journalReads(), 1);
  assert.equal(opening.openedSignals[0].aborted, false);
  opening.hostAbort.abort();
  assert.equal(opening.root.childElementCount, 0);
  assert.equal(opening.openedSignals[0].aborted, true);
} finally { await opening.close(); }
console.log("The built provider entry opens an encounter without AbortSignal.any and clears it on logout.");

const switching = await fixture();
try {
  await switching.click("open", first);
  const oldSignal = switching.openedSignals[0];
  await switching.click("encounters");
  assert.equal(oldSignal.aborted, true);
  await switching.click("open", second);
  const newSignal = switching.openedSignals[1];
  switching.revoked.get(first).abort();
  await switching.settle();
  assert.equal(newSignal.aborted, false);
  assert.ok(switching.text().includes("Prepare recording"));
  switching.revoked.get(second).abort();
  await switching.settle();
  assert.equal(newSignal.aborted, true);
  assert.equal(switching.text().includes("Prepare recording"), false);
  assert.equal(switching.text().includes("Invented visit 2"), false);
  assert.ok(switching.text().includes("Encounter access ended"));
} finally { await switching.close(); }
console.log("Encounter switching cancels the old request; current creator revocation clears the current view.");

const pending = await fixture();
try {
  pending.defer();
  await pending.click("open", first);
  assert.equal(pending.openedSignals.length, 1);
  pending.hostAbort.abort();
  assert.equal(pending.openedSignals[0].aborted, true);
  await pending.finish();
  assert.equal(pending.journalReads(), 0);
  assert.equal(pending.root.childElementCount, 0);
} finally { await pending.close(); }
console.log("An encounter opening after logout cannot read the recovery journal or restore the private view.");

for (const state of ["uploaded", "unfinished", "failed"]) {
  const recovered = await fixture(state);
  try {
    await recovered.click("open", first);
    assert.equal(recovered.discoveryReads(), 1);
    assert.equal(recovered.text().includes("Prepare recording"), false);
    if (state === "uploaded") {
      assert.ok(recovered.root.querySelector('[data-review-action="refresh"]'));
      assert.ok(recovered.text().includes("Transcribing your recording"));
      assert.equal(recovered.saved().progress.admission, null);
      assert.equal(recovered.saved().progress.uploaded, true);
    } else {
      assert.equal(recovered.saved(), null);
      assert.ok(recovered.text().includes(state === "unfinished" ? "Recording access needed" : "Encounter could not open"));
    }
  } finally { await recovered.close(); }
}
console.log("A device without a journal discovers uploaded work once, preserves unfinished recording custody, and never treats a conflict as a new encounter.");
