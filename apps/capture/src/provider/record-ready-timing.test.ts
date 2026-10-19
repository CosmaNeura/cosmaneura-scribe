import { describe, expect, it, vi } from "vitest";
import type { ProviderRecorderController, ProviderRecorderSnapshot } from "../provider-binding";
import { beginRecordReadyTiming, startWithRecordReadyTiming, validRecordReadyDuration } from "./record-ready-timing";

function fixture() {
  let now = 100;
  let snapshot: ProviderRecorderSnapshot = { sessionId: "synthetic-session", state: "ready", statusCode: "capture_ready",
    recordedChunks: 0, queuedChunks: 0, elapsedSeconds: 0, remainingBudgetSeconds: null, remainingAuthoritySeconds: null,
    transcript: null, transcriptionStatus: null, native: { phase: "ready", busy: false } };
  const report = vi.fn(), clock = { now: () => now };
  const start = vi.fn(async () => { snapshot = { ...snapshot, state: "recording", native: { phase: "recording", busy: false } }; });
  const controller: ProviderRecorderController = { get snapshot() { return snapshot; }, startRecording: start,
    stopRecording: async () => undefined, refreshTranscriptionStatus: async () => undefined, subscribe: () => () => undefined };
  return { controller, report, start, clock, advance: (value: number) => { now = value; },
    set: (value: Partial<ProviderRecorderSnapshot>) => { snapshot = { ...snapshot, ...value }; } };
}
function gate() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }

describe("first explicit Record to confirmed native Ready", () => {
  it("includes queue, admission and recorder creation time in the original action and reports once", async () => {
    const f = fixture(), timing = beginRecordReadyTiming(f.report, f.clock);
    f.advance(3100); // Queued consent/admission finishes; no new timer is created.
    f.advance(4100); // Recorder creation finishes.
    f.start.mockImplementation(async () => { f.advance(5600); f.set({ state: "recording", native: { phase: "recording", busy: false } }); });
    await startWithRecordReadyTiming(f.controller, timing, () => true);
    timing.confirm(f.controller.snapshot);
    expect(f.report.mock.calls).toEqual([[5500]]); expect(f.start).toHaveBeenCalledOnce();
  });
  it("requires confirmed native recording rather than a resolved command or a preparing/starting state", async () => {
    for (const phase of ["ready", "starting", "paused", "failed"]) {
      const f = fixture(); f.start.mockImplementation(async () => { f.set({ native: { phase, busy: false } }); });
      await startWithRecordReadyTiming(f.controller, beginRecordReadyTiming(f.report, f.clock), () => true);
      expect(f.report).not.toHaveBeenCalled();
    }
  });
  it("does not turn failed Start, cancellation, revocation or view replacement into a success", async () => {
    const f = fixture(); f.start.mockRejectedValueOnce(new Error("Synthetic failure"));
    await expect(startWithRecordReadyTiming(f.controller, beginRecordReadyTiming(f.report, f.clock), () => true)).rejects.toThrow();
    const held = gate(); let current = true;
    f.start.mockImplementation(async () => { await held.promise; f.set({ state: "recording", native: { phase: "recording", busy: false } }); });
    const starting = startWithRecordReadyTiming(f.controller, beginRecordReadyTiming(f.report, f.clock), () => current);
    current = false; held.resolve(); await starting;
    expect(f.report).not.toHaveBeenCalled();
  });
  it("excludes Resume, recovered audio, already recording and generic/synthetic sources", async () => {
    for (const update of [{ state: "paused" as const }, { recordedChunks: 1 }, { elapsedSeconds: 1 },
      { state: "recording" as const }, { native: { phase: "unopened", busy: false } }]) {
      const f = fixture(); f.set(update);
      await startWithRecordReadyTiming(f.controller, beginRecordReadyTiming(f.report, f.clock), () => true);
      expect(f.report).not.toHaveBeenCalled();
    }
  });
  it("isolates overlapping action tokens and never reuses a cancelled token", async () => {
    const f = fixture(), first = beginRecordReadyTiming(f.report, f.clock); f.advance(200);
    const second = beginRecordReadyTiming(f.report, f.clock); first.cancel(); f.advance(400);
    await startWithRecordReadyTiming(f.controller, second, () => true); first.confirm(f.controller.snapshot);
    expect(f.report.mock.calls).toEqual([[200]]);
  });
  it("bounds numeric output and suppresses clock/export exceptions without changing Start", async () => {
    for (const invalid of [-1, Infinity, NaN, 3_600_001, "1", true, {}]) expect(validRecordReadyDuration(invalid)).toBe(false);
    for (const valid of [0, 1.25, 3_600_000]) expect(validRecordReadyDuration(valid)).toBe(true);
    const f = fixture(), badClock = { now: () => { throw new Error("Unavailable clock"); } };
    await startWithRecordReadyTiming(f.controller, beginRecordReadyTiming(f.report, badClock), () => true);
    expect(f.report).not.toHaveBeenCalled();
    f.set({ state: "ready", native: { phase: "ready", busy: false } });
    const timing = beginRecordReadyTiming(() => { throw new Error("Unavailable export"); }, f.clock);
    await expect(startWithRecordReadyTiming(f.controller, timing, () => true)).resolves.toBeUndefined();
  });
});
