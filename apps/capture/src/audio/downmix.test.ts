import { describe, expect, it } from "vitest";

import { downmixToMono } from "./downmix";

describe("downmixToMono", () => {
  it("averages every available input channel without changing frame count", () => {
    expect(
      downmixToMono([
        Float32Array.of(-1, -0.5, 0, 0.5, 1),
        Float32Array.of(1, 0.5, 0, -0.5, -1),
      ]),
    ).toEqual(Float32Array.of(0, 0, 0, 0, 0));
  });

  it("fails closed on missing, uneven, or non-finite channel data", () => {
    expect(() => downmixToMono([])).toThrow(
      expect.objectContaining({ code: "audio_capture_invalid_pcm" }),
    );
    expect(() => downmixToMono([Float32Array.of(0), Float32Array.of(0, 1)])).toThrow(
      expect.objectContaining({ code: "audio_capture_invalid_pcm" }),
    );
    expect(() => downmixToMono([Float32Array.of(Number.NaN)])).toThrow(
      expect.objectContaining({ code: "audio_capture_invalid_pcm" }),
    );
  });
});
