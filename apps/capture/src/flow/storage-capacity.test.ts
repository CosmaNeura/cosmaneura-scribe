import { describe, expect, it } from "vitest";
import { CAPTURE_STORAGE_RESERVE_BYTES, captureStorageFailure, parseAvailableStorageBytes,
  requiredCaptureStorageBytes } from "./storage-capacity";

describe("recording storage headroom", () => {
  it("allows three hours plus encoding, encryption, journal copies and final-stop reserve", async () => {
    const wavBytes = 1080 * (16000 * 2 * 10 + 44);
    const required = requiredCaptureStorageBytes(384 * 1024 * 1024);
    const doubleEncodedCopies = Math.ceil(Math.ceil(wavBytes / 3) * 4 / 3) * 4 * 2;
    expect(required).toBeGreaterThan(doubleEncodedCopies + CAPTURE_STORAGE_RESERVE_BYTES);
    expect(await captureStorageFailure({ availableBytes: async () => required }, required)).toBeNull();
    expect(await captureStorageFailure({ availableBytes: async () => required - 1 }, required)).toBe("capture_storage_low");
    expect(requiredCaptureStorageBytes(0)).toBe(CAPTURE_STORAGE_RESERVE_BYTES);
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("refuses invalid host capacity %s", async value => {
    expect(await captureStorageFailure({ availableBytes: async () => value }, 1)).toBe("capture_storage_unavailable");
  });

  it("accepts canonical native integers without rounding and rejects malformed values", () => {
    expect(parseAvailableStorageBytes("0")).toBe(0);
    expect(parseAvailableStorageBytes("17179869184")).toBe(17179869184);
    for (const value of ["-1", "01", "1.2", " 1", "1e3", "9007199254740992", 3]) {
      expect(() => parseAvailableStorageBytes(value as string)).toThrow("capture_storage_unavailable");
    }
    for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => requiredCaptureStorageBytes(value)).toThrow("capture_storage_unavailable");
    }
  });
});
