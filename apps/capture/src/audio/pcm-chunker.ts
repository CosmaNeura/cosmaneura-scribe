import { AudioCaptureError } from "./errors";

export interface Pcm16ChunkerConfiguration {
  readonly targetFramesPerChunk: number;
  readonly maximumChunks: number;
  readonly hardMaximumChunks?: number;
}

/** Maintains exact capability-derived chunk boundaries across worklet packets. */
export class Pcm16Chunker {
  readonly #targetFramesPerChunk: number;
  #maximumChunks: number;
  readonly #hardMaximumChunks: number;
  #buffer: Int16Array<ArrayBuffer>;
  #bufferedFrames = 0;
  #emittedChunks = 0;
  #closed = false;

  public constructor(configuration: Pcm16ChunkerConfiguration) {
    if (
      !Number.isSafeInteger(configuration.targetFramesPerChunk) ||
      configuration.targetFramesPerChunk < 1 ||
      !Number.isSafeInteger(configuration.maximumChunks) ||
      configuration.maximumChunks < 1 ||
      !Number.isSafeInteger(configuration.hardMaximumChunks ?? configuration.maximumChunks) ||
      (configuration.hardMaximumChunks ?? configuration.maximumChunks) < configuration.maximumChunks
    ) {
      throw new AudioCaptureError("audio_capture_invalid_configuration");
    }
    this.#targetFramesPerChunk = configuration.targetFramesPerChunk;
    this.#maximumChunks = configuration.maximumChunks;
    this.#hardMaximumChunks = configuration.hardMaximumChunks ?? configuration.maximumChunks;
    this.#buffer = allocatePcm16(configuration.targetFramesPerChunk);
  }

  public extend(maximumChunks: number): void {
    if (this.#closed || !Number.isSafeInteger(maximumChunks) || maximumChunks < this.#maximumChunks
      || maximumChunks > this.#hardMaximumChunks) throw new AudioCaptureError("audio_capture_invalid_configuration");
    this.#maximumChunks = maximumChunks;
  }

  public push(samples: Int16Array): readonly Int16Array<ArrayBuffer>[] {
    if (this.#closed) {
      throw new AudioCaptureError("audio_capture_already_closed");
    }
    const output: Int16Array<ArrayBuffer>[] = [];
    let inputOffset = 0;
    while (inputOffset < samples.length) {
      const copyFrames = Math.min(
        samples.length - inputOffset,
        this.#targetFramesPerChunk - this.#bufferedFrames,
      );
      this.#buffer.set(
        samples.subarray(inputOffset, inputOffset + copyFrames),
        this.#bufferedFrames,
      );
      this.#bufferedFrames += copyFrames;
      inputOffset += copyFrames;
      if (this.#bufferedFrames === this.#targetFramesPerChunk) {
        this.#assertChunkAvailable();
        output.push(this.#buffer);
        this.#emittedChunks += 1;
        this.#buffer = allocatePcm16(this.#targetFramesPerChunk);
        this.#bufferedFrames = 0;
      }
    }
    return output;
  }

  /** Returns the final short chunk without padding or inventing continuity. */
  public finish(): Int16Array<ArrayBuffer> | null {
    if (this.#closed) {
      throw new AudioCaptureError("audio_capture_already_closed");
    }
    this.#closed = true;
    if (this.#bufferedFrames === 0) return null;
    this.#assertChunkAvailable();
    const output = allocatePcm16(this.#bufferedFrames);
    output.set(this.#buffer.subarray(0, this.#bufferedFrames));
    this.#emittedChunks += 1;
    this.#buffer.fill(0);
    this.#bufferedFrames = 0;
    return output;
  }

  /** Zeros an incomplete plaintext chunk when continuity is no longer trustworthy. */
  public discard(): void {
    this.#closed = true;
    this.#buffer.fill(0);
    this.#bufferedFrames = 0;
  }

  #assertChunkAvailable(): void {
    if (this.#emittedChunks >= this.#maximumChunks) {
      throw new AudioCaptureError("audio_capture_output_limit_exceeded");
    }
  }
}

function allocatePcm16(frames: number): Int16Array<ArrayBuffer> {
  return new Int16Array(new ArrayBuffer(frames * Int16Array.BYTES_PER_ELEMENT));
}
