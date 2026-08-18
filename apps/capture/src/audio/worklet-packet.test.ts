import { describe, expect, it } from "vitest";

import { encodeWorkletPacket } from "./worklet-packet";

describe("encodeWorkletPacket", () => {
  it("emits an explicit discontinuity when an AudioWorklet quantum has no input", () => {
    expect(encodeWorkletPacket(undefined, 7)).toEqual({
      message: { type: "discontinuity", version: 1, sequence: 7 },
      transfer: [],
    });
    expect(encodeWorkletPacket([], 8)).toEqual({
      message: { type: "discontinuity", version: 1, sequence: 8 },
      transfer: [],
    });
  });

  it("downmixes a present quantum and transfers its exact frame buffer", () => {
    const packet = encodeWorkletPacket(
      [Float32Array.of(-1, 0, 1), Float32Array.of(1, 0, -1)],
      3,
    );
    expect(packet.message).toMatchObject({ type: "pcm", version: 1, sequence: 3 });
    if (packet.message.type !== "pcm") throw new Error("expected PCM packet");
    expect(new Float32Array(packet.message.frames)).toEqual(Float32Array.of(0, 0, 0));
    expect(packet.transfer).toEqual([packet.message.frames]);
  });
});
