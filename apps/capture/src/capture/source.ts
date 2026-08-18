import type { CaptureCapabilities } from "../bff/contracts";

export interface CapturedWavChunk {
  readonly sequenceNumber: number;
  readonly durationMs: number;
  readonly wavBytes: Uint8Array<ArrayBuffer>;
}

export interface CaptureSourceStartOptions {
  readonly capabilities: CaptureCapabilities;
  readonly onChunk: (chunk: CapturedWavChunk) => Promise<void>;
  readonly signal?: AbortSignal;
}

/**
 * Narrow raw-audio boundary shared by the silent test source and real PWA/native adapters.
 * Implementations must derive runtime media settings and limits from `capabilities`.
 */
export interface CaptureSource {
  readonly kind: "synthetic" | "microphone";
  start(options: CaptureSourceStartOptions): Promise<void>;
  stop(): Promise<void>;
}
