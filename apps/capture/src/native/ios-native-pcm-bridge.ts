export const IOS_NATIVE_PCM_FORMAT = {
  encoding: "pcm_s16le",
  channels: 1,
  sampleRateHz: 16_000,
} as const;

export type IosNativeAppState = "foreground" | "background";

export type IosNativeMicrophoneStartErrorCode =
  | "ios_microphone_permission_denied"
  | "ios_microphone_permission_restricted"
  | "ios_microphone_unavailable"
  | "ios_capture_not_foreground"
  | "ios_capture_start_failed";

export type IosNativeMicrophoneInterruptionCode =
  | "ios_audio_session_interrupted"
  | "ios_audio_route_changed"
  | "ios_capture_backgrounded";

export type IosNativeMicrophoneTerminalErrorCode =
  | "ios_microphone_permission_revoked"
  | "ios_capture_stalled"
  | "ios_capture_failed";

/** Fixed-code native start failures must not include device or audio details. */
export class IosNativeMicrophoneBridgeError extends Error {
  public constructor(public readonly code: IosNativeMicrophoneStartErrorCode) {
    super(code);
    this.name = "IosNativeMicrophoneBridgeError";
  }
}

export interface IosNativePcmConfiguration {
  readonly encoding: typeof IOS_NATIVE_PCM_FORMAT.encoding;
  readonly channels: typeof IOS_NATIVE_PCM_FORMAT.channels;
  readonly sampleRateHz: typeof IOS_NATIVE_PCM_FORMAT.sampleRateHz;
  readonly targetFramesPerChunk: number;
  readonly maximumChunks: number;
}

export interface IosNativePcmPacket {
  /** Starts at zero and advances by exactly one for each packet. */
  readonly sequenceNumber: number;
  /**
   * Ownership transfers to the sink. The bridge must not retain or reuse this
   * little-endian PCM16 buffer; the receiver zeroes it before acknowledging it.
   */
  readonly pcmBytes: Uint8Array<ArrayBuffer>;
}

export interface IosNativePcmSink {
  /** The bridge must await this promise before it produces another packet. */
  readonly onPcmPacket: (packet: IosNativePcmPacket) => Promise<void>;
  readonly onInterruption: (code: IosNativeMicrophoneInterruptionCode) => void;
  readonly onError: (code: IosNativeMicrophoneTerminalErrorCode) => void;
}

/**
 * Dormant TypeScript boundary for a future foreground-only iOS implementation.
 *
 * `stop` must be idempotent (including during `start`), stop native production
 * before it resolves, release the audio session, and zero native buffers. No
 * implementation may log audio, encoded content, device labels, or native
 * exception messages.
 */
export interface IosNativeMicrophoneBridge {
  getAppState(): Promise<IosNativeAppState>;
  /**
   * Resolve only after the foreground audio session is ready. Do not emit a
   * packet before resolution, and never emit while the app is backgrounded.
   */
  start(configuration: IosNativePcmConfiguration, sink: IosNativePcmSink): Promise<void>;
  stop(): Promise<void>;
}
