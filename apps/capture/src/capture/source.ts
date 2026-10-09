import type { CaptureCapabilities, ChunkReservationBatchRequest } from "../bff/contracts";

export type CaptureAudioChannel = ChunkReservationBatchRequest["channel"];

export interface CapturedWavChunk {
  readonly sequenceNumber: number;
  readonly durationMs: number;
  readonly wavBytes: Uint8Array<ArrayBuffer>;
}

/** Trusted flow metadata for one live native source. Core lease/reservation
 * receipts must be durable before the owning flow supplies a new window. */
export interface CaptureSourceWindow {
  readonly runId: string;
  readonly generation: number;
  readonly expiresAtMilliseconds: number;
  readonly maximumChunks: number;
  readonly hardMaximumChunks: number;
}

export interface CaptureSourceStartOptions {
  readonly capabilities: CaptureCapabilities;
  readonly window?: CaptureSourceWindow;
  readonly onChunk: (chunk: CapturedWavChunk) => Promise<void>;
  readonly onInterruption?: (code: CaptureSourceInterruptionCode) => void;
  readonly onError?: (code: CaptureSourceErrorCode) => void;
  readonly signal?: AbortSignal;
}

export type CaptureSourceInterruptionCode =
  | "audio_context_suspended"
  | "audio_device_disconnected"
  | "audio_route_changed"
  | "audio_session_interrupted"
  | "capture_backgrounded";

export type CaptureSourceErrorCode =
  | "capture_source_stalled"
  | "capture_source_failed";

/**
 * Narrow raw-audio boundary shared by the silent test source and real PWA/native adapters.
 * Implementations must derive runtime media settings and limits from `capabilities`.
 */
export interface CaptureSource {
  readonly kind: "synthetic" | "microphone";
  /** Fixed by the authorized source; omission preserves existing microphone capture. */
  readonly channel?: CaptureAudioChannel;
  readonly supportsRenewal?: true;
  extend?(window: CaptureSourceWindow): Promise<void>;
  start(options: CaptureSourceStartOptions): Promise<void>;
  stop(): Promise<void>;
}
