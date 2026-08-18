import { AudioCaptureError } from "./errors";

/**
 * Versioned resampling behavior. Changing weighting, edge handling, or PCM
 * quantization requires a new version and new committed golden bytes.
 */
export const PCM_RESAMPLER_VERSION = "area-weighted-v1" as const;

export interface PcmResamplerConfiguration {
  /** Actual sample rate reported by the running AudioContext. */
  readonly sourceSampleRateHz: number;
  /** Server-advertised capture sample rate. */
  readonly targetSampleRateHz: number;
  /** Capability-derived bound for this capture, expressed at the input rate. */
  readonly maximumInputFrames: number;
  /** Capability-derived bound for this capture, expressed at the output rate. */
  readonly maximumOutputFrames: number;
}

/**
 * A streaming, allocation-bounded resampler for mono browser PCM.
 *
 * Each source sample is treated as a constant value over its sampling period.
 * A destination sample is the area-weighted mean over its exact rational
 * period. The rational phase is carried in integer ticks, so splitting the same
 * input across AudioWorklet messages cannot alter the resulting PCM bytes.
 */
export class AreaWeightedPcm16Resampler {
  readonly #sourceSampleRateHz: number;
  readonly #targetSampleRateHz: number;
  readonly #maximumInputFrames: number;
  readonly #maximumOutputFrames: number;
  #inputFrames = 0;
  #outputFrames = 0;
  #outputTicksRemaining: number;
  #weightedSampleTotal = 0;
  #weightedSampleTicks = 0;
  #closed = false;

  public constructor(configuration: PcmResamplerConfiguration) {
    if (
      !isPositiveSafeInteger(configuration.sourceSampleRateHz) ||
      !isPositiveSafeInteger(configuration.targetSampleRateHz) ||
      configuration.sourceSampleRateHz < configuration.targetSampleRateHz ||
      !isNonNegativeSafeInteger(configuration.maximumInputFrames) ||
      !isNonNegativeSafeInteger(configuration.maximumOutputFrames)
    ) {
      throw new AudioCaptureError("audio_capture_invalid_configuration");
    }
    this.#sourceSampleRateHz = configuration.sourceSampleRateHz;
    this.#targetSampleRateHz = configuration.targetSampleRateHz;
    this.#maximumInputFrames = configuration.maximumInputFrames;
    this.#maximumOutputFrames = configuration.maximumOutputFrames;
    this.#outputTicksRemaining = configuration.sourceSampleRateHz;
  }

  public get inputFrames(): number {
    return this.#inputFrames;
  }

  public get outputFrames(): number {
    return this.#outputFrames;
  }

  public push(input: Float32Array): Int16Array {
    if (this.#closed) {
      throw new AudioCaptureError("audio_capture_already_closed");
    }
    const nextInputFrames = this.#inputFrames + input.length;
    if (
      !Number.isSafeInteger(nextInputFrames) ||
      nextInputFrames > this.#maximumInputFrames
    ) {
      throw new AudioCaptureError("audio_capture_input_limit_exceeded");
    }
    const expectedOutputFrames = rationalFloor(
      nextInputFrames,
      this.#targetSampleRateHz,
      this.#sourceSampleRateHz,
    );
    if (expectedOutputFrames > this.#maximumOutputFrames) {
      throw new AudioCaptureError("audio_capture_output_limit_exceeded");
    }
    for (const sample of input) {
      if (!Number.isFinite(sample)) {
        throw new AudioCaptureError("audio_capture_invalid_pcm");
      }
    }

    const output = new Int16Array(expectedOutputFrames - this.#outputFrames);
    let outputOffset = 0;
    for (const rawSample of input) {
      const sample = Math.max(-1, Math.min(1, rawSample));
      let inputTicksRemaining = this.#targetSampleRateHz;
      while (inputTicksRemaining > 0) {
        const overlapTicks = Math.min(
          inputTicksRemaining,
          this.#outputTicksRemaining,
        );
        this.#weightedSampleTotal += sample * overlapTicks;
        this.#weightedSampleTicks += overlapTicks;
        inputTicksRemaining -= overlapTicks;
        this.#outputTicksRemaining -= overlapTicks;

        if (this.#outputTicksRemaining === 0) {
          const next = this.#weightedSampleTotal / this.#weightedSampleTicks;
          output[outputOffset] = floatToPcm16(next);
          outputOffset += 1;
          this.#outputFrames += 1;
          this.#outputTicksRemaining = this.#sourceSampleRateHz;
          this.#weightedSampleTotal = 0;
          this.#weightedSampleTicks = 0;
        }
      }
      this.#inputFrames += 1;
    }
    if (outputOffset !== output.length || this.#outputFrames !== expectedOutputFrames) {
      throw new AudioCaptureError("audio_capture_invalid_pcm");
    }
    return output;
  }

  /** Emits one final partial destination period, if any, and seals the stream. */
  public finish(): Int16Array {
    if (this.#closed) {
      throw new AudioCaptureError("audio_capture_already_closed");
    }
    const expectedOutputFrames = rationalCeil(
      this.#inputFrames,
      this.#targetSampleRateHz,
      this.#sourceSampleRateHz,
    );
    if (expectedOutputFrames > this.#maximumOutputFrames) {
      throw new AudioCaptureError("audio_capture_output_limit_exceeded");
    }
    this.#closed = true;
    if (this.#weightedSampleTicks === 0) return new Int16Array();

    const output = new Int16Array([
      floatToPcm16(this.#weightedSampleTotal / this.#weightedSampleTicks),
    ]);
    this.#outputFrames += 1;
    this.#weightedSampleTotal = 0;
    this.#weightedSampleTicks = 0;
    if (this.#outputFrames !== expectedOutputFrames) {
      throw new AudioCaptureError("audio_capture_invalid_pcm");
    }
    return output;
  }
}

export function floatToPcm16(sample: number): number {
  if (!Number.isFinite(sample)) {
    throw new AudioCaptureError("audio_capture_invalid_pcm");
  }
  const bounded = Math.max(-1, Math.min(1, sample));
  if (bounded < 0) return Math.round(bounded * 32_768);
  return Math.round(bounded * 32_767);
}

export function pcm16ToLittleEndianBytes(samples: Int16Array): Uint8Array {
  const output = new Uint8Array(samples.length * 2);
  const view = new DataView(output.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample === undefined) {
      throw new AudioCaptureError("audio_capture_invalid_pcm");
    }
    view.setInt16(index * 2, sample, true);
  }
  return output;
}

function rationalFloor(value: number, numerator: number, denominator: number): number {
  return Number((BigInt(value) * BigInt(numerator)) / BigInt(denominator));
}

function rationalCeil(value: number, numerator: number, denominator: number): number {
  if (value === 0) return 0;
  const product = BigInt(value) * BigInt(numerator);
  const divisor = BigInt(denominator);
  return Number((product + divisor - 1n) / divisor);
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
