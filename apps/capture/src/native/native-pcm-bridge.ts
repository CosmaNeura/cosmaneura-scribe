import type { CaptureSourceWindow } from "../capture/source";
/** Native/main-process contract; not a renderer or credential API. */
export const NATIVE_PCM_FORMAT = { encoding: "pcm_s16le", channels: 1, sampleRateHz: 16_000 } as const;
export type NativePcmStopMode = "drain" | "discard";
export type NativePcmInterruptionCode = "audio_session_interrupted" | "audio_route_changed"
  | "audio_device_disconnected" | "capture_backgrounded";
export type NativePcmTerminalErrorCode = "permission_revoked" | "stalled" | "failed" | "protocol_error";

export interface NativePcmConfiguration {
  readonly encoding: typeof NATIVE_PCM_FORMAT.encoding;
  readonly channels: typeof NATIVE_PCM_FORMAT.channels;
  readonly sampleRateHz: typeof NATIVE_PCM_FORMAT.sampleRateHz;
  readonly targetFramesPerChunk: number;
  readonly maximumChunks: number;
  readonly window?: CaptureSourceWindow;
}
export interface NativePcmPacket {
  readonly sequenceNumber: number;
  /** Complete owned ArrayBuffer, cleared by the receiver before acknowledgement. */
  readonly pcmBytes: Uint8Array<ArrayBuffer>;
}
export interface NativePcmSink {
  /** At most one in flight; the producer must await persistence acknowledgement. */
  readonly onPcmPacket: (packet: NativePcmPacket) => Promise<void>;
  readonly onInterruption: (code: NativePcmInterruptionCode) => void;
  readonly onError: (code: NativePcmTerminalErrorCode) => void;
}
export interface NativePcmStopResult {
  /** Drain may return one final short packet; discard must return null. */
  readonly finalPcmPacket: NativePcmPacket | null;
}
export interface NativePcmSession {
  readonly ready: Promise<void>;
  /** Optional native delivery acknowledgement, called only after the source is active. */
  activate?(): void;
  extend?(window: CaptureSourceWindow): Promise<void>;
  /** Stop works during startup. Rejection retains the same native handle for retry.
   * Discard upgrades an in-flight drain; successful stop confirms no later callbacks.
   */
  stop(options: { readonly mode: NativePcmStopMode }): Promise<NativePcmStopResult>;
}
export interface NativePcmBridge {
  /** Platform policy stays here: iOS foreground; desktop unlocked session/permission. */
  getAvailability(): Promise<boolean>;
  /** Only desktop delivery opts in to draining accepted full packets during stop. */
  readonly deliversDuringDrain?: true;
  readonly supportsRenewal?: true;
  /** Return ownership synchronously, before permission/startup can await. No packet
   * may arrive before ready, or before activate when that handshake is provided.
   */
  start(configuration: NativePcmConfiguration, sink: NativePcmSink): NativePcmSession;
}
