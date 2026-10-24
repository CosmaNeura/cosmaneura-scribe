import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import CoreWorkflowProvider from "./core-provider.mjs";
import assertEvidence from "./assertion.mjs";
import { makeSuite } from "./suite.mjs";
import { createRequire } from "node:module";
import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const [python, manifest, runtime] = process.argv.slice(2);
const truth = JSON.parse(await readFile(new URL("./visit.json", import.meta.url)));
const context = { vars: { case_id: truth.case_id, python_executable: python, fixture_manifest: manifest } };
try {
  for (const config of [{}, { token: "unsupported" }, { endpoint: "https://unsupported.invalid" },
    { brokerModule: "relative.js", fixtureManifest: manifest, schemaRef: "doctor_note_schema_01j00000000000000000000000" }]) {
    const result = await new CoreWorkflowProvider({ config }).callApi(truth.case_id, context);
    assert.equal(result.error, "evaluation_prerequisite_or_service_unconfirmed");
    assert.equal(result.metadata.live_success_claimed, false);
  }
  const fixture = { synthetic_only: true, case_id: truth.case_id, evidence_kind: "fixture_self_check",
    consent_record_id: truth.consent_record_id, fixture_consent_record_id: truth.consent_record_id,
    transcript: truth.turns, draft: { fields: truth.reference_note }, silence_transcript: [] };
  const binding = JSON.parse(await readFile(manifest));
  Object.assign(fixture, { truth_sha256: binding.truth_sha256, audio_sha256: binding.files["visit.wav"],
    silence_audio_sha256: binding.files["silence.wav"] });
  assert.equal(assertEvidence({ ...fixture, audio_sha256: "0".repeat(64) }, context).pass, false);
  assert.equal(assertEvidence(fixture, { vars: {} }).pass, false);
  const pythonResult = spawnSync(python, [fileURLToPath(new URL("./evaluate.py", import.meta.url)), "self-check"], { encoding: "utf8", timeout: 15000 });
  assert.equal(pythonResult.status, 0);
  assert.equal(JSON.parse(pythonResult.stdout).status, "fixture_self_checks_passed");
  const suite = await makeSuite({ brokerModule: fileURLToPath(new URL("./core-provider.mjs", import.meta.url)),
    fixtureManifest: manifest, schemaRef: "doctor_note_schema_01j00000000000000000000000", pythonExecutable: python,
    judgeProvider: "fixture-only-unused-judge" });
  assert.equal(suite.tests[0].assert.length, 2);
  assert.ok(suite.tests[0].assert[1].value.includes(truth.rubric));
  assert.equal((await makeSuite({ brokerModule: suite.providers[0].config.brokerModule, fixtureManifest: manifest,
    schemaRef: suite.providers[0].config.schemaRef, pythonExecutable: python })).tests[0].assert.length, 1);
  assert.equal(process.env.PROMPTFOO_DISABLE_TELEMETRY, "1");
  assert.ok(isAbsolute(process.env.PROMPTFOO_CONFIG_DIR ?? ""));
  const require = createRequire(resolve(runtime, "package.json"));
  const { evaluate } = await import(pathToFileURL(require.resolve("promptfoo")).href);
  const provider = { id: () => "offline-invented-evidence", async callApi(_prompt, c) {
    const output = structuredClone(fixture);
    if (c.vars.variant === "missing-plan") output.draft.fields.Plan = "";
    if (c.vars.variant === "wrong-followup") output.draft.fields.Plan = "Follow up in six weeks.";
    if (c.vars.variant === "silence") output.silence_transcript = ["Invented hallucination"];
    return { output };
  } };
  const evaluated = await evaluate({ writeLatestResults: false, sharing: false, prompts: [truth.case_id], providers: [provider],
    tests: ["good", "missing-plan", "wrong-followup", "silence"].map(variant => ({ vars: { ...context.vars, variant },
      assert: [{ type: "javascript", value: new URL("./assertion.mjs", import.meta.url).href }] })) },
  { cache: false, maxConcurrency: 1, showProgressBar: false });
  const summary = await evaluated.toEvaluateSummary();
  assert.equal(summary.stats.successes, 1); assert.equal(summary.stats.failures, 3);
  console.log('{"status":"evaluation_adapter_self_checks_passed","live_services_run":false,"promptfoo_cases":4,"expected_negative_results":3}');
} catch { console.log('{"status":"evaluation_adapter_self_checks_failed"}'); process.exitCode = 1; }
