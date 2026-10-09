import { describe, expect, it } from "vitest";
import type { ProviderRecorderSnapshot } from "../provider-binding";
import { settledRecorderVisitStatus } from "./recent-visit-state";

const paused: ProviderRecorderSnapshot = { sessionId: "10000000-0000-4000-8000-000000000001",
  state: "paused", statusCode: "capture_paused", recordedChunks: 1, queuedChunks: 1,
  elapsedSeconds: 2, remainingBudgetSeconds: 900, remainingAuthoritySeconds: 900,
  transcriptionStatus: null, transcript: null };

describe("recent visit physical-stop evidence", () => {
  it("requires a settled native pause, not its projected pending state", () => {
    for (const phase of ["pausing", "stopPending", "starting", "recording"]) {
      expect(settledRecorderVisitStatus({ ...paused, native: { phase, busy: false } })).toBeUndefined();
    }
    expect(settledRecorderVisitStatus({ ...paused, native: { phase: "paused", busy: true } })).toBeUndefined();
    expect(settledRecorderVisitStatus({ ...paused, native: { phase: "paused", busy: false } })).toBe("paused");
  });
  it("requires desktop stop settlement and complete physical coverage", () => {
    const desktop = { phase: "interrupted", coverage: "complete", trimmedStartMs: 0, trimmedEndMs: 0 } as const;
    expect(settledRecorderVisitStatus({ ...paused, desktop })).toBe("paused");
    for (const phase of ["stopping", "stop_unconfirmed", "starting", "recording"] as const) {
      expect(settledRecorderVisitStatus({ ...paused, desktop: { ...desktop, phase } })).toBeUndefined();
    }
    expect(settledRecorderVisitStatus({ ...paused, desktop: { ...desktop, coverage: "incomplete" } })).toBeUndefined();
  });
  it("does not turn retained/recovered/error pause projections into confirmed pauses", () => {
    for (const statusCode of ["capture_recovered_paused", "capture_start_unconfirmed", "capture_pause_unconfirmed",
      "capture_stop_acknowledgement_pending", "capture_resume_pending", "capture_interrupted"]) {
      expect(settledRecorderVisitStatus({ ...paused, statusCode })).toBeUndefined();
    }
    expect(settledRecorderVisitStatus(paused)).toBe("paused");
  });
  it("shows processing only after actual completed-capture acceptance", () => {
    expect(settledRecorderVisitStatus({ ...paused, state: "processing", statusCode: "capture_processing" })).toBe("processing");
    for (const state of ["uploading", "recording", "error", "ready"] as const) {
      expect(settledRecorderVisitStatus({ ...paused, state, statusCode: "capture_processing" })).toBeUndefined();
    }
    expect(settledRecorderVisitStatus({ ...paused, state: "processing", statusCode: "synthetic_preview_processing" })).toBeUndefined();
  });
});
