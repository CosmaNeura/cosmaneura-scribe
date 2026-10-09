import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const categories = new Set(["expect", "fixture", "hook", "pw:api", "test.step", "test.attach"]);
const sources = new Set(["capture-flow.pw.mjs", "capture-accessibility.pw.mjs", "capture-page.mjs", "wire-journal.mjs", "envelope-contract.mjs", "provider-note.pw.mjs", "note-server.mjs", "provider-startup.pw.mjs"]);
const phases = new Set(["open", "prepare", "start", "cancel_start", "resume", "durable_chunk", "recover", "stop_upload", "complete", "accessibility", "note_open", "note_save", "note_reopen", "note_recover"]);
const statuses = new Set(["passed", "failed", "timedOut", "skipped", "interrupted"]);

/** Deliberate allowlist: never serialize titles, errors, output, payloads or attachments. */
export default class TimingReporter {
  tests = new Map();
  steps = [];
  results = [];
  errors = 0;
  expectedTests = 0;

  onBegin(_config, suite) { this.expectedTests = suite.allTests().length; }
  onTestBegin(test) { this.tests.set(test.id, this.tests.size + 1); }
  onStepEnd(test, _result, step) {
    const file = basename(step.location?.file ?? "");
    this.steps.push({
      test: this.tests.get(test.id),
      category: categories.has(step.category) ? step.category : "other",
      phase: step.category === "test.step" && phases.has(step.title) ? step.title : null,
      file: sources.has(file) ? file : "framework",
      line: sources.has(file) ? step.location.line : null,
      duration_ms: step.duration,
      failed: Boolean(step.error),
    });
  }
  onTestEnd(test, result) {
    const row = { test: this.tests.get(test.id), status: statuses.has(result.status) ? result.status : "failed",
      retry: result.retry, duration_ms: result.duration };
    this.results.push(row);
    process.stdout.write(`Synthetic test ${row.test}: ${row.status}; ${row.duration_ms} ms\n`);
  }
  onStdOut() {}
  onStdErr() {}
  onError() { this.errors += 1; }
  onEnd(result) {
    const path = process.env.SCRIBE_TIMING_REPORT;
    if (!path) throw new Error("timing_report_destination_required");
    const commit = process.env.SCRIBE_TEST_COMMIT ?? "";
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({
      schema_version: 1, recorded_at: new Date().toISOString(),
      source_commit: /^[0-9a-f]{40}$/u.test(commit) ? commit : null,
      scope: "loopback mock BFF and fake browser microphone; no native or staging acceptance",
      status: statuses.has(result.status) ? result.status : "failed",
      expected_tests: this.expectedTests, global_error_count: this.errors,
      tests: this.results, steps: this.steps,
    }, null, 2) + "\n", { mode: 0o600 });
  }
}
