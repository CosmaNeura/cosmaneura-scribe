// Promptfoo custom provider. The broker retains all native/workload credentials.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const truthPath = new URL("./visit.json", import.meta.url);
const check = condition => { if (!condition) throw new Error("evaluation_prerequisite_unavailable"); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const isUuid = value => typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(value);
const bounded = (promise, signal) => new Promise((resolve, reject) => {
  const stop = () => reject(new Error("evaluation_deadline"));
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
});

export default class CoreWorkflowProvider {
  constructor(options = {}) { this.config = options.config ?? {}; }
  id() { return "scribe-authorized-core-workflow"; }

  async callApi(prompt, context = {}) {
    const controller = new AbortController();
    let session, timer, result;
    try {
      const config = this.config;
      // No HTTP endpoint, bearer token, identity or new prompt is a supported input.
      check(Object.keys(config).every(k => ["brokerModule", "fixtureManifest", "schemaRef", "deadlineMs"].includes(k)));
      check(typeof config.brokerModule === "string" && isAbsolute(config.brokerModule));
      check(typeof config.fixtureManifest === "string" && isAbsolute(config.fixtureManifest));
      check(typeof config.schemaRef === "string" && /^doctor_note_schema_[a-z0-9]+$/u.test(config.schemaRef));
      const bytes = await readFile(truthPath), truth = JSON.parse(bytes);
      check(prompt === truth.case_id && context.vars?.case_id === truth.case_id);
      const manifest = JSON.parse(await readFile(config.fixtureManifest, "utf8"));
      check(manifest.case_id === truth.case_id && manifest.synthetic_only === true
        && manifest.truth_sha256 === hash(bytes) && manifest.consent_record_id === truth.consent_record_id);
      check(Object.keys(manifest.files).sort().join(",") === "silence.wav,visit.wav");
      for (const name of ["visit.wav", "silence.wav"])
        check(hash(await readFile(join(dirname(config.fixtureManifest), name))) === manifest.files[name]);
      const deadline = config.deadlineMs ?? 120000;
      check(Number.isSafeInteger(deadline) && deadline >= 1000 && deadline <= 180000);
      timer = setTimeout(() => controller.abort(), deadline);
      const broker = await bounded(import(pathToFileURL(config.brokerModule).href), controller.signal);
      check(broker.executionKind === "authorized-native-core" && typeof broker.openSyntheticSession === "function");
      session = await bounded(Promise.resolve(broker.openSyntheticSession({ caseId: truth.case_id,
        fixtureManifest: config.fixtureManifest, signal: controller.signal })).then(async value => {
          if (controller.signal.aborted) { await value.close(); throw new Error("evaluation_deadline"); }
          return value;
        }), controller.signal);
      check(session.syntheticOnly === true && session.caseId === truth.case_id
        && isUuid(session.sessionId) && isUuid(session.consentRecordId)
        && session.consentVerified === true && session.audioSha256 === manifest.files["visit.wav"]
        && typeof session.request === "function" && typeof session.nativeSession?.getState === "function"
        && typeof session.readSilenceResult === "function" && typeof session.close === "function");
      const initial = await bounded(session.nativeSession.getState(), controller.signal);
      check(initial.phase === "ready" && isUuid(initial.revision));
      const request = async (path, body, key, signal) => {
        check(!signal.aborted && (path.endsWith("/capture-notes")
          || path.endsWith("/capture-operations") && body.operation?.kind === "creator_review"));
        const state = await bounded(session.nativeSession.getState(), signal);
        check(state.phase === "ready" && state.revision === initial.revision);
        // The same authorized native broker supplies fresh server-side context.
        return bounded(session.request(path, body, key, signal), signal);
      };
      const [{ CoreCaptureClient }, notes, { parseCreatorReview }] = await Promise.all([
        import("../../../apps/capture/src/provider/core-client.ts"),
        import("../../../apps/capture/src/provider/core-notes.ts"),
        import("../../../apps/review-ui/src/creator-review-api.ts"),
      ]);
      const client = new CoreCaptureClient(session.scope, request, controller.signal);
      const readSource = async () => parseCreatorReview(await client.operation(session.sessionId, { kind: "creator_review" }), session.sessionId);
      const view = await readSource(), source = notes.reviewedSource(view);
      check(view.capture_continuity === undefined);
      const templates = await notes.noteTemplates(client, session.sessionId);
      check(templates.some(t => t.schema_ref === config.schemaRef && t.field_names.includes("Plan")));
      // Stable across provider/process retries for this exact session/source/template.
      let draft = await notes.parseDraft(await client.note(session.sessionId, "read", config.schemaRef), session.sessionId, config.schemaRef, source);
      if (draft.status === "not_prepared") {
        const key = "scribe-eval-prepare-" + hash(Buffer.from(JSON.stringify([
          truth.case_id, session.sessionId, source, config.schemaRef, manifest.files["visit.wav"],
        ])));
        await client.note(session.sessionId, "prepare", config.schemaRef, undefined, key);
      }
      while (draft.status !== "draft") {
        check(!controller.signal.aborted);
        await new Promise((resolve, reject) => {
          const stop = () => { clearTimeout(wait); reject(new Error("evaluation_deadline")); };
          const wait = setTimeout(() => { controller.signal.removeEventListener("abort", stop); resolve(); }, 1000);
          controller.signal.addEventListener("abort", stop, { once: true });
          if (controller.signal.aborted) stop();
        });
        draft = await notes.parseDraft(await client.note(session.sessionId, "read", config.schemaRef), session.sessionId, config.schemaRef, source);
      }
      const latest = await readSource();
      check(notes.sameSource(notes.reviewedSource(latest), source));
      const silence = await bounded(session.readSilenceResult({ signal: controller.signal }), controller.signal);
      check(silence.syntheticOnly === true && silence.audioSha256 === manifest.files["silence.wav"] && Array.isArray(silence.transcript));
      result = { output: {
        schema_version: 1, case_id: truth.case_id, synthetic_only: true,
        evidence_kind: "authorized_broker_results", consent_record_id: session.consentRecordId,
        fixture_consent_record_id: truth.consent_record_id, truth_sha256: manifest.truth_sha256,
        audio_sha256: session.audioSha256, silence_audio_sha256: silence.audioSha256,
        transcript: latest.source.segments.map(s => ({ speaker_role: s.speaker_role, content: s.content })),
        reviewed_transcript: latest.working.segments.map(s => ({ speaker_role: s.speaker_role, content: s.content })),
        draft, silence_transcript: silence.transcript,
      }, metadata: { receipt_validated: true, clinical_correctness_proven: false, native_startup_measured: false } };
    } catch {
      result = { error: "evaluation_prerequisite_or_service_unconfirmed", metadata: { live_success_claimed: false } };
    } finally {
      clearTimeout(timer);
      controller.abort();
      // Broker cleanup must never delete encounters, audio or credentials.
      if (session?.close) {
        const cleanup = new AbortController(), limit = setTimeout(() => cleanup.abort(), 5000);
        try { await bounded(session.close(), cleanup.signal); }
        catch { result = { error: "evaluation_cleanup_unconfirmed", metadata: { live_success_claimed: false } }; }
        finally { clearTimeout(limit); }
      }
    }
    return result;
  }
}
