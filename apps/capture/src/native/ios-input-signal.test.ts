import { describe, expect, it } from "vitest";
import { parseInputSignal, presentInputSignal, type IosInputSignal } from "./ios-input-signal";

const signal: IosInputSignal = {
  inputBuffers: 20, convertedBuffers: 20, inputEverNonzero: true, convertedEverNonzero: true,
  inputLevel: 0.125, convertedLevel: 0.125, inputAgeMs: 20, convertedAgeMs: 10,
  zeroInputMs: 0, route: "built_in",
};

describe("iPhone microphone feedback", () => {
  it("uses actual converted level, with no movement from elapsed time or input alone", () => {
    expect(presentInputSignal(signal, 0).level).toBeGreaterThan(0);
    expect(presentInputSignal({ ...signal, convertedLevel: 0 }, 0).level).toBe(0);
    expect(presentInputSignal({ ...signal, convertedEverNonzero: false }, 0).message).toContain("not reached");
  });
  it("clears stale readings on either boundary or missing bridge response", () => {
    for (const value of [{ ...signal, inputAgeMs: 1_600 }, { ...signal, convertedAgeMs: 1_600 },
      { ...signal, inputAgeMs: null }, { ...signal, convertedAgeMs: null }]) {
      expect(presentInputSignal(value, 0).level).toBe(0);
    }
    expect(presentInputSignal(signal, 1_600).level).toBe(0);
    expect(presentInputSignal(null, 0).level).toBe(0);
  });
  it("distinguishes sustained zero from quiet speech without claiming a fatal failure", () => {
    expect(presentInputSignal({ ...signal, inputLevel: 0, convertedLevel: 0 }, 0).message).toBe("Quiet input");
    expect(presentInputSignal({ ...signal, inputLevel: 0, convertedLevel: 0, zeroInputMs: 3_000 }, 0).message)
      .toBe("No input detected. If you’re speaking, pause and check the microphone.");
    expect(presentInputSignal({ ...signal, inputLevel: 0.00001, convertedLevel: 0.00001 }, 0).message).toBe("Quiet input");
  });
  it("accepts only bounded content-free metadata and fixed route labels", () => {
    expect(parseInputSignal({ version: 1, signal })).toEqual(signal);
    expect(parseInputSignal({ version: 1, signal: null })).toBeNull();
    for (const change of [{ inputLevel: NaN }, { convertedLevel: 1.1 }, { inputBuffers: -1 },
      { inputAgeMs: "recent" }, { route: "private device name" }, { route: "constructor" },
      { transcript: "unexpected" }, { inputEverNonzero: 1 }]) {
      expect(() => parseInputSignal({ version: 1, signal: { ...signal, ...change } })).toThrow();
    }
    expect(() => parseInputSignal({ version: 2, signal })).toThrow();
  });
});
