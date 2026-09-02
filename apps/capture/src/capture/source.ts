import type { CaptureCapabilities } from "../bff/contracts";

export interface CapturedWavChunk {
  readonly sequenceNumber: number;
  readonly durationMs: number;
  readonly wavBytes: Uint8Array<ArrayBuffer>;
}

export interface CaptureSourceStartOptions {
  readonly capabilities: CaptureCapabilities;
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
  start(options: CaptureSourceStartOptions): Promise<void>;
  stop(): Promise<void>;
}
