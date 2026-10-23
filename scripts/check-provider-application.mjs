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
window.ResizeObserver = class { observe() {} disconnect() {} };
window.matchMedia = () => ({ matches: false });
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; };
window.HTMLElement.prototype.scrollIntoView = function () {};
window.fetch = () => { throw new Error("Unexpected network request"); };
let nativeState = { phase: "signedOut", revision: webcrypto.randomUUID() };
const nativeCalls = [], nativeListeners = new Map(), warnings = [];
let mountGate = null, mountFailure = false, journalFailure = false;
window.console.warn = value => { warnings.push(value); };
window.CapacitorCustomPlatform = { name: "ios" };
window.Capacitor = {
  PluginHeaders: [{ name: "IOSPCM", methods: ["beginMicrophoneCheck", "readMicrophoneCheck", "endMicrophoneCheck"].map(name => ({ name, rtype: "promise" })) },
    { name: "CosmasWorkspaceAuth", methods: [
      ...["getState", "getProviderState", "takeRecordingOpenRequest", "signIn", "signOut", "providerRequest", "cancelProviderRequest", "removeListener"]
        .map(name => ({ name, rtype: "promise" })), { name: "addListener", rtype: "callback" },
    ] }, { name: "SecureQueue", methods: [{ name: "get", rtype: "promise" }] }],
  nativeCallback(plugin, method, options, callback) {
    assert.equal(plugin, "CosmasWorkspaceAuth"); assert.equal(method, "addListener");
    assert.ok(["authStateChanged", "recordingOpen"].includes(options.eventName));
    const id = webcrypto.randomUUID(); nativeListeners.set(id, callback); return id;
  },
  async nativePromise(plugin, method, options) {
    nativeCalls.push(`${plugin}.${method}`);
    if (plugin === "IOSPCM") {
      assert.ok(["beginMicrophoneCheck", "readMicrophoneCheck", "endMicrophoneCheck"].includes(method), "Preparation cannot record audio");
      if (method === "endMicrophoneCheck") return;
      return { version: 1, status: "ready", inputDevices: [{ id: "fixture-microphone", label: "Fixture microphone", kind: "built_in", current: true }],
        selectedInputId: "fixture-microphone", microphone: { level: .08, ageMs: 0 } };
    }
    if (plugin === "SecureQueue" && method === "get") {
      if (journalFailure) throw Object.assign(new Error("Private storage detail must not be displayed"), { code: "SECURE_QUEUE_UNAVAILABLE" });
      throw Object.assign(new Error("No saved fixture record"), { code: "SECURE_QUEUE_NOT_FOUND" });
    }
    assert.equal(plugin, "CosmasWorkspaceAuth");
    if (method === "removeListener") { nativeListeners.delete(options.callbackId); return; }
    if (method === "getState") return nativeState;
    if (method === "getProviderState") return { ...nativeState, providerReady: true };
    if (method === "takeRecordingOpenRequest") return { version: 1, pending: false };
    if (method === "signIn" || method === "signOut") {
      nativeState = { phase: method === "signIn" ? "ready" : "signedOut", revision: webcrypto.randomUUID() };
      for (const listener of [...nativeListeners.values()]) listener(nativeState);
      return nativeState;
    }
    if (method === "providerRequest") {
      if (options.action === "mount") {
        await mountGate?.promise;
        if (mountFailure) return { requestId: options.requestId, revision: options.revision, status: 503,
          body: '{"detail":"provider_request_unconfirmed"}' };
      }
      assert.ok(["catalog", "mount", "capture-operations"].includes(options.action), "No clinical mutation in startup check");
      if (options.action === "capture-operations") {
        const body = JSON.parse(options.body);
        assert.deepEqual(body.operation, { kind: "provider_encounter" });
        return { requestId: options.requestId, revision: options.revision, status: 200,
          body: JSON.stringify({ ...body, contract_version: "1", checked_at: new Date().toISOString(),
            operation: "provider_encounter", receipt: { schema_version: "1.0", status: "not_prepared", review: null } }) };
      }
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
  throw new Error(`Expected application state did not arrive: ${root.textContent}`);
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
    // The actual application and workspace share one simulated native owner and
    // device journal across sign-out/in; no real auth, encryption or Core runs.
    const f = fixture(), connect = f.host.connect, pending = deferred();
    const suffix = "01j" + "0".repeat(23), sessionId = "10000000-0000-4000-8000-000000000001";
    const recoveryScope = "30000000-0000-4000-8000-000000000003";
    const scope = { workspaceId: "20000000-0000-4000-8000-000000000002",
      bindingRef: "scribe_capture_binding_" + suffix, appointmentRef: "appointment_" + suffix };
    const schema = "doctor_note_schema_" + suffix, workingId = "40000000-0000-4000-8000-000000000004";
    const source = version => ({ kind: "reviewed_english", source_version: 1,
      working_transcript_id: workingId, working_version: version });
    const original = { state: "submitted", key: "50000000-0000-4000-8000-000000000005", schema, source: source(1) };
    const review = { schema_version: "1.0", session_id: sessionId, status: "transcript_ready",
      source: { source_transcript_version: 1, segments: [{ source_segment_id: recoveryScope, source_segment_version: 1,
        source_locale: "en-US", speaker_role: "unknown", content: "Invented corrected conversation.", start_ms: 0, end_ms: 1000 }] },
      working: { source_transcript_version: 1, working_transcript_id: workingId, working_transcript_version: 4,
        note_ready: true, blockers: [], segments: [{ source_segment_id: recoveryScope, source_segment_version: 1,
          resolution: "english_source", content: "Invented corrected conversation." }] },
      review_queue: { schema_version: "1.0", session_id: sessionId, source_transcript_version: 1,
        working_transcript_id: workingId, working_transcript_version: 4, status: "complete", items: [] } };
    let revision = 1, journalWrites = 0, opens = 0, heldBody;
    let progress = { admission: null, sessionId, uploaded: true, pendingSave: null, notePreparation: original };
    const journalKey = `provider-workspace-v1:${recoveryScope}:${scope.workspaceId}`;
    const plugin = {
      async get({ key }) {
        assert.equal(key, journalKey);
        return { key, revision: String(revision), data: window.btoa(JSON.stringify({ version: 2, recoveryScope, scope, progress })) };
      },
      async create() { throw new Error("The retained journal must not be replaced"); },
      async compareAndSwap({ key, expectedRevision, data }) {
        assert.equal(key, journalKey); assert.equal(expectedRevision, String(revision));
        const retained = JSON.parse(window.atob(data));
        assert.equal(retained.recoveryScope, recoveryScope); assert.deepEqual(retained.scope, scope);
        progress = retained.progress; revision++; journalWrites++;
        return { revision: String(revision) };
      },
    };
    const journal = new module.namespace.NativeProviderWorkspaceJournal(plugin, recoveryScope, scope);
    const calls = [], prepares = [];
    const receipt = async (draft = false) => {
      const text = "Invented late preparation reply.", order = ["Plan"];
      const digest = draft ? [...new Uint8Array(await webcrypto.subtle.digest("SHA-256",
        new TextEncoder().encode(JSON.stringify([["Plan", text]]))))].map(byte => byte.toString(16).padStart(2, "0")).join("") : null;
      return { session_id: sessionId, scribe_source_id: workingId, source_sha256: "a".repeat(64), schema_ref: schema,
        transcript_ref: draft ? "ai_visit_transcript_" + suffix : null, note_ref: draft ? "visit_note_" + suffix : null,
        status: draft ? "draft" : "not_prepared", note_type: "Synthetic SOAP", fields: draft ? { Plan: text } : null,
        field_order: draft ? order : null, note_sha256: digest, created_at: draft ? new Date().toISOString() : null,
        review_required: true, reviewed_source: source(4) };
    };
    const response = (body, value) => Response.json({ ...body, contract_version: "1", checked_at: new Date().toISOString(),
      ...(body.operation ? { operation: "creator_review" } : { action: body.action }), receipt: value });
    const forbidden = () => { throw new Error("No recording, upload, save or transcript mutation in session recovery"); };
    f.host.connect = async signal => {
      const connected = await connect(signal), workspace = connected.workspace;
      workspace.listEncounters = async () => [{ appointmentRef: scope.appointmentRef, title: "Invented app visit",
        detail: "Same-owner corrected-draft fixture", status: "draft_ready" }];
      workspace.openEncounter = async appointmentRef => {
        assert.equal(appointmentRef, scope.appointmentRef); opens++;
        return { encounter: (await workspace.listEncounters())[0], scope, signal, journal,
          request: async (_path, body, key) => {
            calls.push(body.operation?.kind ?? body.action);
            if (body.operation) { assert.equal(body.operation.kind, "creator_review"); return response(body, review); }
            assert.ok(["read", "prepare"].includes(body.action));
            if (body.action === "prepare") { prepares.push(key); heldBody = body; return pending.promise; }
            return response(body, await receipt());
          },
          reviewJournal: () => ({ load: async () => null, save: forbidden, clear: forbidden }),
          recorder: forbidden, openInCore: forbidden };
      };
      return connected;
    };
    const dispose = mountProviderApplication(root, f.host);
    try {
      await until(visible); root.querySelector('[data-workspace-action="open-draft"]').click();
      await until(() => root.querySelector('[data-workspace-action="prepare-updated-note"]'));
      assert.equal(prepares.length, 0); assert.equal(journalWrites, 0);
      root.querySelector('[data-workspace-action="prepare-updated-note"]').click();
      await until(() => prepares.length === 1);
      const committed = await journal.load(), successorKey = prepares[0];
      assert.notEqual(successorKey, original.key);
      // Normalize JSON-only journal values from the bundle's VM realm before
      // comparing them with host-realm fixtures; prototype identity is irrelevant.
      assert.deepEqual(JSON.parse(JSON.stringify(committed.progress.notePreparation)), original);
      assert.deepEqual(JSON.parse(JSON.stringify(committed.progress.notePreparationSuccessors)),
        [{ state: "submitted", key: successorKey, schema, source: source(4) }]);
      assert.equal(journalWrites, 1);
      f.change("unavailable");
      await until(() => root.querySelector('[data-session-action="sign-out"]')?.disabled === false && f.closes === 1);
      assert.equal(f.scopes[0].aborted, true); assert.equal(root.querySelector('[data-workspace-content]'), null);
      for (let attempt = 0; attempt < 2; attempt++) { click("check"); await until(() => root.getAttribute("aria-busy") === "false"); }
      assert.equal(f.connects, 1); assert.equal(prepares.length, 1);
      click("sign-out"); await until(() => root.querySelector('[data-session-action="sign-in"]')?.disabled === false);
      click("sign-in"); await until(visible);
      assert.equal(f.signOuts, 1); assert.equal(f.signIns, 1); assert.equal(f.connects, 2);
      root.querySelector('[data-workspace-action="open-draft"]').click();
      await until(() => root.querySelector('[data-workspace-action="retry-updated-note"]')?.disabled === false);
      assert.equal(opens, 2); assert.equal(prepares.length, 1); assert.equal(journalWrites, 1);
      assert.deepEqual(await journal.load(), committed);
      pending.resolve(response(heldBody, await receipt(true))); await turn(); await turn();
      assert.equal(root.textContent.includes("Invented late preparation reply."), false);
      assert.equal(root.querySelector("textarea[data-note-field]"), null);
      assert.equal(prepares.length, 1); assert.equal(calls.includes("save"), false);
      assert.deepEqual(await journal.load(), committed);
    } finally { pending.resolve(Response.json({}, { status: 503 })); await dispose(); }
  });
  await check(async () => {
    const f = fixture(), connect = f.host.connect;
    const sessionId = "10000000-0000-4000-8000-000000000001";
    const scope = { workspaceId: "20000000-0000-4000-8000-000000000002",
      bindingRef: "scribe_capture_binding_01j00000000000000000000000",
      appointmentRef: "appointment_01j00000000000000000000000" };
    let opened = 0, activeReads = 0, navigation, removed = 0, deactivated = 0;
    const forbidden = () => { throw new Error("A recording link cannot start, resume, admit, upload or write"); };
    f.host.recordingOpen = async listener => { navigation = listener; listener(); return { async remove() { removed++; } }; };
    f.host.connect = async signal => {
      const connected = await connect(signal), workspace = connected.workspace;
      workspace.activeRecording = async () => { activeReads++; return { appointmentRef: scope.appointmentRef, sessionId }; };
      workspace.openEncounter = async appointmentRef => {
        assert.equal(appointmentRef, scope.appointmentRef); opened++;
        return { encounter: (await workspace.listEncounters())[0], scope, signal,
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
          recorder: async () => ({ sourceKind: "microphone", controller: {
            snapshot: { sessionId, state: "paused", statusCode: "capture_recovered_paused",
              recordedChunks: 1, queuedChunks: 1, elapsedSeconds: 1, remainingBudgetSeconds: 60,
              remainingAuthoritySeconds: 60, transcriptionStatus: null, transcript: null },
            subscribe(listener) { listener(this.snapshot); return () => {}; },
            startRecording: forbidden, resumeRecording: forbidden, stopRecording: forbidden,
          }, deactivate: async () => { deactivated++; }, resumePendingWork: forbidden, releaseUploadedCapture: forbidden }),
        };
      };
      return connected;
    };
    const dispose = mountProviderApplication(root, f.host);
    try {
      await until(() => root.querySelector("cosmaneura-capture") && root.getAttribute("aria-busy") === "false");
      assert.equal(activeReads, 1); assert.equal(opened, 1); assert.equal(deactivated, 0);
      const capture = root.querySelector("cosmaneura-capture"); navigation(); await turn();
      assert.equal(root.querySelector("cosmaneura-capture"), capture);
      assert.equal(activeReads, 1); assert.equal(opened, 1); assert.equal(deactivated, 0);
      assert.equal(window.document.activeElement, capture);
    } finally { await dispose(); }
    assert.equal(removed, 1); assert.equal(deactivated, 1);
  });
  for (const failureAt of ["initial", "refresh"]) await check(async () => {
    const f = fixture(), connect = f.host.connect, revision = f.state.revision;
    let failList = failureAt === "initial", listCalls = 0;
    f.host.connect = async signal => {
      const connected = await connect(signal), listEncounters = connected.workspace.listEncounters;
      connected.workspace.listEncounters = async () => {
        listCalls++;
        if (failList) throw new Error("Private catalog failure must not be displayed");
        return listEncounters();
      };
      return connected;
    };
    const dispose = mountProviderApplication(root, f.host);
    try {
      if (failureAt === "refresh") {
        await until(visible); failList = true;
        root.querySelector('[data-workspace-action="encounters"]').click();
      }
      await until(() => root.querySelector('[data-workspace-content] [data-workspace-action="encounters"]'));
      assert.ok(root.textContent.includes("Your encounters could not be loaded"));
      assert.equal(root.textContent.includes("Loading your authorized encounters"), false);
      assert.equal(root.textContent.includes("Private catalog failure"), false);
      assert.equal(visible(), false);
      const retry = root.querySelector('[data-workspace-content] [data-workspace-action="encounters"]');
      assert.equal(retry.textContent, "Retry loading encounters");
      failList = false; retry.click(); await until(visible);
      assert.equal(root.querySelector('[data-workspace-notice]').textContent, "");
      assert.equal(listCalls, failureAt === "initial" ? 2 : 3);
      assert.equal(f.connects, 1); assert.equal(f.closes, 0);
      assert.equal(f.signIns, 0); assert.equal(f.signOuts, 0); assert.equal(f.state.revision, revision);
    } finally { await dispose(); }
  });
  await check(async () => {
    nativeState = { phase: "ready", revision: webcrypto.randomUUID() };
    let coreOpens = 0;
    const forbidden = () => { throw new Error("No capture or note operation in navigation regression"); };
    const dispose = module.namespace.mountNativeProviderIOSApplication(root, {
      uploadTarget: { putCompleteEnvelope: forbidden },
      core: { createEncounter: async () => { coreOpens++; }, openEncounter: forbidden },
    });
    try {
      await until(visible);
      assert.equal(root.querySelector('[data-workspace-action="create"]').textContent, "Open the dashboard");
      root.querySelector('[data-workspace-action="create"]').click();
      await until(() => coreOpens === 1 && root.getAttribute("aria-busy") === "false");
      await turn();
      mountGate = deferred(); mountFailure = true;
      root.querySelector('[data-workspace-action="open"]').click();
      await until(() => root.textContent.includes("Opening encounter"));
      const heading = root.querySelector('[data-workspace-content] h1');
      await new Promise(resolve => setTimeout(resolve, 5200));
      assert.equal(root.querySelector('[data-workspace-content] h1'), heading, "Polling must not remount an in-flight encounter");
      mountGate.resolve(); mountGate = null;
      await until(() => root.textContent.includes("Encounter could not open"));
      assert.ok(root.textContent.includes("encounter connection could not be confirmed"));
      mountFailure = false; journalFailure = true;
      root.querySelector('[data-workspace-action="open"]').click();
      await until(() => root.textContent.includes("saved encounter recovery could not be confirmed"));
      assert.equal(root.textContent.includes("Private storage detail"), false);
      journalFailure = false;
      root.querySelector('[data-workspace-action="open"]').click();
      await until(() => root.querySelector('[data-workspace-action="prepare"]'));
      assert.equal(root.querySelector('[name="regions"]'), null);
      const consent = root.querySelector('[name="consent"]'); consent.focus();
      await new Promise(resolve => setTimeout(resolve, 5200));
      assert.equal(root.querySelector('[name="consent"]'), consent, "Polling must retain the opened encounter and consent control");
      assert.equal(window.document.activeElement, consent); assert.equal(root.querySelector('[data-workspace-action="prepare"]').textContent, "Start recording");
      assert.ok(nativeCalls.includes("IOSPCM.beginMicrophoneCheck"));
      assert.equal(nativeCalls.includes("IOSPCM.start"), false);
    } finally {
      mountGate?.resolve(); mountGate = null; mountFailure = false; journalFailure = false;
      await dispose(); nativeState = { phase: "signedOut", revision: webcrypto.randomUUID() };
      nativeCalls.length = 0;
    }
  });
  await check(async () => {
    const f = fixture(), connect = f.host.connect;
    let saved = null, admissions = 0;
    const forbidden = () => { throw new Error("No recording or clinical note in setup regression"); };
    const scope = { workspaceId: "20000000-0000-4000-8000-000000000002",
      bindingRef: "scribe_capture_binding_01j00000000000000000000000",
      appointmentRef: "appointment_01j00000000000000000000000" };
    f.host.connect = async signal => {
      const connected = await connect(signal), workspace = connected.workspace;
      workspace.openEncounter = async () => ({ encounter: (await workspace.listEncounters())[0], scope, signal,
        journal: { load: async () => ({ revision: null, progress: null }),
          save: async (_prior, progress) => { saved = structuredClone(progress); return { revision: "1", progress: saved }; } },
        reviewJournal: forbidden, recorder: forbidden, openInCore: forbidden,
        request: async (_action, body) => {
          if (body.operation?.kind === "provider_encounter") return Response.json({ ...body,
            contract_version: "1", checked_at: new Date().toISOString(), operation: "provider_encounter",
            receipt: { schema_version: "1.0", status: "not_prepared", review: null } });
          admissions++;
          assert.deepEqual(Array.from(body.attestation.participant_regions), []);
          assert.equal(body.attestation.all_parties_consented, true);
          // Retain the exact request for recovery after an unconfirmed reply.
          return Response.json({ detail: "synthetic_unconfirmed" }, { status: 503 });
        },
      });
      return connected;
    };
    const dispose = mountProviderApplication(root, f.host);
    try {
      await until(visible); root.querySelector('[data-workspace-action="open"]').click();
      await until(() => root.querySelector('[data-workspace-action="prepare"]'));
      assert.equal(root.querySelector('[name="regions"]'), null);
      assert.equal(root.querySelector('[name="timezone"]'), null);
      await turn();
      assert.equal(admissions, 0); assert.equal(saved, null);
      assert.ok(root.textContent.includes("The patient said yes"));
      assert.equal(root.querySelector('[data-workspace-action="prepare"]').disabled, true);
      root.querySelector('[name="consent"]').checked = true;
      root.querySelector('[name="consent"]').dispatchEvent(new window.Event("change", { bubbles: true }));
      root.querySelector('[data-workspace-action="prepare"]').click();
      await until(() => admissions === 1); await turn();
      assert.deepEqual(saved.admission.attestation.participant_regions, []);
      assert.equal(saved.admission.attestation.all_parties_consented, true);
      assert.equal(saved.sessionId, null);
    } finally { await dispose(); }
  });
  for (const recovery of ["empty", "reopen", "custody", "upload", "upload-revoked", "upload-navigation"]) await check(async () => {
    const f = fixture(), connect = f.host.connect;
    const uploading = recovery.startsWith("upload"), uploadGate = deferred(), retryGate = deferred();
    const sessionId = "10000000-0000-4000-8000-000000000001";
    const scope = { workspaceId: "20000000-0000-4000-8000-000000000002",
      bindingRef: "scribe_capture_binding_01j00000000000000000000000",
      appointmentRef: "appointment_01j00000000000000000000000" };
    const progress = { sessionId, uploaded: false, pendingSave: null,
      admission: { key: webcrypto.randomUUID(), languageMode: "en-US", attestation: {
        modality: "in_person", participant_regions: ["US-NY"], method: "verbal_attestation",
        all_parties_consented: true, granted_at: new Date().toISOString(),
      } } };
    const forbidden = () => { throw new Error("No capture, upload, preparation or journal write in recovery DOM check"); };
    let opened = 0, deactivated = 0, resumed = 0, uploads = 0, reviewStatus = "capturing";
    f.host.connect = async signal => {
      const connected = await connect(signal), workspace = connected.workspace;
      workspace.openEncounter = async appointmentRef => {
        assert.equal(appointmentRef, scope.appointmentRef); opened++;
        return { encounter: (await workspace.listEncounters())[0], scope, signal,
          request: async (_path, body) => {
            assert.equal(body.operation.kind, "creator_review");
            return Response.json({ ...body, contract_version: "1", checked_at: new Date().toISOString(),
              operation: "creator_review", receipt: { schema_version: "1.0", session_id: sessionId,
                status: reviewStatus, source: null, working: null, review_queue: null } });
          },
          journal: { load: async () => ({ revision: "1", progress }), save: forbidden },
          reviewJournal: () => ({ load: uploading ? async () => null : forbidden, save: forbidden }), openInCore: forbidden,
          recorder: async id => {
            assert.equal(id, sessionId);
            if (recovery === "custody") return {
              source: { kind: "microphone", start: forbidden, stop: async () => {} },
              flowStore: { getActiveCaptureState: async () => null, getPreparationState: async () => null },
              queueStorage: {}, uploadTarget: { putCompleteEnvelope: forbidden },
              release: async () => { deactivated++; },
            };
            let observe;
            let snapshot = { sessionId, state: uploading ? "uploading" : recovery === "empty" ? "paused" : "error",
              statusCode: uploading ? "capture_upload_pending" : recovery === "empty" ? "capture_no_saved_audio" : "capture_reopen_required",
              recordedChunks: uploading ? 1 : 0, queuedChunks: 1, elapsedSeconds: uploading ? 5 : 0, remainingBudgetSeconds: 60,
              remainingAuthoritySeconds: uploading ? 0 : 60, transcriptionStatus: null, transcript: null,
              desktop: { phase: recovery === "empty" ? "interrupted" : "stopped", coverage: "incomplete",
                trimmedStartMs: 0, trimmedEndMs: null } };
            return { sourceKind: "microphone", captureMode: "desktop_meeting", controller: {
              get snapshot() { return snapshot; }, subscribe(listener) { observe = listener; listener(snapshot); return () => { observe = null; }; },
              startRecording: forbidden, stopRecording: forbidden,
              resumeRecording: async () => { resumed++; },
            }, deactivate: async () => { deactivated++; }, resumePendingWork: uploading ? async () => {
              uploads++;
              if (uploads === 1) {
                await uploadGate.promise;
                observe?.(snapshot);
                throw new Error("Private upload failure must not be displayed");
              }
              await retryGate.promise;
              reviewStatus = "processing";
              snapshot = { ...snapshot, state: "processing", statusCode: "capture_processing" };
              observe?.(snapshot);
            } : forbidden, releaseUploadedCapture: forbidden };
          },
        };
      };
      return connected;
    };
    const dispose = mountProviderApplication(root, f.host);
    try {
      await until(visible); root.querySelector('[data-workspace-action="open"]').click();
      if (recovery === "custody") {
        await until(() => root.textContent.includes("Recording access needed on this device"));
        assert.ok(root.textContent.includes("continue on that device"));
        assert.equal(root.querySelector('[data-testid="record-button"]'), null);
        assert.equal(resumed, 0);
        root.querySelector('[data-workspace-action="encounters"]').click();
        await until(() => root.querySelector('[data-workspace-action="open"]'));
        assert.equal(deactivated, 1); assert.equal(opened, 1);
        return;
      }
      await until(() => root.querySelector('[data-testid="record-button"]'));
      if (uploading) {
        const capture = root.querySelector("cosmaneura-capture");
        await until(() => uploads === 1);
        await turn();
        assert.equal(root.querySelector('[data-testid="retry-upload"]').disabled, true);
        if (recovery !== "upload") {
          if (recovery === "upload-revoked") f.change("signedOut");
          else {
            root.querySelector('[data-workspace-action="encounters"]').click();
            await until(() => root.querySelector('[data-workspace-action="open"]'));
          }
          assert.equal(root.querySelector("cosmaneura-capture"), null);
          uploadGate.resolve(); await until(() => deactivated === 1); await turn();
          assert.equal(root.querySelector("cosmaneura-capture"), null);
          assert.equal(uploads, 1); assert.equal(resumed, 0); assert.equal(opened, 1);
          return;
        }
        uploadGate.resolve(); await turn();
        await until(() => root.textContent.includes("Encounter could not open")
          || root.querySelector('[data-testid="retry-upload"]')?.disabled === false);
        assert.equal(root.querySelector("cosmaneura-capture"), capture,
          "A failed automatic upload must retain the opened encounter and its Retry upload control");
        assert.equal(root.textContent.includes("Recording has not started"), false);
        assert.equal(root.textContent.includes("Private upload failure"), false);
        assert.equal(root.querySelector('[data-testid="record-button"]').disabled, true);
        assert.equal(root.querySelector('[data-testid="stop-button"]').disabled, true);
        const retry = root.querySelector('[data-testid="retry-upload"]');
        retry.click(); retry.click();
        await until(() => uploads === 2 && retry.disabled);
        assert.equal(opened, 1); assert.equal(deactivated, 0); assert.equal(resumed, 0);
        retryGate.resolve(); await until(() => root.textContent.includes("Recording saved"));
        assert.equal(root.querySelector("cosmaneura-capture"), capture);
        assert.equal(root.querySelector('[data-testid="retry-upload"]'), null);
        assert.equal(uploads, 2);
        return;
      }
      assert.equal(root.querySelector('[data-testid="record-button"]').disabled, true);
      assert.equal(root.querySelector('[data-testid="stop-button"]').disabled, recovery === "reopen");
      assert.equal(resumed, 0);
      if (recovery === "empty") {
        assert.ok(root.textContent.includes("No audio was saved from this recording."));
        const resume = root.querySelector('[data-testid="resume-recording"]');
        assert.equal(resume.disabled, false); resume.click(); await until(() => resumed === 1);
      } else {
        assert.ok(root.textContent.includes("Return to Your encounters and reopen this visit"));
        assert.equal(root.querySelector('[data-testid="resume-recording"]'), null);
      }
      root.querySelector('[data-workspace-action="encounters"]').click();
      await until(() => root.querySelector('[data-workspace-action="open"]'));
      assert.ok(deactivated > 0); assert.equal(opened, 1);
      root.querySelector('[data-workspace-action="open"]').click();
      await until(() => root.querySelector('[data-testid="record-button"]'));
      assert.equal(opened, 2);
    } finally { uploadGate.resolve(); retryGate.resolve(); await dispose(); }
  });
  await check(async () => {
    const f = fixture("unavailable"), dispose = mountProviderApplication(root, f.host);
    try {
      await until(() => root.querySelector('[data-session-action="check"]')?.disabled === false);
      for (let attempt = 0; attempt < 3; attempt++) {
        click("check"); await until(() => root.getAttribute("aria-busy") === "false");
        assert.ok(root.textContent.includes("Session unavailable"));
      }
      assert.equal(f.connects, 0); assert.equal(f.signIns, 0); assert.equal(f.signOuts, 0);
      assert.equal(root.querySelector('[data-session-action="open"]'), null);
      click("sign-out"); await until(() => root.querySelector('[data-session-action="sign-in"]')?.disabled === false);
      assert.equal(f.signOuts, 1); assert.equal(f.connects, 0);
      click("sign-in"); await until(visible);
      assert.equal(f.signIns, 1); assert.equal(f.connects, 1);
    } finally { await dispose(); }
  });
  await check(async () => {
    const f = fixture(), dispose = mountProviderApplication(root, f.host);
    try {
      await until(visible); f.failClose = true; f.change("unavailable");
      await until(() => root.textContent.includes("Workspace close needs attention"));
      assert.equal(visible(), false); assert.equal(f.connects, 1);
      assert.equal(root.querySelector('[data-session-action="sign-out"]'), null);
      assert.equal(root.querySelector('[data-session-action="sign-in"]'), null);
      assert.equal(root.querySelector('[data-session-action="open"]'), null);
      f.failClose = false; click("stop");
      await until(() => root.querySelector('[data-session-action="sign-out"]')?.disabled === false);
      click("sign-out");
      await until(() => root.querySelector('[data-session-action="sign-in"]')?.disabled === false);
      assert.equal(f.signOuts, 1); assert.equal(f.connects, 1); assert.ok(f.closes >= 2);
      click("sign-in"); await until(visible);
      assert.equal(f.signIns, 1); assert.equal(f.connects, 2);
    } finally { f.failClose = false; await dispose(); }
  });
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
    const f = fixture(), dispose = mountProviderApplication(root, f.host);
    try {
      await until(visible); f.change("ready");
      await until(() => f.closes === 1); await turn();
      const reopen = root.querySelector('[data-session-action="open"]');
      assert.ok(reopen); reopen.focus();
      await new Promise(resolve => setTimeout(resolve, 5200)); // Actual native-state poll.
      assert.equal(root.querySelector('[data-session-action="open"]'), reopen,
        "An unchanged session poll must retain the actionable recovery button");
      assert.equal(window.document.activeElement, reopen, "Session polling must preserve keyboard focus");
      reopen.click(); await until(visible); assert.equal(f.connects, 2);
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
      await until(() => root.querySelector('[data-workspace-action="prepare"]'));
      assert.equal(nativeCalls.filter(call => call.endsWith(".providerRequest")).length, 3);
      assert.equal(nativeCalls.some(call => call === "IOSPCM.beginMicrophoneCheck"), true);
      assert.equal(nativeCalls.some(call => call === "IOSPCM.start"), false);
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
