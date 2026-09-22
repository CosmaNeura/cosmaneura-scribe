// Compiled provider UI + real main/preload mapping over an in-process IPC fake.
// Backend, native session, consent and clinical content are explicitly invented.
// No Electron, credential store, recording, network or Core service is activated.
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";

const [bundle, mainBundle, jsdomPath] = process.argv.slice(2);
if (!bundle || !mainBundle || !jsdomPath) throw new Error("Usage: check-desktop-workspace-ui.mjs provider.js main-ipc.mjs jsdom-module");
const { JSDOM } = await import(pathToFileURL(jsdomPath));
const { DesktopProviderWorkspaceIpc, installDesktopProviderPreload } = await import(pathToFileURL(mainBundle));
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "app://cosmas/provider.html", runScripts: "outside-only", pretendToBeVisual: true });
const window = dom.window, root = window.document.getElementById("root");
Object.defineProperty(window, "crypto", { value: webcrypto });
Object.assign(window, { Headers, Response, TextEncoder, TextDecoder, structuredClone, AbortController, AbortSignal });
window.fetch = () => { throw new Error("Unexpected renderer network"); };
const module = new SourceTextModule(await readFile(bundle, "utf8"), { context: dom.getInternalVMContext() });
await module.link(() => { throw new Error("Unexpected external module"); }); await module.evaluate();
const until = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("Expected desktop workspace view did not arrive");
};
const click = selector => {
  const button = root.querySelector(selector); assert.ok(button, `Missing action ${selector}`);
  assert.equal(button.disabled, false); button.click();
};
const action = name => `[data-workspace-action="${name}"]`;
const sessionId = "10000000-0000-4000-8000-000000000001", workspaceId = "20000000-0000-4000-8000-000000000002";
const segmentId = "30000000-0000-4000-8000-000000000003", translationId = "40000000-0000-4000-8000-000000000004";
const workingId = "50000000-0000-4000-8000-000000000005";
const scope = { workspaceId, appointmentRef: "appointment_01j00000000000000000000000", bindingRef: "scribe_capture_binding_01j00000000000000000000000" };
const schema = "doctor_note_schema_01j00000000000000000000000", transcriptRef = "ai_visit_transcript_01j00000000000000000000000";
const firstNote = "visit_note_01j00000000000000000000000", savedNote = "visit_note_01j00000000000000000000001";
const english = "Invented test visit.", spanish = "Consulta de prueba inventada.";
const now = new Date().toISOString(), methods = [], wire = [], authObservers = new Set();
let accepted = false, prepared = false, pendingReview = null, creates = 0, closes = 0, authReads = 0, failListener = true;
let fields = { Subjective: english, Assessment: "Invented fixture only." }, noteRef = firstNote;
let state = { phase: "ready", revision: webcrypto.randomUUID() };
let journal = { revision: "1", progress: { sessionId, uploaded: true, pendingSave: null,
  admission: { key: webcrypto.randomUUID(), languageMode: "en-US+es-US", attestation: { modality: "virtual", participant_regions: ["US-NY"],
    method: "verbal_attestation", all_parties_consented: true, granted_at: now } } } };
const navigation = [], decisions = [], journalSaves = [];
const change = phase => { state = { phase, revision: webcrypto.randomUUID() }; for (const listener of authObservers) listener(state); };
const review = () => ({ schema_version: "1.0", session_id: sessionId, status: accepted ? "transcript_ready" : "review_required",
  source: { source_transcript_version: 1, segments: [{ source_segment_id: segmentId, source_segment_version: 1,
    content: spanish, source_locale: "es-US", speaker_role: "clinician", start_ms: 0, end_ms: 1000 }] },
  working: { source_transcript_version: 1, working_transcript_id: workingId, working_transcript_version: accepted ? 2 : 1,
    note_ready: accepted, segments: [{ source_segment_id: segmentId, source_segment_version: 1,
      resolution: accepted ? "spanish_translation" : "unresolved", content: accepted ? english : null }],
    blockers: accepted ? [] : [{ source_segment_id: segmentId, code: "review_required" }] },
  review_queue: { schema_version: "1.0", session_id: sessionId, source_transcript_version: 1,
    working_transcript_id: workingId, working_transcript_version: accepted ? 2 : 1, status: accepted ? "complete" : "review_required",
    items: accepted ? [] : [{ source_segment_id: segmentId, source_segment_version: 1, source_locale: "es-US", target_locale: "en-US",
      source_content: spanish, translated_content: english, translation_id: translationId, translation_version: 1 }] } });
const draft = () => ({ session_id: sessionId, scribe_source_id: workingId, source_sha256: "a".repeat(64), schema_ref: schema,
  transcript_ref: prepared ? transcriptRef : null, note_ref: prepared ? noteRef : null,
  status: prepared ? "draft" : "not_prepared", note_type: "Invented SOAP", fields: prepared ? fields : null,
  field_order: prepared ? Object.keys(fields) : null,
  note_sha256: prepared ? createHash("sha256").update(JSON.stringify(Object.entries(fields))).digest("hex") : null,
  created_at: prepared ? now : null, review_required: true,
  reviewed_source: { kind: "reviewed_english", source_version: 1, working_transcript_id: workingId, working_version: 2 } });
const encounter = { appointmentRef: scope.appointmentRef, title: "Invented desktop visit", detail: "Invented all-party consent" };
const host = {
  session: {
    async getState() { authReads++; return { ...state, ignoredNativeValue: "invented-native-private-value" }; },
    async signIn() { change("ready"); return state; }, async signOut() { change("signedOut"); return state; },
    async addListener(_event, callback) {
      if (failListener) throw new Error("invented-native-private-value");
      authObservers.add(callback); return { async remove() { authObservers.delete(callback); } };
    },
  },
  async connect(signal) {
    return { async dispose() { closes++; }, workspace: { signal,
      async listEncounters() { return [encounter]; }, async createEncounter() { creates++; },
      async openEncounter(ref, encounterSignal) {
        assert.equal(ref, scope.appointmentRef);
        return { scope, encounter, signal: encounterSignal,
          journal: { async load() { return structuredClone(journal); }, async save(previous, progress) {
            assert.equal(previous.revision, journal.revision); journalSaves.push(structuredClone(progress));
            journal = { revision: String(Number(journal.revision) + 1), progress: structuredClone(progress) }; return journal;
          } },
          reviewJournal: id => { assert.equal(id, sessionId); return {
            async load() { return pendingReview; }, async save(value) { pendingReview = structuredClone(value); },
            async clear(key) { assert.equal(key, pendingReview.key); pendingReview = null; },
          }; },
          async request(path, body, key, requestSignal) {
            assert.equal(requestSignal.aborted, false); assert.equal(body.workspace_id, workspaceId); assert.equal(body.binding_ref, scope.bindingRef);
            const envelope = { contract_version: "1", binding_ref: scope.bindingRef, workspace_id: workspaceId, request_nonce: body.request_nonce, checked_at: now };
            if (path.endsWith("/capture-operations")) {
              const kind = body.operation.kind;
              if (kind === "creator_review") return Response.json({ ...envelope, operation: kind, receipt: review() });
              assert.equal(kind, "decide_translation"); assert.equal(key, pendingReview.key);
              assert.deepEqual(body.operation.payload, pendingReview.request); assert.equal(body.operation.payload.decision, "accepted");
              decisions.push(key); accepted = true;
              return Response.json({ ...envelope, operation: kind, receipt: { schema_version: "1.0", session_id: sessionId, saved: true, review_id: webcrypto.randomUUID() } });
            }
            assert.equal(path, "/service/v1/agent/scribe/capture-notes"); assert.equal(body.expected_session_id, sessionId); assert.equal(accepted, true);
            if (body.action === "templates") return Response.json({ ...envelope, action: body.action, receipt: {
              session_id: sessionId, templates: [{ schema_ref: schema, note_type: "Invented SOAP", field_names: Object.keys(fields) }] } });
            assert.equal(body.schema_ref, schema);
            if (body.action === "prepare") prepared = true;
            else if (body.action === "save") {
              assert.deepEqual(body.edit, journal.progress.pendingSave.edit); assert.equal(key, body.edit.client_key);
              assert.equal(body.edit.expected_note_ref, noteRef); assert.equal(body.edit.expected_note_sha256, draft().note_sha256);
              fields = body.edit.fields; noteRef = savedNote;
            } else assert.equal(body.action, "read");
            return Response.json({ ...envelope, action: body.action, receipt: draft() });
          },
          async recorder() { throw new Error("No source activation in review/save check"); },
          async openInCore(ref) { navigation.push(ref); },
        };
      },
    } };
  },
};
const handlers = new Map(), rendererEvents = new EventEmitter(), renderer = new EventEmitter();
Object.assign(renderer, { id: 77, mainFrame: { url: "app://cosmas/provider.html" }, isDestroyed: () => false,
  send: (channel, value) => { wire.push(structuredClone(value)); rendererEvents.emit(channel, {}, structuredClone(value)); } });
const event = { sender: renderer, senderFrame: renderer.mainFrame };
const ipc = { handle(channel, callback) { assert.equal(handlers.has(channel), false); handlers.set(channel, callback); }, removeHandler(channel) { handlers.delete(channel); } };
const rendererPort = {
  async invoke(channel, command) {
    methods.push(command.method ?? command.kind); wire.push(structuredClone(command));
    const callback = handlers.get(channel); assert.ok(callback);
    const value = await callback(event, structuredClone(command)); wire.push(structuredClone(value)); return structuredClone(value);
  },
  on: (...args) => rendererEvents.on(...args), removeListener: (...args) => rendererEvents.removeListener(...args),
};
const exposed = {}, boundary = new DesktopProviderWorkspaceIpc(ipc, renderer, host); boundary.install();
installDesktopProviderPreload({ exposeInMainWorld(name, value) { exposed[name] = value; } }, rendererPort);
let dispose;
try {
  assert.deepEqual(Object.keys(exposed).sort(), ["scribeProvider", "scribeRecorder"]);
  const invoke = handlers.get("scribe:provider:workspace:v1"), read = { method: "session_read", requestId: webcrypto.randomUUID(), connectionId: null, encounterId: null, payload: {} };
  await assert.rejects(invoke({ ...event, senderFrame: { url: renderer.mainFrame.url } }, read), /unavailable/);
  await assert.rejects(invoke({ ...event, sender: { ...renderer, id: 78 } }, read), /unavailable/);
  renderer.mainFrame.url = "https://example.invalid/";
  await assert.rejects(invoke(event, read), /unavailable/); renderer.mainFrame.url = "app://cosmas/provider.html";
  assert.equal(authReads, 0);
  await assert.rejects(invoke(event, read), error => error.message === "Desktop provider workspace is unavailable.");
  failListener = false;
  dispose = module.namespace.mountDesktopProviderApplication(root, exposed.scribeProvider, exposed.scribeRecorder);
  await until(() => root.querySelector(action("open"))); click(action("create")); await until(() => creates === 1 && root.querySelector(action("open")));
  click(action("open")); await until(() => root.querySelector('[data-review-action="accepted"]'));
  assert.equal(root.querySelector('[data-review-action="continue"]'), null);
  click('[data-review-action="accepted"]'); await until(() => root.querySelector('[data-review-action="continue"]'));
  assert.equal(decisions.length, 1); assert.equal(pendingReview, null);
  click('[data-review-action="continue"]'); await until(() => root.querySelector('[name="schema"]'));
  root.querySelector('[name="schema"]').value = schema; click(action("read")); await until(() => root.querySelector(action("generate")));
  click(action("generate")); await until(() => root.querySelector('[name="note-0"]'));
  root.querySelector('[name="note-0"]').value = "Invented clinician edit."; click(action("save"));
  await until(() => /Edits saved to Core/u.test(root.textContent)); assert.equal(journal.progress.pendingSave, null);
  assert.ok(journalSaves.some(progress => progress.pendingSave)); assert.equal(fields.Subjective, "Invented clinician edit.");
  click(action("core")); await until(() => navigation.length === 1); assert.equal(navigation[0], savedNote);
  change("signedOut"); assert.equal(root.textContent.includes("Invented clinician edit."), false);
  await until(() => root.querySelector('[data-session-action="sign-in"]') && closes === 1);
  assert.equal(JSON.stringify(wire).includes("invented-native-private-value"), false);
  for (const method of ["create", "open", "review_load", "review_save", "review_clear", "core", "journal_save", "open_core", "disconnect"]) assert.ok(methods.includes(method), method);
  await dispose(); dispose = null; await boundary.dispose();
  assert.equal(authObservers.size, 0); assert.equal(handlers.size, 0); assert.equal(rendererEvents.eventNames().length, 0);
  process.stdout.write(JSON.stringify({ checks: 3, compiled_provider_ui: true, actual_main_preload_mapping: true, sender_rejection_before_native_access: true,
    explicit_review_before_note: true, journaled_note_edit_and_core_navigation: true, revocation_clears_content: true,
    actual_electron: false, real_backend: false, physical_recording: false }) + "\n");
} finally { await dispose?.(); await boundary.dispose(); dom.window.close(); }
