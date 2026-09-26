// Actual compiled workspace/recorder, explicit offline Core and native fixtures.
// No microphone, installed app, account, live service or clinical record is used.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";
const [bundle, jsdomPath] = process.argv.slice(2);
if (!bundle || !jsdomPath) throw new Error("Usage: check-provider-recording-entry.mjs provider-capture.js jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomPath));
const until = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("Recording entry state did not arrive");
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let checks = 0;
for (const platform of ["desktop", "ios"]) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "capacitor://localhost/index.html", runScripts: "outside-only", pretendToBeVisual: true });
  const window = dom.window, root = window.document.getElementById("root"), nativeCalls = [];
  Object.defineProperty(window, "crypto", { value: webcrypto });
  Object.assign(window, { Headers, Response, TextEncoder, TextDecoder, structuredClone });
  window.fetch = () => { throw new Error("Unexpected network"); };
  if (platform === "ios") {
    window.CapacitorCustomPlatform = { name: "ios" };
    window.Capacitor = {
      PluginHeaders: [{ name: "IOSPCM", methods: ["selectMicrophoneInput", "getCaptureSignal"].map(name => ({ name, rtype: "promise" })) }],
      async nativePromise(plugin, method, options) {
        assert.equal(plugin, "IOSPCM");
        if (method === "getCaptureSignal") return null;
        assert.equal(method, "selectMicrophoneInput"); nativeCalls.push(options.input);
        return { version: 1, input: options.input };
      },
    };
  }
  const module = new SourceTextModule(await readFile(bundle, "utf8"), { context: dom.getInternalVMContext() });
  await module.link(() => { throw new Error("Unexpected module"); }); await module.evaluate();
  const sessionId = "10000000-0000-4000-8000-000000000001";
  const scope = { workspaceId: "20000000-0000-4000-8000-000000000002", appointmentRef: "appointment_01j00000000000000000000000",
    bindingRef: "scribe_capture_binding_01j00000000000000000000000" };
  const encounter = { appointmentRef: scope.appointmentRef, title: "Invented recording entry", detail: "Synthetic all-party consent only" };
  for (const mode of ["fresh", "recovered", "revoked", "permission"]) {
    const abort = new window.AbortController(), gate = deferred(), acquisition = deferred(), listeners = new Set();
    let starts = 0, closes = 0, admissions = 0, acquiring = false;
    const admission = { key: webcrypto.randomUUID(), languageMode: "en-US", attestation: { modality: "virtual", participant_regions: [],
      method: "verbal_attestation", all_parties_consented: true, granted_at: new Date().toISOString() } };
    let saved = mode === "recovered" ? { revision: "1", progress: { admission, sessionId, uploaded: false, pendingSave: null } } : { revision: null, progress: null };
    let snapshot = { sessionId, state: "ready", statusCode: "capture_ready", recordedChunks: 0, queuedChunks: 0, elapsedSeconds: 0,
      remainingBudgetSeconds: 10_800, remainingAuthoritySeconds: 900, transcriptionStatus: null, transcript: null,
      ...(platform === "desktop" ? { desktop: { phase: mode === "permission" ? "permission_required" : "ready", coverage: "not_started", trimmedStartMs: 0, trimmedEndMs: null } } : {}) };
    const update = fields => { snapshot = { ...snapshot, ...fields }; for (const listener of listeners) listener(snapshot); };
    const forbidden = () => { throw new Error("Unrequested fixture action"); };
    const controller = {
      get snapshot() { return snapshot; },
      subscribe(listener) { listeners.add(listener); listener(snapshot); return () => listeners.delete(listener); },
      async startRecording() {
        starts++; update({ state: "recording", statusCode: "capture_starting",
          ...(snapshot.desktop ? { desktop: { ...snapshot.desktop, phase: "starting" } } : {}) });
        await gate.promise;
        if (!abort.signal.aborted) update({ statusCode: "capture_recording",
          ...(snapshot.desktop ? { desktop: { ...snapshot.desktop, phase: "recording", coverage: "aligned" } } : {}) });
      }, stopRecording: forbidden, refreshTranscriptionStatus: forbidden,
    };
    const dispose = module.namespace.mountProviderWorkspace(root, { signal: abort.signal, listEncounters: async () => [encounter], createEncounter: forbidden,
      openEncounter: async () => ({ encounter, scope, signal: abort.signal,
        journal: { load: async () => saved, save: async (_prior, progress) => { saved = { revision: String(Number(saved.revision ?? 0) + 1), progress }; return saved; } },
        reviewJournal: () => ({ load: async () => null, save: forbidden, clear: forbidden }), openInCore: forbidden,
        request: async (path, body) => {
          const base = { ...body, contract_version: "1", checked_at: new Date().toISOString() };
          if (path.endsWith("capture-admissions")) {
            admissions++; assert.equal(body.attestation.all_parties_consented, true);
            return Response.json({ ...base, operation_ref: "scribe_admission_01j00000000000000000000000", appointment_ref: scope.appointmentRef,
              consent_record_id: sessionId, session_id: sessionId });
          }
          assert.ok(["provider_encounter", "creator_review"].includes(body.operation.kind));
          return Response.json({ ...base, operation: body.operation.kind, receipt: body.operation.kind === "provider_encounter"
            ? { schema_version: "1.0", status: "not_prepared", review: null }
            : { schema_version: "1.0", session_id: sessionId, status: "created", source: null, working: null, review_queue: null } });
        },
        recorder: async () => {
          acquiring = true; if (mode === "revoked") await acquisition.promise;
          return { controller, sourceKind: "microphone", ...(platform === "desktop" ? { captureMode: "desktop_meeting" } : {}),
            deactivate: async () => { closes++; }, resumePendingWork: forbidden, releaseUploadedCapture: forbidden };
        },
      }),
    });
    try {
      await until(() => root.querySelector('[data-workspace-action="open"]'));
      root.querySelector('[data-workspace-action="open"]').click();
      if (mode === "recovered") {
        await until(() => root.querySelector('[data-testid="record-button"]'));
        assert.equal(starts, 0); assert.equal(admissions, 0); checks++; continue;
      }
      await until(() => root.querySelector('[data-workspace-action="prepare"]'));
      assert.equal(starts, 0); assert.equal(acquiring, false);
      root.querySelector('[name="language"]').value = "en-US+es-US";
      const start = root.querySelector('[data-workspace-action="prepare"]'); start.click();
      await until(() => root.textContent.includes("confirm all-party consent"));
      assert.equal(admissions, 0); assert.equal(saved.progress, null);
      root.querySelector('[name="consent"]').checked = true;
      if (platform === "ios") root.querySelector('[name="microphone"]').value = "external";
      start.click(); start.click(); // Double taps must not create another admission/start.
      await until(() => acquiring);
      if (mode === "revoked") {
        abort.abort(); acquisition.resolve(); await until(() => closes > 0);
        assert.equal(starts, 0); assert.equal(root.textContent.includes(encounter.title), false); checks++; continue;
      }
      if (mode === "permission" && platform === "desktop") {
        await until(() => root.querySelector('[data-testid="refresh-permissions"]'));
        assert.equal(starts, 0); checks++; continue;
      }
      await until(() => starts === 1 && root.textContent.includes("Starting microphone"));
      assert.equal(admissions, 1); assert.equal(root.querySelector('[data-testid="record-button"]').disabled, true);
      assert.equal(saved.progress.sessionId, sessionId);
      if (platform === "ios") {
        assert.equal(nativeCalls.at(-1), "external");
        assert.equal(root.querySelector('[data-testid="microphone-input"]').value, "external");
      }
      gate.resolve(); await until(() => root.getAttribute("aria-busy") !== "true");
      assert.equal(starts, 1); assert.equal(root.textContent.includes("Recording prepared"), false);
      root.querySelector('[data-workspace-action="encounters"]').click();
      await until(() => root.querySelector('[data-workspace-action="open"]'));
      root.querySelector('[data-workspace-action="open"]').click();
      await until(() => root.querySelector('[data-testid="record-button"]'));
      assert.equal(starts, 1, "Reopening cannot replay the Start action"); checks++;
    } finally { acquisition.resolve(); gate.resolve(); await dispose(); }
  }
  dom.window.close();
}
console.log(JSON.stringify({ checks, compiled_provider_entry: true, consent_and_recovery_guards: true, physical_recording: false }));
