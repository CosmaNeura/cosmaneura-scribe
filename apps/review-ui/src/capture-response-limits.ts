// Core's closed review payload plus its provenance envelope; no text truncation.
export const MAX_CREATOR_REVIEW_BYTES = 32 * 1024 * 1024;
export const MAX_CORE_CAPTURE_RESPONSE_BYTES = MAX_CREATOR_REVIEW_BYTES + 8192;
export const MAX_PROVIDER_RESPONSE_BYTES = MAX_CORE_CAPTURE_RESPONSE_BYTES + 8192;
// The native helper nests JSON text in a JSON string (at most twofold escaping).
export const MAX_PROVIDER_FRAME_BYTES = 2 * MAX_PROVIDER_RESPONSE_BYTES + 8192;
export function coreCaptureResponseLimit(action: string): number {
  if (action === "mount") return MAX_PROVIDER_RESPONSE_BYTES;
  return action === "capture-operations" ? MAX_CORE_CAPTURE_RESPONSE_BYTES : 8 * 1024 * 1024;
}
