import { AudioCaptureError } from "./errors";

export const PCM_CAPTURE_WORKLET_NAME = "cosmaneura-pcm-capture-v1";
export const PCM_CAPTURE_WORKLET_PROTOCOL_VERSION = 1 as const;

export interface PcmCaptureWorkletPcmMessage {
  readonly type: "pcm";
  readonly version: typeof PCM_CAPTURE_WORKLET_PROTOCOL_VERSION;
  readonly sequence: number;
  readonly frames: ArrayBuffer;
}

export interface PcmCaptureWorkletDiscontinuityMessage {
  readonly type: "discontinuity";
  readonly version: typeof PCM_CAPTURE_WORKLET_PROTOCOL_VERSION;
  readonly sequence: number;
}

export type PcmCaptureWorkletMessage =
  | PcmCaptureWorkletPcmMessage
  | PcmCaptureWorkletDiscontinuityMessage;

/**
 * Stateful validation makes dropped, duplicated, oversized, or malformed
 * AudioWorklet packets terminal instead of silently inventing continuity.
 */
export class PcmCaptureWorkletDecoder {
  readonly #maximumFramesPerMessage: number;
  #nextSequence = 0;

  public constructor(maximumFramesPerMessage: number) {
    if (!Number.isSafeInteger(maximumFramesPerMessage) || maximumFramesPerMessage < 1) {
      throw new AudioCaptureError("audio_capture_invalid_configuration");
    }
    this.#maximumFramesPerMessage = maximumFramesPerMessage;
  }

  public decode(value: unknown): Float32Array {
    if (!isPcmCaptureWorkletMessage(value)) {
      throw new AudioCaptureError("audio_capture_worklet_protocol_error");
    }
    const frames = new Float32Array(value.frames);
    if (
      value.sequence !== this.#nextSequence ||
      frames.length < 1 ||
      frames.length > this.#maximumFramesPerMessage
    ) {
      throw new AudioCaptureError("audio_capture_worklet_protocol_error");
    }
    for (const frame of frames) {
      if (!Number.isFinite(frame)) {
        throw new AudioCaptureError("audio_capture_worklet_protocol_error");
      }
    }
    this.#nextSequence += 1;
    return frames;
  }
}

function isPcmCaptureWorkletMessage(value: unknown): value is PcmCaptureWorkletPcmMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PcmCaptureWorkletPcmMessage>;
  return (
    candidate.type === "pcm" &&
    candidate.version === PCM_CAPTURE_WORKLET_PROTOCOL_VERSION &&
    Number.isSafeInteger(candidate.sequence) &&
    (candidate.sequence ?? -1) >= 0 &&
    candidate.frames instanceof ArrayBuffer &&
    candidate.frames.byteLength % Float32Array.BYTES_PER_ELEMENT === 0
  );
}
