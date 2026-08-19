import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  AreaWeightedPcm16Resampler,
  PCM_RESAMPLER_VERSION,
  pcm16ToLittleEndianBytes,
} from "./resampler";

interface GoldenFixture {
  readonly version: string;
  readonly source_sample_rate_hz: number;
  readonly target_sample_rate_hz: number;
  readonly input_pcm_f32le_hex: string;
  readonly input_push_frame_counts: readonly number[];
  readonly expected_pcm_s16le_hex: string;
}

describe("AreaWeightedPcm16Resampler", () => {
  it("matches the committed PCM input to exact PCM16 output golden bytes", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../../testdata/audio/resampler-area-weighted-v1.json", import.meta.url),
        "utf8",
      ),
    ) as GoldenFixture;
    expect(fixture.version).toBe(PCM_RESAMPLER_VERSION);
    const input = decodeFloat32LittleEndian(fixture.input_pcm_f32le_hex);
    expect(
      fixture.input_push_frame_counts.reduce((total, count) => total + count, 0),
    ).toBe(input.length);

    const resampler = new AreaWeightedPcm16Resampler({
      sourceSampleRateHz: fixture.source_sample_rate_hz,
      targetSampleRateHz: fixture.target_sample_rate_hz,
      maximumInputFrames: input.length,
      maximumOutputFrames: input.length,
    });
    const output: number[] = [];
    let inputOffset = 0;
    for (const frameCount of fixture.input_push_frame_counts) {
      output.push(
        ...resampler.push(
          input.slice(inputOffset, inputOffset + frameCount),
        ),
      );
      inputOffset += frameCount;
    }
    output.push(...resampler.finish());

    expect(
      Buffer.from(pcm16ToLittleEndianBytes(Int16Array.from(output))).toString("hex"),
    ).toBe(fixture.expected_pcm_s16le_hex);
  });

  it("is invariant to AudioWorklet message boundaries", () => {
    const input = Float32Array.from({ length: 101 }, (_value, index) =>
      Math.sin(index / 7),
    );
    const together = resample(input, [input.length]);
    const divided = resample(input, [1, 2, 17, 3, 41, 37]);
    expect(divided).toEqual(together);
  });

  it("uses a partial period only when the stream is explicitly finished", () => {
    const resampler = new AreaWeightedPcm16Resampler({
      sourceSampleRateHz: 48_000,
      targetSampleRateHz: 16_000,
      maximumInputFrames: 2,
      maximumOutputFrames: 1,
    });
    expect(resampler.push(Float32Array.of(0.25, 0.75))).toEqual(new Int16Array());
    expect(resampler.finish()).toEqual(Int16Array.of(16_384));
  });

  it("fails closed before exceeding capability-derived input or output bounds", () => {
    const inputBounded = new AreaWeightedPcm16Resampler({
      sourceSampleRateHz: 48_000,
      targetSampleRateHz: 16_000,
      maximumInputFrames: 2,
      maximumOutputFrames: 1,
    });
    expect(() => inputBounded.push(Float32Array.of(0, 0, 0))).toThrow(
      expect.objectContaining({ code: "audio_capture_input_limit_exceeded" }),
    );

    const outputBounded = new AreaWeightedPcm16Resampler({
      sourceSampleRateHz: 16_000,
      targetSampleRateHz: 16_000,
      maximumInputFrames: 1,
      maximumOutputFrames: 0,
    });
    expect(() => outputBounded.push(Float32Array.of(0))).toThrow(
      expect.objectContaining({ code: "audio_capture_output_limit_exceeded" }),
    );
  });

  it("rejects upsampling instead of inventing source bandwidth", () => {
    expect(
      () => new AreaWeightedPcm16Resampler({
        sourceSampleRateHz: 8_000,
        targetSampleRateHz: 16_000,
        maximumInputFrames: 1,
        maximumOutputFrames: 2,
      }),
    ).toThrow(expect.objectContaining({ code: "audio_capture_invalid_configuration" }));
  });

  it("rejects non-finite samples and reuse after finish with fixed codes", () => {
    const resampler = new AreaWeightedPcm16Resampler({
      sourceSampleRateHz: 16_000,
      targetSampleRateHz: 16_000,
      maximumInputFrames: 1,
      maximumOutputFrames: 1,
    });
    expect(() => resampler.push(Float32Array.of(Number.NaN))).toThrow(
      expect.objectContaining({ code: "audio_capture_invalid_pcm" }),
    );

    const closed = new AreaWeightedPcm16Resampler({
      sourceSampleRateHz: 16_000,
      targetSampleRateHz: 16_000,
      maximumInputFrames: 0,
      maximumOutputFrames: 0,
    });
    expect(closed.finish()).toEqual(new Int16Array());
    expect(() => closed.push(new Float32Array())).toThrow(
      expect.objectContaining({ code: "audio_capture_already_closed" }),
    );
  });
});

function resample(input: Float32Array, divisions: readonly number[]): Int16Array {
  const resampler = new AreaWeightedPcm16Resampler({
    sourceSampleRateHz: 44_100,
    targetSampleRateHz: 16_000,
    maximumInputFrames: input.length,
    maximumOutputFrames: input.length,
  });
  const output: number[] = [];
  let offset = 0;
  for (const length of divisions) {
    output.push(...resampler.push(input.slice(offset, offset + length)));
    offset += length;
  }
  expect(offset).toBe(input.length);
  output.push(...resampler.finish());
  return Int16Array.from(output);
}

function decodeFloat32LittleEndian(hex: string): Float32Array {
  const encoded = Buffer.from(hex, "hex");
  expect(encoded.toString("hex")).toBe(hex);
  expect(encoded.byteLength % Float32Array.BYTES_PER_ELEMENT).toBe(0);
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  return Float32Array.from(
    { length: encoded.byteLength / Float32Array.BYTES_PER_ELEMENT },
    (_value, index) => view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true),
  );
}
