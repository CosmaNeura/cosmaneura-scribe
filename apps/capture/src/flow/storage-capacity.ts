/** Measured by the trusted host on the volume containing the encrypted queue. */
export interface CaptureStorageCapacity {
  availableBytes(): Promise<number>;
}

// Keep room for the final chunk, journal updates and an orderly native stop.
export const CAPTURE_STORAGE_RESERVE_BYTES = 64 * 1024 * 1024;

export function requiredCaptureStorageBytes(remainingPlaintextBytes: number): number {
  if (!Number.isSafeInteger(remainingPlaintextBytes) || remainingPlaintextBytes < 0
    || remainingPlaintextBytes > (Number.MAX_SAFE_INTEGER - CAPTURE_STORAGE_RESERVE_BYTES) / 4) {
    throw new Error("capture_storage_unavailable");
  }
  // Covers existing Base64 records, encrypted envelopes, and atomic/WAL copies.
  return remainingPlaintextBytes * 4 + CAPTURE_STORAGE_RESERVE_BYTES;
}

export function parseAvailableStorageBytes(value: string): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("capture_storage_unavailable");
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("capture_storage_unavailable");
  return bytes;
}

export async function captureStorageFailure(capacity: CaptureStorageCapacity, required: number): Promise<
  "capture_storage_low" | "capture_storage_unavailable" | null
> {
  try {
    const available = await capacity.availableBytes();
    if (!Number.isSafeInteger(available) || available < 0) return "capture_storage_unavailable";
    return available < required ? "capture_storage_low" : null;
  } catch { return "capture_storage_unavailable"; }
}
