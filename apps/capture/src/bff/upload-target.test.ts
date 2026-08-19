import { describe, expect, it, vi } from "vitest";

import type { UploadResponseError } from "./upload-target";
import {
  HttpCiphertextUploadTarget,
  UploadTargetPolicyError,
} from "./upload-target";

describe("HttpCiphertextUploadTarget", () => {
  it("puts identical envelope bytes only to an allowlisted origin", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 201 }),
    );
    const target = new HttpCiphertextUploadTarget(
      ["https://upload.example.test"],
      fetchImplementation,
    );
    const envelope = new Uint8Array([1, 2, 3, 4]);

    await target.putCompleteEnvelope(
      "https://upload.example.test/chunks/object?sig=synthetic",
      envelope,
    );

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(fetchImplementation.mock.contexts[0]).toBe(globalThis);
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://upload.example.test/chunks/object?sig=synthetic");
    expect(init).toMatchObject({
      method: "PUT",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(envelope);
    expect(new Headers(init?.headers).get("Authorization")).toBeNull();
  });

  it("rejects an untrusted target before sending ciphertext", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const target = new HttpCiphertextUploadTarget(
      ["https://upload.example.test"],
      fetchImplementation,
    );

    await expect(
      target.putCompleteEnvelope("https://evil.example/chunks/object", new Uint8Array([1])),
    ).rejects.toBeInstanceOf(UploadTargetPolicyError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("moves a same-origin preview receipt from the URL fragment into a request header", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 201 }),
    );
    const target = new HttpCiphertextUploadTarget(
      ["https://preview.example.test"],
      fetchImplementation,
    );
    const receipt = "11111111-1111-4111-8111-111111111111";

    await target.putCompleteEnvelope(
      `https://preview.example.test/api/capture/preview/uploads/scope/object#receipt=${receipt}`,
      new Uint8Array([1]),
    );

    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://preview.example.test/api/capture/preview/uploads/scope/object",
    );
    expect(new Headers(init?.headers).get("X-Capture-Upload-Receipt")).toBe(receipt);
    expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
  });

  it("rejects insecure non-loopback allowlist origins", () => {
    expect(
      () => new HttpCiphertextUploadTarget(["http://upload.example.test"]),
    ).toThrow("must use HTTPS");
  });

  it("preserves a normalized Retry-After delay without reading an error body", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("not inspected", {
        status: 429,
        headers: { "Retry-After": "19" },
      }),
    );
    const target = new HttpCiphertextUploadTarget(
      ["https://upload.example.test"],
      fetchImplementation,
    );

    await expect(
      target.putCompleteEnvelope(
        "https://upload.example.test/chunks/object?sig=synthetic",
        new Uint8Array([1]),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<UploadResponseError>>({
        status: 429,
        retryAfterMs: 19_000,
      }),
    );
  });

  it.each([202, 206])(
    "rejects status %i as incomplete upload acceptance",
    async (status) => {
      const target = new HttpCiphertextUploadTarget(
        ["https://upload.example.test"],
        vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })),
      );

      await expect(
        target.putCompleteEnvelope(
          "https://upload.example.test/chunks/object?sig=synthetic",
          new Uint8Array([1]),
        ),
      ).rejects.toEqual(
        expect.objectContaining<Partial<UploadResponseError>>({ status }),
      );
    },
  );
});
