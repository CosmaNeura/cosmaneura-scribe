import type { CaptureSource, CaptureSourceStartOptions } from "./source";
import { encodePcm16MonoWav, pcm16WavProfile, targetFrameCount } from "./wav";

export class SilentSyntheticCaptureSource implements CaptureSource {
  public readonly kind = "synthetic" as const;

  #active = false;
  #abortHandler: (() => void) | undefined;
  #abortSignal: AbortSignal | undefined;
  #pending: Promise<void> = Promise.resolve();
  #sequenceNumber = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  public start(options: CaptureSourceStartOptions): Promise<void> {
    if (this.#active) {
      return Promise.reject(new Error("capture source is already active"));
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new DOMException("capture start was cancelled", "AbortError"));
    }

    let profile: ReturnType<typeof pcm16WavProfile>;
    let frameCount: number;
    try {
      profile = pcm16WavProfile(options.capabilities);
      frameCount = targetFrameCount(profile);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error("capture capabilities are invalid"),
      );
    }
    this.#active = true;
    this.#sequenceNumber = 0;

    const schedule = (): void => {
      this.#timer = setTimeout(() => {
        if (!this.#active || options.signal?.aborted === true) {
          void this.stop();
          return;
        }
        const sequenceNumber = this.#sequenceNumber;
        this.#sequenceNumber += 1;
        const samples = new Int16Array(new ArrayBuffer(frameCount * Int16Array.BYTES_PER_ELEMENT));
        const wavBytes = encodePcm16MonoWav(samples, profile);
        this.#pending = this.#pending
          .then(() => options.onChunk({
            sequenceNumber,
            durationMs: profile.targetChunkDurationMs,
            wavBytes,
          }))
          .then(() => {
            if (this.#sequenceNumber >= options.capabilities.max_chunks) {
              this.#active = false;
            } else if (this.#active) {
              schedule();
            }
          }, (error: unknown) => {
            this.#active = false;
            throw error;
          });
      }, profile.targetChunkDurationMs);
    };

    if (options.signal !== undefined) {
      this.#abortSignal = options.signal;
      this.#abortHandler = () => void this.stop();
      options.signal.addEventListener("abort", this.#abortHandler, { once: true });
    }
    schedule();
    return Promise.resolve();
  }

  public async stop(): Promise<void> {
    this.#active = false;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#abortSignal !== undefined && this.#abortHandler !== undefined) {
      this.#abortSignal.removeEventListener("abort", this.#abortHandler);
    }
    this.#abortSignal = undefined;
    this.#abortHandler = undefined;
    await this.#pending;
  }
}
