import { downmixToMono } from "./downmix";
import {
  PCM_CAPTURE_WORKLET_PROTOCOL_VERSION,
  type PcmCaptureWorkletMessage,
} from "./worklet-protocol";

export interface EncodedWorkletPacket {
  readonly message: PcmCaptureWorkletMessage;
  readonly transfer: Transferable[];
}

/**
 * Represents every render quantum explicitly. A missing input becomes a
 * terminal discontinuity packet instead of silently joining audio across a
 * temporal hole.
 */
export function encodeWorkletPacket(
  channels: readonly Float32Array[] | undefined,
  sequence: number,
): EncodedWorkletPacket {
  const firstChannel = channels?.[0];
  if (channels === undefined || firstChannel === undefined || firstChannel.length === 0) {
    return {
      message: {
        type: "discontinuity",
        version: PCM_CAPTURE_WORKLET_PROTOCOL_VERSION,
        sequence,
      },
      transfer: [],
    };
  }
  const mono = downmixToMono(channels);
  const frames = mono.buffer;
  return {
    message: {
      type: "pcm",
      version: PCM_CAPTURE_WORKLET_PROTOCOL_VERSION,
      sequence,
      frames,
    },
    transfer: [frames],
  };
}
