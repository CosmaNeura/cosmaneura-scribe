import { afterEach, expect, it, vi } from "vitest";
import { PatientListObserver } from "./patient-list-observer";
afterEach(() => vi.useRealTimers());
it("refreshes an idle day and never overlaps a read that ignores cancellation", async () => {
  vi.useFakeTimers(); let resolve!: (value: string[]) => void;
  const read = vi.fn(() => new Promise<string[]>(done => { resolve = done; }));
  const apply = vi.fn(), unavailable = vi.fn();
  const observer = new PatientListObserver({ active: () => true, visible: () => true, pending: () => false, read, apply, unavailable });
  observer.schedule(); await vi.advanceTimersByTimeAsync(30_000); expect(read).toHaveBeenCalledTimes(1);
  observer.pause(); observer.schedule(true); await vi.advanceTimersByTimeAsync(60_000); expect(read).toHaveBeenCalledTimes(1);
  resolve(["discard late cancelled observation"]); await vi.advanceTimersByTimeAsync(0); expect(apply).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000); expect(read).toHaveBeenCalledTimes(2);
  observer.dispose(); resolve([]); await vi.advanceTimersByTimeAsync(0);
});
