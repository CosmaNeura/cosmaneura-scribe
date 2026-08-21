import type { OneTimeCaptureCapability } from "./protocol.js";

export type AdapterInitialState =
  | "permission_required"
  | "meeting_detected"
  | "ready";

/**
 * `network_lost`, `device_changed`, and `failed` are terminal notifications:
 * the controller invokes `abort` and does not release its process-wide lease
 * until shutdown confirms that capture has ended. It never automatically
 * resumes the same upload after one.
 */
export type AdapterSignal =
  | { readonly kind: "permission_required" }
  | { readonly kind: "meeting_detected" }
  | { readonly kind: "ready" }
  | { readonly kind: "network_lost" }
  | { readonly kind: "device_changed" }
  | { readonly kind: "failed" };

export interface DesktopCaptureAdapter {
  /** Prepare local SDK state; this method has no capability and cannot capture. */
  initialize(signal: AbortSignal): Promise<AdapterInitialState>;
  /** Recheck local permissions only; this method cannot begin capture. */
  refreshPermissions(signal: AbortSignal): Promise<AdapterInitialState>;
  /**
   * Consume the capability for this start and do not retain its token. If the
   * signal aborts, capture must not begin later and any partial start must end.
   */
  start(
    capability: OneTimeCaptureCapability,
    signal: AbortSignal,
  ): Promise<void>;
  stop(signal: AbortSignal): Promise<void>;
  /** Idempotently force native capture to end, including partial starts. */
  abort(signal: AbortSignal): Promise<void>;
  /** Idempotent; resolve only after SDK resources can no longer capture. */
  shutdown(signal: AbortSignal): Promise<void>;
  onSignal(listener: (signal: AdapterSignal) => void): () => void;
}
