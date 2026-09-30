import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Reporter from "./timing-reporter.mjs";

test("timing evidence retains failure without leaking opaque test or request data", () => {
  const secret = "opaque-credential-transcript-sentinel";
  const previous = { report: process.env.SCRIBE_TIMING_REPORT, commit: process.env.SCRIBE_TEST_COMMIT };
  process.env.SCRIBE_TIMING_REPORT = join(mkdtempSync(join(tmpdir(), "scribe-timing-")), "result.json");
  process.env.SCRIBE_TEST_COMMIT = secret;
  try {
    const reporter = new Reporter(), item = { id: secret, title: secret };
    reporter.onBegin({}, { allTests: () => [item] });
    reporter.onTestBegin(item);
    reporter.onStepEnd(item, {}, { title: secret, category: secret, duration: 17,
      error: { message: secret }, location: { file: `/private/${secret}`, line: 1 } });
    reporter.onStdOut(secret); reporter.onStdErr(secret); reporter.onError(new Error(secret));
    reporter.onTestEnd(item, { status: "failed", retry: 0, duration: 19,
      error: { message: secret }, attachments: [{ body: secret }] });
    reporter.onEnd({ status: "failed" });
    const text = readFileSync(process.env.SCRIBE_TIMING_REPORT, "utf8"), report = JSON.parse(text);
    assert.equal(text.includes(secret), false);
    assert.equal(report.status, "failed"); assert.equal(report.global_error_count, 1);
    assert.equal(report.expected_tests, 1); assert.equal(report.tests[0].retry, 0);
    assert.equal(report.source_commit, null); assert.equal(report.steps[0].failed, true);
    assert.equal(report.steps[0].file, "framework"); assert.equal(report.steps[0].duration_ms, 17);
  } finally {
    for (const [name, value] of [["SCRIBE_TIMING_REPORT", previous.report], ["SCRIBE_TEST_COMMIT", previous.commit]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
