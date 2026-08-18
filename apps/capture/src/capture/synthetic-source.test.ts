import { afterEach, describe, expect, it, vi } from "vitest";

import type { CaptureCapabilities } from "../bff/contracts";
import { SilentSyntheticCaptureSource } from "./synthetic-source";

const capabilities: CaptureCapabilities = {
  protocol_version: "1.0",
  media: {
    media_type: "audio/wav",
    encoding: "pcm_s16le",
    channels: 1,
    sample_rate_hz: 16_000,
  },
  target_chunk_duration_ms: 10_000,
  max_envelope_bytes: 327_680,
  max_chunks: 1_000,
  remaining_aggregate_plaintext_bytes: 67_108_864,
  capture_lease_ttl_seconds: 900,
  reservation_window_seconds: 900,
  max_reservations_per_batch: 90,
  upload_concurrency: 2,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("SilentSyntheticCaptureSource", () => {
  it("derives timing and WAV framing from the capability bootstrap", async () => {
    vi.useFakeTimers();
    const source = new SilentSyntheticCaptureSource();
    const chunks: Uint8Array[] = [];

    await source.start({
      capabilities,
      onChunk: async (chunk) => {
        expect(chunk.sequenceNumber).toBe(0);
        expect(chunk.durationMs).toBe(capabilities.target_chunk_duration_ms);
        chunks.push(chunk.wavBytes);
      },
    });
    await vi.advanceTimersByTimeAsync(capabilities.target_chunk_duration_ms);
    await source.stop();

    expect(chunks).toHaveLength(1);
    const wav = chunks[0];
    expect(new TextDecoder().decode(wav?.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav?.subarray(8, 12))).toBe("WAVE");
    expect(new DataView(wav?.buffer ?? new ArrayBuffer(0)).getUint32(24, true)).toBe(
      capabilities.media.sample_rate_hz,
    );
    expect(wav?.byteLength).toBe(44 + 160_000 * 2);
  });

  it("fails closed when the advertised chunk cannot fit the envelope limit", async () => {
    const source = new SilentSyntheticCaptureSource();
    await expect(source.start({
      capabilities: { ...capabilities, max_envelope_bytes: 1_024 },
      onChunk: async () => undefined,
    })).rejects.toThrow("server-advertised envelope limit");
  });
});
