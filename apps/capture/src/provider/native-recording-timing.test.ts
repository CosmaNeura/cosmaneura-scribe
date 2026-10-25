import { describe, expect, it, vi } from "vitest";
import { NativeClockMapper, correlateNativeEvent, parseNativeTimingSample, type NativeTimingSample } from "./native-recording-timing";
const sample = (ns: string, captureAttempt = 1): NativeTimingSample => ({ version: 1, clock: "dispatch-uptime-ns", monotonicNs: ns, captureAttempt, droppedEvents: 0 });
const observation = (revision: number, ns: string, sent: number, received: number, captureAttempt = 1) => ({
  sessionId: "session-a", recorderId: "recorder-a", revision, sample: sample(ns, captureAttempt), sentAtRendererMs: sent, receivedAtRendererMs: received });
describe("native clock correlation", () => {
  it("reports transport-only estimates despite wall-clock jumps without asserting renderer precision", () => {
    const wall = vi.spyOn(Date, "now").mockReturnValue(50_000), mapper = new NativeClockMapper("session-a", "recorder-a");
    try {
      const first = mapper.observe(observation(1, "1000000000", 100, 110))!;
      expect(first.transportRoundTripMs).toBe(10); expect(first.transportBracketWidthMs).toBe(10);
      expect(first.uncertaintyMs).toBeNull(); expect(first.rendererTimestampResolutionMs).toBeNull();
      wall.mockReturnValue(-50_000);
      const second = mapper.observe(observation(2, "1100000000", 205, 208))!;
      expect(second.estimatedRendererAtAnchorLowerMs).toBe(105); expect(second.estimatedRendererAtAnchorUpperMs).toBe(108);
      expect(second.transportBracketWidthMs).toBe(3); expect(second.uncertaintyMs).toBeNull();
      expect(correlateNativeEvent({ monotonicNs: "1050000000", captureAttempt: 1 }, second)).toEqual({
        qualification: "NOT_ESTABLISHED", estimatedLowerMs: 155, estimatedUpperMs: 158, uncertaintyMs: null, nativeOffsetFromAnchorMs: 50 });
      expect(wall).not.toHaveBeenCalled();
    } finally { wall.mockRestore(); }
  });
  it("isolates late revisions and foreign sessions/recorders and distinguishes capture attempts", () => {
    const mapper = new NativeClockMapper("session-a", "recorder-a");
    mapper.observe(observation(2, "1000000000", 100, 110));
    expect(mapper.observe(observation(1, "900000000", 0, 10))).toBeUndefined();
    expect(mapper.observe({ ...observation(3, "1100000000", 200, 210), sessionId: "session-b" })).toBeUndefined();
    expect(mapper.observe({ ...observation(3, "1100000000", 200, 210), recorderId: "recorder-b" })).toBeUndefined();
    const next = mapper.observe(observation(3, "1100000000", 202, 208, 2))!;
    expect(next.sample.captureAttempt).toBe(2);
    expect(correlateNativeEvent({ monotonicNs: "1050000000", captureAttempt: 1 }, next)).toBeNull();
    expect(correlateNativeEvent({ monotonicNs: "1200000000", captureAttempt: 2 }, next)).toBeNull();
  });
  it("fails diagnostics closed after a native clock regression or inconsistent clock domains", () => {
    for (const bad of [observation(2, "999999999", 110, 120), observation(2, "1100000000", 900, 910), observation(2, "1100000000", 200, 210, 0)]) {
      const mapper = new NativeClockMapper("session-a", "recorder-a"); mapper.observe(observation(1, "1000000000", 100, 110));
      expect(mapper.observe(bad)).toBeUndefined();
      expect(mapper.observe(observation(3, "1200000000", 300, 310))).toBeUndefined();
    }
  });
  it("preserves nanosecond precision near uint64 maximum by subtracting integer anchors first", () => {
    const mapper = new NativeClockMapper("session-a", "recorder-a"), anchor = 18_446_744_073_600_000_000n;
    mapper.observe(observation(1, anchor.toString(), 100, 102));
    const end = mapper.observe(observation(2, (anchor + 1_000_000n).toString(), 101, 103))!;
    expect(correlateNativeEvent({ monotonicNs: (anchor + 500_000n).toString(), captureAttempt: 1 }, end)).toEqual({
      qualification: "NOT_ESTABLISHED", estimatedLowerMs: 100.5, estimatedUpperMs: 102.5, uncertaintyMs: null, nativeOffsetFromAnchorMs: 0.5 });
  });
  it("never qualifies equal quantized renderer timestamps as zero uncertainty", () => {
    const mapper = new NativeClockMapper("session-a", "recorder-a");
    const result = mapper.observe(observation(1, "1000000000", 100, 100))!;
    expect(result.transportRoundTripMs).toBe(0); expect(result.transportBracketWidthMs).toBe(0);
    expect(result.qualification).toBe("NOT_ESTABLISHED");
    expect(result.rendererTimestampResolutionMs).toBeNull(); expect(result.uncertaintyMs).toBeNull();
    expect(correlateNativeEvent({ monotonicNs: "1000000000", captureAttempt: 1 }, result)?.qualification).toBe("NOT_ESTABLISHED");
    // Quantization can also make transport-only intersections inconsistent.
    // Losing an estimate must not produce a qualified, artificially widened one.
    expect(mapper.observe(observation(2, "1000500000", 100, 100))).toBeUndefined();
  });
  it("retains dropped-event evidence within an attempt and permits only a new attempt to reset it", () => {
    const first = { ...observation(1, "1000000000", 100, 110), sample: { ...sample("1000000000"), droppedEvents: 3 } };
    const mapper = new NativeClockMapper("session-a", "recorder-a");
    mapper.observe(first);
    expect(mapper.observe(observation(2, "1100000000", 200, 210))).toBeUndefined();
    expect(mapper.observe(observation(3, "1200000000", 300, 310, 2))).toBeUndefined();
    const fresh = new NativeClockMapper("session-a", "recorder-a");
    fresh.observe(first);
    expect(fresh.observe(observation(2, "1100000000", 200, 210, 2))?.sample.droppedEvents).toBe(0);
  });
  it.each([{ version: 2 }, { clock: "utc" }, { monotonicNs: "-1" }, { monotonicNs: "01" }, { monotonicNs: "1.5" },
    { monotonicNs: "18446744073709551616" }, { captureAttempt: -1 }, { droppedEvents: NaN }, { extra: "private" }])("rejects malformed or expanded native clock data %o", patch => {
    expect(() => parseNativeTimingSample({ ...sample("1"), ...patch })).toThrow("native_timing_invalid");
  });
});
