import { describe, expect, it } from "vitest";

import { Pcm16Chunker } from "./pcm-chunker";

describe("Pcm16Chunker", () => {
  it("extends a partial chunk without resetting its position or exceeding the original hard budget", () => {
    const chunker = new Pcm16Chunker({ targetFramesPerChunk: 2, maximumChunks: 1, hardMaximumChunks: 3 });
    expect(chunker.push(Int16Array.of(1))).toEqual([]);
    chunker.extend(2); chunker.extend(2);
    expect(chunker.push(Int16Array.of(2, 3, 4, 5))).toEqual([Int16Array.of(1, 2), Int16Array.of(3, 4)]);
    for (const invalid of [1, 4, NaN, 2.5]) expect(() => chunker.extend(invalid)).toThrow();
    chunker.extend(3);
    expect(chunker.finish()).toEqual(Int16Array.of(5));
    expect(() => chunker.extend(3)).toThrow();
    const legacy = new Pcm16Chunker({ targetFramesPerChunk: 2, maximumChunks: 1 });
    expect(() => legacy.extend(2)).toThrow();
    legacy.discard(); expect(() => legacy.extend(1)).toThrow();
  });
  it("preserves exact target boundaries across arbitrary worklet packets", () => {
    const chunker = new Pcm16Chunker({ targetFramesPerChunk: 4, maximumChunks: 3 });
    expect(chunker.push(Int16Array.of(1, 2, 3))).toEqual([]);
    expect(chunker.push(Int16Array.of(4, 5, 6, 7, 8, 9))).toEqual([
      Int16Array.of(1, 2, 3, 4),
      Int16Array.of(5, 6, 7, 8),
    ]);
    expect(chunker.finish()).toEqual(Int16Array.of(9));
  });

  it("does not emit an empty final chunk", () => {
    const chunker = new Pcm16Chunker({ targetFramesPerChunk: 2, maximumChunks: 1 });
    expect(chunker.push(Int16Array.of(1, 2))).toHaveLength(1);
    expect(chunker.finish()).toBeNull();
  });

  it("fails closed at the capability-derived chunk bound", () => {
    const chunker = new Pcm16Chunker({ targetFramesPerChunk: 2, maximumChunks: 1 });
    expect(chunker.push(Int16Array.of(1, 2))).toHaveLength(1);
    expect(() => chunker.push(Int16Array.of(3, 4))).toThrow(
      expect.objectContaining({ code: "audio_capture_output_limit_exceeded" }),
    );
  });

  it("discards an incomplete plaintext chunk and seals the chunker", () => {
    const chunker = new Pcm16Chunker({ targetFramesPerChunk: 4, maximumChunks: 1 });
    expect(chunker.push(Int16Array.of(1, 2))).toEqual([]);
    chunker.discard();
    expect(() => chunker.push(Int16Array.of(3, 4))).toThrow(
      expect.objectContaining({ code: "audio_capture_already_closed" }),
    );
  });
});
