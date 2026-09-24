// Actual compiled application/DOM, with explicit offline session and Core hosts.
// No phone, credential store, recording, backend or live service is touched.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";

const [bundle, jsdomPath] = process.argv.slice(2);
if (!bundle || !jsdomPath) throw new Error("Usage: check-provider-application.mjs provider-capture.js jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomPath));
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "capacitor://localhost/index.html", runScripts: "outside-only", pretendToBeVisual: true,
});
const window = dom.window, root = window.document.getElementById("root");
Object.defineProperty(window.AbortSignal, "any", { value: undefined, configurable: true });
Object.defineProperty(window, "crypto", { value: webcrypto });
Object.assign(window, { Headers, Response, TextEncoder, TextDecoder, structuredClone });
window.fetch = () => { throw new Error("Unexpected network request"); };
let nativeState = { phase: "signedOut", revision: webcrypto.randomUUID() };
const nativeCalls = [], nativeListeners = new Map(), warnings = [];
window.console.warn = value => { warnings.push(value); };
window.CapacitorCustomPlatform = { name: "ios" };
window.Capacitor = {
  PluginHeaders: [{ name: "IOSPCM", methods: [] },
    { name: "CosmasWorkspaceAuth", methods: [
      ...["getState", "getProviderState", "signIn", "signOut", "providerRequest", "cancelProviderRequest", "removeListener"]
        .map(name => ({ name, rtype: "promise" })), { name: "addListener", rtype: "callback" },
    ] }, { name: "SecureQueue", methods: [{ name: "get", rtype: "promise" }] }],
  nativeCallback(plugin, method, options, callback) {
    assert.equal(plugin, "CosmasWorkspaceAuth"); assert.equal(method, "addListener");
    assert.equal(options.eventName, "authStateChanged");
    const id = webcrypto.randomUUID(); nativeListeners.set(id, callback); return id;
  },
  async nativePromise(plugin, method, options) {
    nativeCalls.push(`${plugin}.${method}`);
    if (plugin === "SecureQueue" && method === "get") {
      throw Object.assign(new Error("No saved fixture record"), { code: "SECURE_QUEUE_NOT_FOUND" });
    }
    assert.equal(plugin, "CosmasWorkspaceAuth");
    if (method === "removeListener") { nativeListeners.delete(options.callbackId); return; }
    if (method === "getState") return nativeState;
    if (method === "getProviderState") return { ...nativeState, providerReady: true };
    if (method === "signIn" || method === "signOut") {
      nativeState = { phase: method === "signIn" ? "ready" : "signedOut", revision: webcrypto.randomUUID() };
      for (const listener of [...nativeListeners.values()]) listener(nativeState);
      return nativeState;
    }
    if (method === "providerRequest") {
      assert.ok(["catalog", "mount"].includes(options.action), "No clinical mutation in startup check");
      const encounter = { appointmentRef: "appointment_01j00000000000000000000000",
        title: "Invented app visit", detail: "Native connection fixture" };
      const workspaceId = "10000000-0000-4000-8000-000000000001";
      const value = options.action === "catalog" ? { revision: options.revision, encounters: [{ ...encounter, workspaceId }] }
        : { revision: options.revision, workspaceId, encounter, appointmentRef: encounter.appointmentRef,
          recoveryScope: "20000000-0000-4000-8000-000000000002", bindingRef: "scribe_capture_binding_01j00000000000000000000000" };
      return { requestId: options.requestId, revision: options.revision, status: 200, body: JSON.stringify(value) };
    }
    throw new Error("Unrequested native operation");
  },
};
const module = new SourceTextModule(await readFile(bundle, "utf8"), { context: dom.getInternalVMContext() });
await module.link(() => { throw new Error("Unexpected external module"); }); await module.evaluate();
const { mountProviderApplication } = module.namespace;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const until = async predicate => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Expected application state did not arrive");
};
const turn = () => new Promise(resolve => setTimeout(resolve, 20));
const click = action => {
  const button = root.querySelector(`[data-session-action="${action}"]`);
  assert.ok(button, `Missing action ${action}`); assert.equal(button.disabled, false); button.click();
};
const visible = () => root.textContent.includes("Invented app visit");
function fixture(phase = "ready") {
  let state = { phase, revision: webcrypto.randomUUID() }, observe;
  const f = { connects: 0, closes: 0, removed: 0, signIns: 0, signOuts: 0, scopes: [], failClose: false,
    change(next, revision = webcrypto.randomUUID()) { state = { phase: next, revision }; observe?.(state); },
    get state() { return state; },
  };
  const session = {
    async getState() { return state; },
    async signIn() { f.signIns++; f.change("ready"); return state; },
    async signOut() { f.signOuts++; f.change("signedOut"); return state; },
    async addListener(_event, callback) { observe = callback; return { async remove() { f.removed++; } }; },
  };
  const connect = async signal => {
    f.connects++; f.scopes.push(signal);
    return { workspace: { signal,
      async listEncounters() { return [{ appointmentRef: "appointment_01j00000000000000000000000",
        title: "Invented app visit", detail: "Offline application fixture" }]; },
      async createEncounter() { throw new Error("Unrequested Core creation"); },
      async openEncounter() { throw new Error("Unrequested capture"); },
    }, async dispose() { f.closes++; if (f.failClose) throw new Error("Offline unconfirmed close"); } };
  };
  return Object.assign(f, { host: { session, connect }, connect });
}
let checks = 0;
async function check(run) { root.replaceChildren(); await run(); checks++; }
try {
  await check(async () => {
    const f = fixture("signedOut"), dispose = mountProviderApplication(root, f.host);
    try {
      await until(() => root.querySelector('[data-session-action="sign-in"]'));
      assert.equal(f.connects, 0); click("sign-in"); await until(visible);
      assert.equal(f.signIns, 1); assert.equal(f.connects, 1);
      click("sign-out"); assert.equal(visible(), false);
      await until(() => f.closes === 1); assert.equal(f.signOuts, 1);
      assert.equal(f.scopes[0].aborted, true);
    } finally { await dispose(); }
    assert.equal(f.removed, 1);
  });
  await check(async () => {
    const f = fixture(), dispose = mountProviderApplication(root, f.host);
    try {
      await until(visible); f.change("ready"); assert.equal(visible(), false);
      await until(() => f.closes === 1); await turn(); assert.equal(f.connects, 1);
      click("open"); await until(visible); assert.equal(f.connects, 2);
    } finally { await dispose(); }
  });
  await check(async () => {
    const f = fixture(), gate = deferred();
    let pendingSignal;
    f.host.connect = signal => { pendingSignal = signal; return gate.promise; };
    const dispose = mountProviderApplication(root, f.host);
    try {
      await until(() => pendingSignal); click("sign-out");
      assert.equal(pendingSignal.aborted, true); assert.equal(f.signOuts, 1);
      gate.resolve(await f.connect(pendingSignal));
      await until(() => f.closes === 1);
      assert.equal(visible(), false); assert.equal(f.connects, 1);
    } finally { await dispose(); }
  });
  await check(async () => {
    const f = fixture(), connect = f.host.connect;
    f.host.supportsRecorderStopReauthentication = true;
    const sessionId = "10000000-0000-4000-8000-000000000001";
    const scope = { workspaceId: "20000000-0000-4000-8000-000000000002",
      bindingRef: "scribe_capture_binding_01j00000000000000000000000",
      appointmentRef: "appointment_01j00000000000000000000000" };
    const forbidden = () => { throw new Error("No capture, upload, note or journal write in logout recovery"); };
    let stopAttempts = 0, stopped = false, matchingAccount = false;
    f.host.connect = async signal => {
      const connected = await connect(signal), workspace = connected.workspace;
      workspace.openEncounter = async () => ({
        encounter: (await workspace.listEncounters())[0], scope, signal,
        request: async (_path, body) => {
          assert.equal(body.operation.kind, "creator_review");
          return Response.json({ ...body, contract_version: "1", checked_at: new Date().toISOString(),
            operation: "creator_review", receipt: { schema_version: "1.0", session_id: sessionId,
              status: "capturing", source: null, working: null, review_queue: null } });
        },
        journal: { load: async () => ({ revision: "1", progress: { sessionId, uploaded: false, pendingSave: null,
          admission: { key: webcrypto.randomUUID(), languageMode: "en-US", attestation: {
            modality: "in_person", participant_regions: ["US-NY"], method: "verbal_attestation",
            all_parties_consented: true, granted_at: new Date().toISOString(),
          } } } }), save: forbidden },
        reviewJournal: () => ({ load: forbidden, save: forbidden }), openInCore: forbidden,
        recorder: async () => {
          const snapshot = { sessionId, state: "paused", statusCode: "capture_recovered_paused",
            recordedChunks: 1, queuedChunks: 1, elapsedSeconds: 1, remainingBudgetSeconds: 60,
            remainingAuthoritySeconds: 60, transcriptionStatus: null, transcript: null };
          return { sourceKind: "microphone", controller: {
            snapshot, subscribe(listener) { listener(snapshot); return () => {}; },
            startRecording: forbidden, stopRecording: forbidden,
          }, deactivate: async () => {
            stopAttempts++;
            if (f.state.phase !== "ready" || !matchingAccount) throw new Error("Native cessation unconfirmed");
            stopped = true;
          }, resumePendingWork: forbidden, releaseUploadedCapture: forbidden };
        },
      });
      return connected;
    };
    const dispose = mountProviderApplication(root, f.host);
    try {
      await until(visible); root.querySelector('[data-workspace-action="open"]').click();
      await until(() => root.querySelector("cosmaneura-capture"));
      click("sign-out"); await until(() => root.querySelector('[data-session-action="sign-in-stop"]')?.disabled === false);
      assert.equal(visible(), false); assert.equal(stopped, false);
      assert.equal(root.querySelector('[data-session-action="open"]'), null);
      // Native same-account checking rejects this fixture's first sign-in.
      click("sign-in-stop"); await until(() => f.signIns === 1 && root.getAttribute("aria-busy") === "false");
      assert.equal(stopped, false); assert.equal(f.connects, 1);
      assert.equal(root.querySelector('[data-session-action="open"]'), null);
      click("sign-out"); await until(() => root.querySelector('[data-session-action="sign-in-stop"]')?.disabled === false);
      matchingAccount = true; click("sign-in-stop");
      await until(() => stopped && root.querySelector('[data-session-action="open"]')?.disabled === false);
      assert.equal(f.signIns, 2); assert.ok(stopAttempts >= 3);
      assert.equal(visible(), false); assert.equal(f.connects, 1, "Recovery must not reopen automatically");
      click("open"); await until(visible); assert.equal(f.connects, 2);
    } finally {
      matchingAccount = true;
      if (f.state.phase !== "ready") f.change("ready");
      await turn(); await dispose();
    }
  });
  await check(async () => {
    const forbidden = () => { throw new Error("No upload, Core creation or navigation in startup check"); };
    const dispose = module.namespace.mountNativeProviderIOSApplication(root, {
      uploadTarget: { putCompleteEnvelope: forbidden }, core: { createEncounter: forbidden, openEncounter: forbidden },
    });
    try {
      await until(() => root.querySelector('[data-session-action="sign-in"]'));
      click("sign-in"); await until(visible);
      root.querySelector('[data-workspace-action="open"]').click();
      await until(() => root.textContent.includes("Prepare recording"));
      assert.equal(nativeCalls.filter(call => call.endsWith(".providerRequest")).length, 2);
      assert.equal(nativeCalls.some(call => call.startsWith("IOSPCM.")), false);
      assert.equal(nativeCalls.some(call => call.endsWith(".getToken")), false);
      click("sign-out"); assert.equal(visible(), false);
      await until(() => root.querySelector('[data-session-action="sign-in"]'));
    } finally { await dispose(); await turn(); }
    assert.equal(nativeListeners.size, 0);
  });
  assert.deepEqual(warnings, [], "Native session plugin must be registered only once");
  await check(async () => {
    const f = fixture(), dispose = mountProviderApplication(root, f.host);
    try {
      await until(visible); f.failClose = true; click("sign-out");
      await until(() => root.textContent.includes("Workspace close needs attention"));
      assert.equal(f.signOuts, 1); assert.equal(visible(), false);
      assert.equal(root.querySelector('[data-session-action="sign-in"]'), null);
      f.failClose = false; click("stop");
      await until(() => root.querySelector('[data-session-action="sign-in"]'));
      assert.ok(f.closes >= 2); assert.equal(f.connects, 1);
    } finally { await dispose(); }
  });
  await check(async () => {
    const f = fixture(), dispose = mountProviderApplication(root, f.host);
    try {
      await until(visible);
      f.host.session.signOut = async () => { f.signOuts++; throw new Error("Offline logout failure"); };
      click("sign-out"); await until(() => root.textContent.includes("Retry sign out"));
      assert.equal(root.querySelector('[data-session-action="open"]'), null);
      f.change("ready", f.state.revision); await turn();
      assert.equal(visible(), false); assert.equal(f.connects, 1);
      f.host.session.signOut = async () => { f.signOuts++; f.change("signedOut"); return f.state; };
      click("sign-out"); await until(() => root.querySelector('[data-session-action="sign-in"]'));
    } finally { await dispose(); }
  });
  await check(async () => {
    const f = fixture(), gate = deferred(), old = f.state;
    f.host.session.getState = () => gate.promise;
    const dispose = mountProviderApplication(root, f.host);
    try {
      await turn(); f.change("signedOut"); gate.resolve(old); await turn();
      assert.equal(f.connects, 0); assert.equal(visible(), false);
      assert.ok(root.querySelector('[data-session-action="sign-in"]'));
    } finally { await dispose(); }
  });
  await check(async () => {
    const f = fixture(), added = deferred();
    f.host.session.addListener = () => added.promise;
    const dispose = mountProviderApplication(root, f.host), closing = dispose();
    added.resolve({ async remove() { f.removed++; } }); await closing;
    assert.equal(f.removed, 1); assert.equal(f.connects, 0); assert.equal(root.childElementCount, 0);
  });
  await check(async () => {
    const f = fixture(), dispose = mountProviderApplication(root, f.host);
    await until(visible); f.failClose = true;
    await assert.rejects(dispose(), /provider_close_unconfirmed/);
    assert.equal(visible(), false); assert.equal(f.removed, 0);
    f.failClose = false; await dispose(); assert.equal(f.removed, 1);
  });
  await check(async () => {
    const f = fixture(), dispose = mountProviderApplication(root, f.host);
    try {
      await until(visible);
      f.host.session.getState = async () => { throw new Error("Offline state read failure"); };
      f.change("ready"); await until(() => f.closes === 1); click("open");
      await until(() => root.textContent.includes("Session unavailable"));
      assert.equal(visible(), false); assert.equal(f.connects, 1);
    } finally { await dispose(); }
  });
  console.log(`${checks} built provider application checks passed, with AbortSignal.any absent and offline session/Core hosts. No recording or live service ran.`);
} finally { dom.window.close(); }
