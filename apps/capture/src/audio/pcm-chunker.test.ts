import { describe, expect, it } from "vitest";

import { Pcm16Chunker } from "./pcm-chunker";

describe("Pcm16Chunker", () => {
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
