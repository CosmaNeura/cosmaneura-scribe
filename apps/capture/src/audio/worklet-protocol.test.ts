import { describe, expect, it } from "vitest";

import { PcmCaptureWorkletDecoder } from "./worklet-protocol";

describe("PcmCaptureWorkletDecoder", () => {
  it("accepts finite sequential mono PCM packets", () => {
    const decoder = new PcmCaptureWorkletDecoder(3);
    expect(
      decoder.decode({
        type: "pcm",
        version: 1,
        sequence: 0,
        frames: Float32Array.of(-1, 0, 1).buffer,
      }),
    ).toEqual(Float32Array.of(-1, 0, 1));
    expect(
      decoder.decode({
        type: "pcm",
        version: 1,
        sequence: 1,
        frames: Float32Array.of(0.25).buffer,
      }),
    ).toEqual(Float32Array.of(0.25));
  });

  it.each([
    { type: "pcm", version: 2, sequence: 0, frames: Float32Array.of(0).buffer },
    { type: "pcm", version: 1, sequence: 1, frames: Float32Array.of(0).buffer },
    { type: "pcm", version: 1, sequence: 0, frames: new ArrayBuffer(3) },
    { type: "pcm", version: 1, sequence: 0, frames: new ArrayBuffer(0) },
    { type: "pcm", version: 1, sequence: 0, frames: Float32Array.of(0, 1).buffer },
    { type: "pcm", version: 1, sequence: 0, frames: Float32Array.of(Number.NaN).buffer },
    { type: "discontinuity", version: 1, sequence: 0 },
  ])("rejects malformed, discontinuous, or oversized worklet packets", (message) => {
    const decoder = new PcmCaptureWorkletDecoder(1);
    expect(() => decoder.decode(message)).toThrow(
      expect.objectContaining({ code: "audio_capture_worklet_protocol_error" }),
    );
  });
});
