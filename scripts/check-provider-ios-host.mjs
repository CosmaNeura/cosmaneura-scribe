// Render the actual provider bundle with explicit offline native/Core fixtures.
// No device, credentials, microphone, service, or clinical operation is invoked.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";
import { IDBFactory } from "fake-indexeddb";

const [bundlePath, jsdomModule] = process.argv.slice(2);
if (!bundlePath || !jsdomModule) throw new Error("Usage: check-provider-ios-host.mjs provider-capture.js installed-jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomModule));
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "capacitor://localhost/index.html", runScripts: "outside-only", pretendToBeVisual: true,
});
const window = dom.window, calls = [];
Object.defineProperty(window.AbortSignal, "any", { value: undefined, configurable: true });
Object.defineProperty(window, "crypto", { value: webcrypto });
Object.assign(window, { Headers, Response, TextEncoder, TextDecoder, indexedDB: new IDBFactory() });
window.fetch = () => { throw new Error("Unexpected network request"); };
window.CapacitorCustomPlatform = { name: "ios" }; // Explicit fixture, never part of the product bundle.
window.Capacitor = {
  PluginHeaders: [{ name: "IOSPCM", methods: [] }, { name: "SecureQueue",
    methods: ["get", "list", "create", "compareAndSwap"].map(name => ({ name, rtype: "promise" })) }],
  nativePromise: async (plugin, method, options) => {
    calls.push({ plugin, method, key: options?.key });
    assert.equal(plugin, "SecureQueue", "No microphone or other native API may run");
    if (method === "get") throw Object.assign(new Error("Missing offline record"), { code: "SECURE_QUEUE_NOT_FOUND" });
    if (method === "list") return { keys: ["creator-review-v1:other", "scribe-provider-queue:v1:other"] };
    throw new Error("Unrequested native mutation");
  },
};
let locked = false;
Object.defineProperty(window.navigator, "locks", { value: { request: async (name, _options, callback) => {
  if (locked) return callback(null);
  locked = true;
  try { return await callback({ name, mode: "exclusive" }); }
  finally { locked = false; }
} } });
const module = new SourceTextModule(await readFile(bundlePath, "utf8"), { context: dom.getInternalVMContext() });
await module.link(() => { throw new Error("Unexpected external module"); }); await module.evaluate();
const root = window.document.getElementById("root"), abort = new window.AbortController();
const recovery = "10000000-0000-4000-8000-000000000001";
const workspace = "20000000-0000-4000-8000-000000000002";
const session = "30000000-0000-4000-8000-000000000003";
const appointment = "appointment_01j00000000000000000000000";
const encounter = { appointmentRef: appointment, title: "Invented provider visit", detail: "Synthetic fixture" };
let authorizations = 0;
const unavailable = () => { throw new Error("Unexpected clinical operation"); };
const host = module.namespace.createProviderIOSHost({ signal: abort.signal, listEncounters: async () => [encounter],
  createEncounter: unavailable, openEncounter: async () => ({ encounter, recoveryScope: recovery,
    scope: { workspaceId: workspace, appointmentRef: appointment,
      bindingRef: "scribe_capture_binding_01j00000000000000000000000" },
    signal: abort.signal, request: unavailable, openInCore: unavailable,
    uploadTarget: { putCompleteEnvelope: unavailable }, reauthorizeRecorder: async () => { authorizations++; },
  }) });
const dispose = module.namespace.mountProviderWorkspace(root, host);
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
try {
  await settle();
  const open = root.querySelector('[data-workspace-action="open"]');
  assert.ok(open); open.click(); await settle();
  assert.ok(root.textContent.includes("Prepare recording"));
  assert.ok(root.textContent.includes("All parties"));
  assert.equal(authorizations, 0);
  assert.ok(calls.some(call => call.key === `provider-workspace-v1:${recovery}:${workspace}`));
  const authorized = await host.openEncounter(appointment, abort.signal);
  const resources = await authorized.recorder(session, abort.signal);
  assert.equal(resources.source.kind, "microphone"); assert.equal(authorizations, 1);
  assert.equal((await resources.queueStorage.list()).length, 0);
  assert.equal(calls.some(call => call.key?.endsWith(":other")), false);
  await resources.release(); assert.equal(locked, false);
  abort.abort(); await settle();
  assert.equal(root.childElementCount, 0);
  await assert.rejects(authorized.recorder(session, abort.signal), /provider_native_scope_unavailable/);
  console.log("Built iOS host mounts the provider preparation view, scopes native recovery, reauthorizes recorder acquisition, excludes foreign records, releases its lock, and clears on revocation without AbortSignal.any. Native/Core implementations are offline fixtures; no audio or services run.");
} finally { await dispose(); dom.window.close(); }
