// Compiled UI; all identity, consent, audio metadata and server responses are invented fixtures.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";
const [bundle, jsdomPath] = process.argv.slice(2);
if (!bundle || !jsdomPath) throw new Error("Usage: check-provider-recording-entry.mjs provider-capture.js jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomPath)), code = await readFile(bundle, "utf8"), suffix = "01j" + "0".repeat(23);
const until = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(done => setTimeout(done, 10)); } throw new Error(`Expected recording-entry state did not arrive: ${currentScenario}`); };
let checks = 0;
let currentScenario = "";
for (const platform of ["desktop", "ios"]) for (const mode of ["fresh", "meeting", "settings", "name-only", "recovered", "permission", "storage-failed", "cancel", "revoked", "resume-finish"]) {
  currentScenario = `${platform}/${mode}`;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "capacitor://localhost/index.html", runScripts: "outside-only", pretendToBeVisual: true });
  const window = dom.window, root = window.document.getElementById("root");
  Object.defineProperty(window, "crypto", { value: webcrypto }); Object.assign(window, { Headers, Response, TextEncoder, TextDecoder, structuredClone });
  window.ResizeObserver = class { observe() {} disconnect() {} }; window.matchMedia = () => ({ matches: false });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.fetch = () => { throw new Error("Unexpected external I/O"); }; if (platform === "ios") window.CapacitorCustomPlatform = { name: "ios" };
  const module = new SourceTextModule(code, { context: dom.getInternalVMContext() }); await module.link(() => { throw new Error("Unexpected import"); }); await module.evaluate();
  const abort = new window.AbortController(), listeners = new Set(); let release; const gate = new Promise(done => { release = done; });
  const session = webcrypto.randomUUID(), scope = { workspaceId: webcrypto.randomUUID(), appointmentRef: "appointment_" + suffix, bindingRef: "scribe_capture_binding_" + suffix };
  const encounter = { appointmentRef: scope.appointmentRef, patientRef: "patient_" + suffix, title: "Invented Patient", patientName: "Invented Patient", detail: "Offline fixture" };
  const admission = { key: webcrypto.randomUUID(), languageMode: "en-US", attestation: { modality: "in_person", participant_regions: [], method: "verbal_attestation", all_parties_consented: true, granted_at: new Date().toISOString() } };
  let saved = mode === "recovered" ? { revision: "1", progress: { admission, sessionId: session, uploaded: false, pendingSave: null } } : { revision: null, progress: null };
  let starts = 0, admissions = 0, creations = 0, checkClosed = false, acquired = false, closes = 0;
  let audio = { status: mode === "permission" ? "permission_required" : "ready", inputDevices: [{ id: "input_one", label: "Invented built-in microphone", kind: "built_in", current: true }, { id: "input_two", label: "Invented USB microphone", kind: "external", current: false }], selectedInputId: "input_one", microphone: { level: .2, ageMs: 0 }, desktopAudio: "microphone", meetingWindows: { state: "ready", selectedId: null, windows: [{ id: "call_one", title: "Invented Zoom call" }] } };
  let snapshot = { sessionId: session, state: "ready", statusCode: "capture_ready", recordedChunks: 0, queuedChunks: 0, elapsedSeconds: 0, remainingBudgetSeconds: 10800, remainingAuthoritySeconds: 900, transcriptionStatus: null, transcript: null, inputDevices: audio.inputDevices, selectedInputId: audio.selectedInputId,
    ...(platform === "desktop" ? { desktop: { phase: "ready", coverage: "not_started", trimmedStartMs: 0, trimmedEndMs: null, audioMode: "microphone", meetingWindows: audio.meetingWindows } } : { native: { phase: "ready", busy: false } }) };
  const publish = fields => { snapshot = { ...snapshot, ...fields }; for (const listener of listeners) listener(snapshot); };
  const controller = { get snapshot() { return snapshot; }, subscribe(listener) { listeners.add(listener); listener(snapshot); return () => listeners.delete(listener); },
    async startRecording() { assert.equal(checkClosed || mode === "recovered", true); starts++; publish({ state: "recording", statusCode: "capture_recording", recordedChunks: 1, elapsedSeconds: 1, ...(snapshot.desktop ? { desktop: { ...snapshot.desktop, phase: "recording", coverage: "aligned" } } : { native: { phase: "recording", busy: false } }) }); },
    async stopRecording() { publish({ state: "paused", statusCode: "capture_paused" }); }, async refreshTranscriptionStatus() {}, async selectAudioInput(id) { assert.ok(audio.inputDevices.some(row => row.id === id)); publish({ selectedInputId: id }); },
    ...(platform === "desktop" ? { async selectDesktopAudio(audioMode) { publish({ desktop: { ...snapshot.desktop, audioMode } }); }, async selectMeetingWindow(id) { assert.equal(id, "call_one"); publish({ desktop: { ...snapshot.desktop, meetingWindows: { ...snapshot.desktop.meetingWindows, selectedId: id } } }); } } : {}) };
  const dispose = module.namespace.mountProviderWorkspace(root, { signal: abort.signal, listEncounters: async () => [encounter], createEncounter: async () => { throw new Error("Unrequested dashboard action"); },
    audioPreflight: async () => { let observe; return { getSnapshot: () => audio, subscribe(listener) { observe = listener; listener(audio); return () => { observe = null; }; }, async selectMicrophone(id) { audio = { ...audio, selectedInputId: id, inputDevices: audio.inputDevices.map(row => ({ ...row, current: row.id === id })) }; snapshot = { ...snapshot, selectedInputId: id, inputDevices: audio.inputDevices }; observe?.(audio); }, async selectDesktopAudio(mode) { audio = { ...audio, desktopAudio: mode }; observe?.(audio); }, async selectMeetingWindow(id) { audio = { ...audio, meetingWindows: { ...audio.meetingWindows, selectedId: id } }; observe?.(audio); }, async refreshMeetingWindows() {}, async close() { checkClosed = true; } }; },
    ...(mode === "name-only" ? { encounterSetup: { state: async () => ({ account: "invented@example.invalid", patients: [], moreResults: false, pending: null }), search: async () => { throw new Error("Name entry must not search charts"); }, submit: async draft => { creations++; assert.equal(JSON.stringify(draft.patient), JSON.stringify({ kind: "new", name: "Invented Patient", dateOfBirth: null, provisional: true })); return encounter; } } } : {}),
    openEncounter: async () => ({ encounter, scope, signal: abort.signal, recorderRechecksReview: true, journal: { load: async () => saved, save: async (_previous, progress) => { if (mode === "storage-failed") throw new Error("Invented storage error"); saved = { revision: String(Number(saved.revision ?? 0) + 1), progress }; return saved; } }, reviewJournal: () => ({ load: async () => null, save: async () => {}, clear: async () => {} }), openInCore: async () => {},
      request: async (path, body) => {
        const base = { ...body, contract_version: "1", checked_at: new Date().toISOString() };
        if (body.operation) return Response.json({ ...base, operation: body.operation.kind, receipt: body.operation.kind === "provider_encounter" ? { schema_version: "1.0", status: "not_prepared", review: null } : { schema_version: "1.0", session_id: session, status: "created", source: null, working: null, review_queue: null } });
        assert.equal(checkClosed, true); assert.ok(path.endsWith("capture-admissions")); admissions++; assert.equal(body.attestation.all_parties_consented, true); return Response.json({ ...base, operation_ref: "scribe_admission_" + suffix, appointment_ref: scope.appointmentRef, consent_record_id: session, session_id: session });
      }, recorder: async () => { acquired = true; if (["cancel", "revoked"].includes(mode)) await gate; return { controller, sourceKind: "microphone", captureMode: platform === "desktop" ? "desktop_meeting" : "native_microphone", deactivate: async () => { closes++; }, resumePendingWork: async () => {}, releaseUploadedCapture: async () => {} }; } }),
  });
  try {
    await until(() => root.querySelector('[data-workspace-action="open"]'));
    if (mode === "name-only") { root.querySelector('[data-workspace-action="new-encounter"]').click(); await until(() => root.querySelector('[data-walk-in]')); root.querySelector('[name="walk-in-name"]').value = "Invented Patient"; root.querySelector('[data-walk-in]').dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); }
    else root.querySelector('[data-workspace-action="open"]').click();
    if (mode === "recovered") { await until(() => root.querySelector('[data-testid="record-button"]')); assert.equal(starts, 0); assert.equal(admissions, 0); checks++; continue; }
    await until(() => root.querySelector('[data-workspace-action="prepare"]'));
    const consent = root.querySelector('[name="consent"]'), start = root.querySelector('[data-workspace-action="prepare"]'); assert.equal(consent.checked, false); assert.equal(start.disabled, true); start.click(); assert.equal(starts, 0); assert.equal(admissions, 0);
    const forged = start.cloneNode(true); forged.disabled = false; start.after(forged); forged.click(); await until(() => !root.hasAttribute("aria-busy")); forged.remove(); assert.equal(admissions, 0);
    if (mode === "settings") { root.querySelector('[data-change-audio]').click(); assert.equal(root.querySelector('[data-audio-settings]').open, true); const input = root.querySelector('[data-preflight-input]'); input.value = "input_two"; input.dispatchEvent(new window.Event("change", { bubbles: true })); await until(() => audio.selectedInputId === "input_two"); root.querySelector('[data-audio-done]').click(); }
    if (platform === "desktop" && mode === "meeting") { root.querySelector('[data-preparation-audio="meeting"]').click(); await until(() => audio.desktopAudio === "meeting" && !root.querySelector("[data-preflight-window]").disabled); const call = root.querySelector('[data-preflight-window]'); call.value = "call_one"; call.dispatchEvent(new window.Event("change", { bubbles: true })); await until(() => audio.meetingWindows.selectedId === "call_one"); }
    consent.checked = true; consent.dispatchEvent(new window.Event("change", { bubbles: true }));
    if (mode === "permission") { assert.equal(start.disabled, true); start.click(); assert.equal(admissions, 0); checks++; continue; }
    await until(() => !start.disabled); start.click(); start.click();
    if (mode === "storage-failed") { await until(() => !root.hasAttribute("aria-busy")); assert.equal(admissions, 0); assert.equal(starts, 0); assert.equal(acquired, false); checks++; continue; }
    if (["cancel", "revoked"].includes(mode)) { await until(() => acquired); if (mode === "revoked") abort.abort(); else root.querySelector('[data-workspace-action="encounters"]').click(); release(); await until(() => closes > 0); assert.equal(starts, 0); checks++; continue; }
    await until(() => starts === 1); assert.equal(admissions, 1); assert.equal(saved.progress.sessionId, session); assert.equal(creations, mode === "name-only" ? 1 : 0); const app = root.querySelector("cosmaneura-capture"); await app.updateComplete; assert.equal(root.querySelector('[data-testid="stop-button"]').textContent.trim(), "Finish visit");
    if (mode === "resume-finish") { publish(snapshot.desktop ? { desktop: { ...snapshot.desktop, phase: "starting" } } : { native: { phase: "starting", busy: true } }); await app.updateComplete; const finish = root.querySelector('[data-testid="stop-button"]'); assert.equal(finish.textContent.trim(), "Finish visit"); finish.click(); await until(() => saved.progress.notePreparation?.state === "requested"); assert.equal(starts, 1); checks++; continue; }
    root.querySelector('[data-workspace-action="encounters"]').click(); await until(() => root.querySelector('[data-workspace-action="open"]')); root.querySelector('[data-workspace-action="open"]').click(); await until(() => root.querySelector("cosmaneura-capture")); assert.equal(starts, 1); checks++;
  } finally { release(); await dispose(); window.close(); }
}
console.log(JSON.stringify({ checks, compiled_provider_entry: true, unchecked_consent: true, preflight_stop_barrier: true, name_only_entry: true, start_once: true, recovery_never_records: true, physical_recording: false }));
