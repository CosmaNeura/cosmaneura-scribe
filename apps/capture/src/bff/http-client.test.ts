import { describe, expect, it, vi } from "vitest";

import type { BffResponseError } from "./http-client";
import { HttpCaptureBff, parseRetryAfter } from "./http-client";

describe("HttpCaptureBff", () => {
  it("keeps authenticated control traffic on the same-origin BFF", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ protocol_version: "1.0" }),
    );
    const client = new HttpCaptureBff(fetchImplementation, "/api/capture");

    await client.issueLease(
      "11111111-1111-4111-8111-111111111111",
      { protocol_version: "1.0" },
      { idempotencyKey: "lease-request-0001" },
    );

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(fetchImplementation.mock.contexts[0]).toBe(globalThis);
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe(
      "/api/capture/sessions/11111111-1111-4111-8111-111111111111/capture-lease",
    );
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
      redirect: "error",
      cache: "no-store",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("Idempotency-Key")).toBe("lease-request-0001");
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("X-Tenant-ID")).toBeNull();
  });

  it("rejects non-canonical or cross-origin BFF targets", () => {
    expect(() => new HttpCaptureBff(fetch, "https://scribe.invalid")).toThrow(
      "same-origin",
    );
    expect(() => new HttpCaptureBff(fetch, "//scribe.invalid")).toThrow("same-origin");
    expect(() => new HttpCaptureBff(fetch, "/\\scribe.invalid")).toThrow("same-origin");
    expect(() => new HttpCaptureBff(fetch, "/api/../capture")).toThrow("same-origin");
  });

  it("rejects unsafe idempotency keys before a network request", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = new HttpCaptureBff(fetchImplementation);

    expect(() =>
      client.issueLease(
        "11111111-1111-4111-8111-111111111111",
        { protocol_version: "1.0" },
        { idempotencyKey: "short" },
      ),
    ).toThrow("invalid idempotency key");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("bounds successful JSON responses even without a Content-Length header", async () => {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_537));
        controller.close();
      },
    });
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(oversized, { headers: { "Content-Type": "application/json" } }),
    );
    const client = new HttpCaptureBff(fetchImplementation);

    await expect(
      client.getCapabilities("11111111-1111-4111-8111-111111111111"),
    ).rejects.toEqual(
      expect.objectContaining<Partial<BffResponseError>>({
        status: 200,
        code: null,
      }),
    );
  });

  it("never parses an oversized error body into a persisted error code", async () => {
    const body = JSON.stringify({
      detail: { code: "unsafe_server_code", padding: "x".repeat(8_192) },
    });
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new HttpCaptureBff(fetchImplementation);

    await expect(
      client.getCapabilities("11111111-1111-4111-8111-111111111111"),
    ).rejects.toEqual(
      expect.objectContaining<Partial<BffResponseError>>({
        status: 503,
        code: null,
      }),
    );
  });

  it("normalizes both Retry-After wire formats into a bounded delay", () => {
    const now = Date.parse("2026-08-18T12:00:00Z");
    expect(parseRetryAfter("17", now)).toBe(17_000);
    expect(parseRetryAfter("Tue, 18 Aug 2026 12:00:23 GMT", now)).toBe(23_000);
    expect(parseRetryAfter("999999", now)).toBe(300_000);
    expect(parseRetryAfter("not-a-delay", now)).toBeNull();
  });
});
