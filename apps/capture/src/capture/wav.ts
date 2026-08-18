import type { CaptureCapabilities } from "../bff/contracts";

const RIFF_PCM_HEADER_BYTES = 44;
const PCM16_BYTES_PER_SAMPLE = 2;

export interface Pcm16WavProfile {
  readonly sampleRateHz: number;
  readonly channels: 1;
  readonly targetChunkDurationMs: number;
  readonly maxEnvelopeBytes: number;
}

export function pcm16WavProfile(capabilities: CaptureCapabilities): Pcm16WavProfile {
  if (
    capabilities.media.media_type !== "audio/wav" ||
    capabilities.media.encoding !== "pcm_s16le" ||
    capabilities.media.channels !== 1 ||
    !Number.isSafeInteger(capabilities.media.sample_rate_hz) ||
    capabilities.media.sample_rate_hz <= 0 ||
    !Number.isSafeInteger(capabilities.target_chunk_duration_ms) ||
    capabilities.target_chunk_duration_ms <= 0 ||
    !Number.isSafeInteger(capabilities.max_envelope_bytes) ||
    capabilities.max_envelope_bytes <= RIFF_PCM_HEADER_BYTES
  ) {
    throw new Error("capture capabilities do not describe a supported PCM16 WAV profile");
  }

  return {
    sampleRateHz: capabilities.media.sample_rate_hz,
    channels: capabilities.media.channels,
    targetChunkDurationMs: capabilities.target_chunk_duration_ms,
    maxEnvelopeBytes: capabilities.max_envelope_bytes,
  };
}

export function targetFrameCount(profile: Pcm16WavProfile): number {
  const numerator = profile.sampleRateHz * profile.targetChunkDurationMs;
  if (!Number.isSafeInteger(numerator) || numerator % 1_000 !== 0) {
    throw new Error("capture chunk duration does not resolve to a whole PCM frame count");
  }
  const frames = numerator / 1_000;
  const wavBytes = RIFF_PCM_HEADER_BYTES + frames * profile.channels * PCM16_BYTES_PER_SAMPLE;
  if (!Number.isSafeInteger(wavBytes) || wavBytes > profile.maxEnvelopeBytes) {
    throw new Error("capture chunk exceeds the server-advertised envelope limit");
  }
  return frames;
}

export function encodePcm16MonoWav(
  samples: Int16Array<ArrayBuffer>,
  profile: Pcm16WavProfile,
): Uint8Array<ArrayBuffer> {
  if (profile.channels !== 1) {
    throw new Error("only mono PCM16 WAV capture is supported");
  }
  const dataBytes = samples.length * PCM16_BYTES_PER_SAMPLE;
  const byteLength = RIFF_PCM_HEADER_BYTES + dataBytes;
  if (!Number.isSafeInteger(byteLength) || byteLength > profile.maxEnvelopeBytes) {
    throw new Error("capture WAV exceeds the server-advertised envelope limit");
  }

  const output = new Uint8Array(new ArrayBuffer(byteLength));
  const view = new DataView(output.buffer);
  writeAscii(output, 0, "RIFF");
  view.setUint32(4, byteLength - 8, true);
  writeAscii(output, 8, "WAVE");
  writeAscii(output, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, profile.channels, true);
  view.setUint32(24, profile.sampleRateHz, true);
  view.setUint32(28, profile.sampleRateHz * profile.channels * PCM16_BYTES_PER_SAMPLE, true);
  view.setUint16(32, profile.channels * PCM16_BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeAscii(output, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(RIFF_PCM_HEADER_BYTES + index * PCM16_BYTES_PER_SAMPLE, samples[index] ?? 0, true);
  }
  return output;
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    target[offset + index] = value.charCodeAt(index);
  }
}
