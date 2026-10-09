import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomaticProgress, canApplyReviewProgress, hasPendingReviewProgress } from "./automatic-progress";
import type { CreatorReviewView } from "./creator-review-api";

const review = (status: string, states: string[] = [], blockers: string[] = []): CreatorReviewView => ({
  status, source: status === "processing" || status === "uploaded" ? null : {},
  working: { note_ready: status === "transcript_ready", blockers: blockers.map(code => ({ code })) },
  translation_progress: states.map(state => ({ state })),
} as unknown as CreatorReviewView);

afterEach(() => { vi.useRealTimers(); });

describe("pending progress observation", () => {
  it("rejects other-session and older-version results while allowing forward progress", () => {
    const previous = { ...review("translation_pending", ["queued"]), session_id: "original",
      source: { source_transcript_version: 2 }, working: { source_transcript_version: 2, working_transcript_id: "working", working_transcript_version: 3 } } as CreatorReviewView;
    expect(canApplyReviewProgress(previous, { ...previous, session_id: "other" })).toBe(false);
    expect(canApplyReviewProgress(previous, { ...previous, source: null })).toBe(false);
    expect(canApplyReviewProgress(previous, { ...previous, source: { ...previous.source!, source_transcript_version: 1 } })).toBe(false);
    expect(canApplyReviewProgress(previous, { ...previous, working: { ...previous.working!, working_transcript_version: 2 } })).toBe(false);
    expect(canApplyReviewProgress(previous, { ...previous, working: { ...previous.working!, working_transcript_id: "other" } })).toBe(false);
    expect(canApplyReviewProgress(previous, { ...previous, working: { ...previous.working!, working_transcript_version: 4 } })).toBe(true);
  });
  it("observes actual queued/saved work, never retries rejected, unconfirmed or review-ready work", () => {
    for (const value of [review("uploaded"), review("processing"), review("translation_pending", ["queued"]), review("translation_pending", ["result_saved"])]) {
      expect(hasPendingReviewProgress(value)).toBe(true);
    }
    for (const value of [null, review("translation_pending", []), review("translation_pending", ["unconfirmed"]),
      review("review_required", ["result_saved"]), review("transcript_ready"), review("speech_retryable"),
      review("translation_pending", ["queued"], ["translation_retry_required"]), review("translation_pending", ["result_saved"], ["translation_failed"])]) {
      expect(hasPendingReviewProgress(value)).toBe(false);
    }
  });

  it("reads queued through saved to review-ready every three seconds without any write/retry port", async () => {
    vi.useFakeTimers();
    let state = review("translation_pending", ["queued"]);
    const read = vi.fn().mockResolvedValueOnce(review("translation_pending", ["result_saved"]))
      .mockResolvedValueOnce(review("review_required"));
    const stopped = vi.fn();
    const observer = new AutomaticProgress({ active: () => true, visible: () => true,
      pending: () => hasPendingReviewProgress(state), read, apply: value => { state = value as CreatorReviewView; }, stopped });
    observer.schedule();
    await vi.advanceTimersByTimeAsync(2999); expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000); expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000); expect(read).toHaveBeenCalledTimes(2); expect(stopped).not.toHaveBeenCalled();
    observer.dispose();
  });

  it("does not overlap reads and discards a response after hiding or navigation", async () => {
    vi.useFakeTimers();
    let visible = true, active = true;
    let resolve!: (value: string) => void;
    const read = vi.fn(() => new Promise<string>(done => { resolve = done; }));
    const apply = vi.fn(), stopped = vi.fn();
    const observer = new AutomaticProgress({ active: () => active, visible: () => visible, pending: () => true, read, apply, stopped });
    observer.schedule(true); await vi.advanceTimersByTimeAsync(0);
    observer.schedule(true); await vi.advanceTimersByTimeAsync(10_000); expect(read).toHaveBeenCalledTimes(1);
    visible = false; observer.pause(); resolve("stale"); await vi.advanceTimersByTimeAsync(0); expect(apply).not.toHaveBeenCalled();
    visible = true; observer.schedule(true); await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(2);
    active = false; observer.dispose(); resolve("other visit"); await vi.advanceTimersByTimeAsync(0);
    expect(apply).not.toHaveBeenCalled(); expect(stopped).not.toHaveBeenCalled();
  });

  it("counts settled request time toward the three-second cadence with a monotonic clock", async () => {
    vi.useFakeTimers();
    const starts: number[] = [], applied: number[] = [];
    const read = vi.fn(async () => {
      starts.push(performance.now());
      await new Promise(resolve => setTimeout(resolve, 1200));
      return starts.length;
    });
    const observer = new AutomaticProgress({ active: () => true, visible: () => true,
      pending: () => applied.length < 2, read, apply: value => applied.push(value), stopped: vi.fn() });
    observer.schedule(true);
    await vi.advanceTimersByTimeAsync(1200); expect(applied).toEqual([1]);
    vi.setSystemTime(Date.now() + 86_400_000); // Wall-clock changes do not accelerate observation.
    await vi.advanceTimersByTimeAsync(1799); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(starts[1]! - starts[0]!).toBe(3000);
    await vi.advanceTimersByTimeAsync(1200); expect(applied).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(30_000); expect(read).toHaveBeenCalledTimes(2);
    observer.dispose();
  });

  it("starts again only after a slow read settles, never overlapping even beyond the interval", async () => {
    vi.useFakeTimers();
    const starts: number[] = []; let inFlight = 0, maxInFlight = 0;
    const read = vi.fn(async () => {
      starts.push(performance.now()); maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise(resolve => setTimeout(resolve, 4500)); inFlight -= 1;
      return "pending";
    });
    const observer = new AutomaticProgress({ active: () => true, visible: () => true,
      pending: () => true, read, apply: vi.fn(), stopped: vi.fn() });
    observer.schedule(true);
    await vi.advanceTimersByTimeAsync(4499); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2); expect(read).toHaveBeenCalledTimes(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(4500);
    expect(starts[1]! - starts[0]!).toBeLessThanOrEqual(4501);
    expect(maxInFlight).toBe(1); observer.dispose();
  });

  it("keeps an aborted uncooperative request occupied until settlement without publishing stale scope", async () => {
    vi.useFakeTimers();
    let visible = true, active = true, resolve!: (value: string) => void;
    const read = vi.fn(() => new Promise<string>(done => { resolve = done; }));
    const apply = vi.fn(), stopped = vi.fn();
    const observer = new AutomaticProgress({ active: () => active, visible: () => visible,
      pending: () => true, read, apply, stopped });
    observer.schedule(true); await vi.advanceTimersByTimeAsync(0);
    visible = false; observer.pause(); await vi.advanceTimersByTimeAsync(3000);
    visible = true; observer.schedule(true); await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
    resolve("stale hidden response"); await vi.advanceTimersByTimeAsync(1);
    expect(apply).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(2);
    active = false; observer.pause(); resolve("stale navigated response");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(apply).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(2);
    expect(stopped).not.toHaveBeenCalled(); observer.dispose();
  });

  it("stops after an authorization failure without automatic retry or another action", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue({ status: 401 }), apply = vi.fn(), stopped = vi.fn();
    const observer = new AutomaticProgress({ active: () => true, visible: () => true,
      pending: () => true, read, apply, stopped });
    observer.schedule(true); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(read).toHaveBeenCalledTimes(1); expect(apply).not.toHaveBeenCalled();
    expect(stopped).toHaveBeenCalledTimes(1); expect(stopped).toHaveBeenCalledWith("unavailable");
    observer.dispose();
  });

  it("preserves the original five-minute budget across hidden pauses and clock changes", async () => {
    vi.useFakeTimers();
    let visible = true, active = true;
    const read = vi.fn().mockResolvedValue("pending"), stopped = vi.fn();
    const observer = new AutomaticProgress({ active: () => active, visible: () => visible,
      pending: () => true, read, apply: vi.fn(), stopped });
    observer.schedule(true); await vi.advanceTimersByTimeAsync(3000);
    visible = false; observer.pause(); vi.setSystemTime(Date.now() - 86_400_000);
    await vi.advanceTimersByTimeAsync(296_999);
    const count = read.mock.calls.length;
    visible = true; active = false; observer.schedule(true);
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(count);
    active = true; observer.schedule(true);
    expect(stopped).toHaveBeenCalledWith("deadline");
    await vi.advanceTimersByTimeAsync(30_000); expect(read).toHaveBeenCalledTimes(count);
    observer.dispose();
  });

  it("disposal after deadline cannot publish an uncooperative response or free another read", async () => {
    vi.useFakeTimers();
    let resolve!: (value: string) => void;
    const read = vi.fn(() => new Promise<string>(done => { resolve = done; })), apply = vi.fn();
    const observer = new AutomaticProgress({ active: () => true, visible: () => true,
      pending: () => true, read, apply, stopped: vi.fn() });
    observer.schedule(true); await vi.advanceTimersByTimeAsync(30_000);
    observer.dispose(); resolve("late"); await vi.advanceTimersByTimeAsync(300_000);
    expect(read).toHaveBeenCalledTimes(1); expect(apply).not.toHaveBeenCalled();
  });

  it("aborts the last in-flight read at the five-minute budget rather than granting another thirty seconds", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal, resolve!: (value: string) => void;
    const read = vi.fn((value: AbortSignal) => {
      signal = value;
      return read.mock.calls.length === 100 ? new Promise<string>(done => { resolve = done; }) : Promise.resolve("pending");
    });
    const apply = vi.fn(), stopped = vi.fn();
    const observer = new AutomaticProgress({ active: () => true, visible: () => true,
      pending: () => true, read, apply, stopped });
    observer.schedule(true); await vi.advanceTimersByTimeAsync(297_000);
    expect(read).toHaveBeenCalledTimes(100); expect(apply).toHaveBeenCalledTimes(99);
    await vi.advanceTimersByTimeAsync(3000);
    expect(signal.aborted).toBe(true); expect(stopped).toHaveBeenCalledWith("deadline");
    resolve("late at deadline"); await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(100); expect(apply).toHaveBeenCalledTimes(99);
    observer.dispose();
  });

  it("explicit restart cannot dispatch while an aborted timed-out request is unsettled", async () => {
    vi.useFakeTimers();
    let resolve!: (value: string) => void;
    const read = vi.fn(() => new Promise<string>(done => { resolve = done; }));
    const apply = vi.fn();
    const observer = new AutomaticProgress({ active: () => true, visible: () => true,
      pending: () => true, read, apply, stopped: vi.fn() });
    observer.schedule(true); await vi.advanceTimersByTimeAsync(30_000);
    observer.restart(true); await vi.advanceTimersByTimeAsync(3000);
    expect(read).toHaveBeenCalledTimes(1);
    resolve("stale failed read"); await vi.advanceTimersByTimeAsync(3001);
    expect(read).toHaveBeenCalledTimes(2); expect(apply).not.toHaveBeenCalled();
    observer.dispose();
  });

  it("halts on failure or deadline and only explicit restart resumes checks", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("pending");
    const stopped = vi.fn(), apply = vi.fn();
    const observer = new AutomaticProgress({ active: () => true, visible: () => true, pending: () => true, read, apply, stopped });
    observer.schedule(true); await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toHaveBeenCalledWith("unavailable");
    await vi.advanceTimersByTimeAsync(30_000); expect(read).toHaveBeenCalledTimes(1);
    observer.restart(true); await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300_000); expect(stopped).toHaveBeenCalledWith("deadline");
    const count = read.mock.calls.length; await vi.advanceTimersByTimeAsync(10_000); expect(read).toHaveBeenCalledTimes(count);
    observer.dispose();
  });

  it("aborts a hung read at thirty seconds without scheduling another request", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const read = vi.fn((value: AbortSignal) => { signal = value; return new Promise<string>(() => undefined); });
    const stopped = vi.fn();
    const observer = new AutomaticProgress({ active: () => true, visible: () => true, pending: () => true, read, apply: vi.fn(), stopped });
    observer.schedule(true); await vi.advanceTimersByTimeAsync(30_000);
    expect(signal.aborted).toBe(true); expect(stopped).toHaveBeenCalledWith("unavailable");
    await vi.advanceTimersByTimeAsync(60_000); expect(read).toHaveBeenCalledTimes(1);
    observer.dispose();
  });

  it("keeps editing paused and announces an expired hidden observation when it becomes visible", async () => {
    vi.useFakeTimers();
    let active = true, visible = true;
    const read = vi.fn().mockResolvedValue("pending"), apply = vi.fn(), stopped = vi.fn();
    const observer = new AutomaticProgress({ active: () => active, visible: () => visible, pending: () => true, read, apply, stopped });
    observer.schedule(); active = false; observer.pause();
    await vi.advanceTimersByTimeAsync(10_000); expect(read).not.toHaveBeenCalled();
    active = true; observer.schedule(); await vi.advanceTimersByTimeAsync(3000); expect(read).toHaveBeenCalledTimes(1);
    visible = false; observer.pause(); await vi.advanceTimersByTimeAsync(300_000);
    expect(stopped).not.toHaveBeenCalled();
    visible = true; observer.schedule(true); expect(stopped).toHaveBeenCalledWith("deadline");
    expect(read).toHaveBeenCalledTimes(1); observer.dispose();
  });
});
