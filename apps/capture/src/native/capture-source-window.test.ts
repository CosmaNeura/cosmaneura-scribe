import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSourceWindow } from "./capture-source-window";

afterEach(() => vi.useRealTimers());
describe("renewable source metadata", () => {
  it("copies the initial allowance and never lets duplicate acknowledgement extend its deadline", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-27T00:00:00Z"));
    const input = { runId: "11111111-1111-4111-8111-111111111111", generation: 1,
      expiresAtMilliseconds: Date.now() + 900_000, maximumChunks: 90, hardMaximumChunks: 1228 };
    const initial = captureSourceWindow(input, 90);
    input.maximumChunks = 100;
    expect(initial.maximumChunks).toBe(90); expect(Object.isFrozen(initial)).toBe(true);
    vi.setSystemTime(Date.now() + 780_000);
    const next = captureSourceWindow({ ...initial, generation: 2, maximumChunks: 168,
      expiresAtMilliseconds: Date.now() + 900_000 }, 168, initial);
    expect(captureSourceWindow(next, 168, next)).toEqual(next);
    for (const changed of [
      { ...next, runId: "22222222-2222-4222-8222-222222222222" },
      { ...next, generation: 4 }, { ...next, generation: 1 },
      { ...next, hardMaximumChunks: 1229 }, { ...next, maximumChunks: 89 },
      { ...next, expiresAtMilliseconds: initial.expiresAtMilliseconds },
      { ...next, expiresAtMilliseconds: Date.now() + 905_001 },
      { ...next, maximumChunks: 1230 },
    ]) expect(() => captureSourceWindow(changed, changed.maximumChunks, initial)).toThrow();
    vi.setSystemTime(next.expiresAtMilliseconds);
    expect(() => captureSourceWindow(next, 168, next)).toThrow();
    expect(() => captureSourceWindow({ ...next, generation: 3, expiresAtMilliseconds: Date.now() + 900_000 }, 168, next)).toThrow();
  });
});
