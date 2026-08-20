import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapCapturePreview } from "./bootstrap";

describe("bootstrapCapturePreview", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is inactive unless the persistent hosted profile is explicitly enabled", async () => {
    vi.stubEnv("VITE_CAPTURE_PREVIEW_PERSISTENT_ENABLED", "false");
    const fetchImplementation = vi.fn<typeof fetch>();

    await expect(bootstrapCapturePreview(fetchImplementation)).resolves.toBeNull();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("establishes the strict synthetic-only cookie scope before control calls", async () => {
    vi.stubEnv("VITE_CAPTURE_PREVIEW_PERSISTENT_ENABLED", "true");
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        mode: "synthetic",
        microphone_enabled: false,
        max_chunks: 6,
      }),
    );

    await expect(bootstrapCapturePreview(fetchImplementation)).resolves.toEqual({
      mode: "synthetic",
      microphoneEnabled: false,
      maxChunks: 6,
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/api/capture/preview/bootstrap",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        redirect: "error",
        cache: "no-store",
      }),
    );
  });

  it("fails closed if the server claims microphone capture or changes a bound limit", async () => {
    vi.stubEnv("VITE_CAPTURE_PREVIEW_PERSISTENT_ENABLED", "true");
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ mode: "synthetic", microphone_enabled: true, max_chunks: 90 }),
    );

    await expect(bootstrapCapturePreview(fetchImplementation)).rejects.toThrow(
      "policy mismatch",
    );
  });
});
