// Structured deterministic assertion; stdout is only the Python metadata report.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";

export default function assertEvidence(output, context) {
  const python = context.vars?.python_executable;
  const manifest = context.vars?.fixture_manifest;
  if (!isAbsolute(python ?? "") || !isAbsolute(manifest ?? ""))
    return { pass: false, score: 0, reason: "evaluation_runtime_required" };
  const result = spawnSync(python, [fileURLToPath(new URL("./evaluate.py", import.meta.url)), "grade", "--manifest", manifest], {
    input: typeof output === "string" ? output : JSON.stringify(output), timeout: 15000, maxBuffer: 1048576, encoding: "utf8",
  });
  try {
    const report = JSON.parse(result.stdout);
    const pass = result.status === 0 && report.quality_checks_pass === true;
    return { pass, score: pass ? 1 : 0, reason: pass ? "fixed_reference_checks_passed" : "fixed_reference_check_failed",
      metadata: { wer: report.wer, checks: report.checks, clinical_correctness_proven: false } };
  } catch { return { pass: false, score: 0, reason: "evaluation_unconfirmed" }; }
}
