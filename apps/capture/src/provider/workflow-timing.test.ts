import { describe, expect, it, vi } from "vitest";
import { beginWorkflowTiming, type WorkflowTimingOutcome } from "./workflow-timing";

function clock() {
  return { now: vi.fn<() => number>(), clearMeasures: vi.fn(),
    measure: vi.fn(() => ({} as PerformanceMeasure)) };
}

describe("content-free workflow timings", () => {
  it("keeps overlapping actions separate and finishes an observation only once", () => {
    const c = clock(); c.now.mockReturnValueOnce(10).mockReturnValueOnce(20).mockReturnValueOnce(60).mockReturnValueOnce(80);
    const first = beginWorkflowTiming("save", c), second = beginWorkflowTiming("open", c);
    second("threw"); first("resolved"); first("threw");
    expect(c.measure.mock.calls).toEqual([
      ["scribe.ui.open.threw", { start: 20, end: 60 }],
      ["scribe.ui.save.resolved", { start: 10, end: 80 }],
    ]);
  });
  it("rejects arbitrary input and error text instead of storing it", () => {
    const c = clock(); c.now.mockReturnValue(1);
    beginWorkflowTiming("opaque-private-value", c)("resolved");
    beginWorkflowTiming("save", c)("opaque-private-value" as WorkflowTimingOutcome);
    expect(c.measure).not.toHaveBeenCalled();
  });
  it("cannot break the operation when performance APIs fail or time moves backwards", () => {
    const c = clock(); c.now.mockImplementation(() => { throw new Error("unavailable"); });
    expect(() => beginWorkflowTiming("save", c)("resolved")).not.toThrow();
    expect(() => beginWorkflowTiming("save", null)("resolved")).not.toThrow();
    c.now.mockReset().mockReturnValueOnce(2).mockReturnValueOnce(1);
    beginWorkflowTiming("save", c)("resolved"); expect(c.measure).not.toHaveBeenCalled();
    c.now.mockReset().mockReturnValue(3); c.measure.mockImplementation(() => { throw new Error("unsupported"); });
    expect(() => beginWorkflowTiming("save", c)("cancelled")).not.toThrow();
  });
  it("bounds observations without clearing unrelated performance entries", () => {
    performance.measure("unrelated-timing", { start: 0, end: 1 });
    for (let i = 0; i < 100; i++) beginWorkflowTiming("save")("resolved");
    expect(performance.getEntriesByName("scribe.ui.save.resolved")).toHaveLength(1);
    expect(performance.getEntriesByName("unrelated-timing")).toHaveLength(1);
    performance.clearMeasures("scribe.ui.save.resolved"); performance.clearMeasures("unrelated-timing");
  });
});
