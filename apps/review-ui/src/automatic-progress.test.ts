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
