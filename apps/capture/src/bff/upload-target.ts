import type { CiphertextUploadTarget, RequestOptions } from "./contracts";

import { parseRetryAfter } from "./http-client";

export class UploadResponseError extends Error {
  public constructor(
    public readonly status: number,
    public readonly retryAfterMs: number | null,
  ) {
    super("ciphertext upload failed");
    this.name = "UploadResponseError";
  }
}

export class UploadTargetPolicyError extends Error {
  public constructor() {
    super("ciphertext upload target rejected by policy");
    this.name = "UploadTargetPolicyError";
  }
}

export class HttpCiphertextUploadTarget implements CiphertextUploadTarget {
  private readonly allowedOrigins: ReadonlySet<string>;

  public constructor(
    allowedOrigins: readonly string[],
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    if (allowedOrigins.length === 0) {
      throw new Error("at least one ciphertext upload origin is required");
    }
    this.allowedOrigins = new Set(allowedOrigins.map(normalizeAllowedOrigin));
  }

  public async putCompleteEnvelope(
    uploadUrl: string,
    envelope: Uint8Array,
    options: RequestOptions = {},
  ): Promise<void> {
    let target: URL;
    try {
      target = new URL(uploadUrl, globalThis.location?.origin);
    } catch {
      throw new UploadTargetPolicyError();
    }
    const receipt = parsePreviewReceipt(target.hash);
    if (
      !this.allowedOrigins.has(target.origin) ||
      target.protocol !== "https:" && !isLoopback(target.hostname) ||
      target.username !== "" ||
      target.password !== "" ||
      (target.hash !== "" && receipt === null)
    ) {
      throw new UploadTargetPolicyError();
    }

    const body = new ArrayBuffer(envelope.byteLength);
    new Uint8Array(body).set(envelope);
    target.hash = "";
    const response = await this.fetchImplementation.call(globalThis, target, {
      method: "PUT",
      body,
      headers: {
        "Content-Type": "application/octet-stream",
        ...(receipt === null ? {} : { "X-Capture-Upload-Receipt": receipt }),
      },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    // The complete-envelope edge contract is a synchronous create/replace PUT.
    // Any other 2xx (including 202 or 206) is not proof of durable acceptance.
    if (response.status !== 201) {
      throw new UploadResponseError(
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
  }
}

function parsePreviewReceipt(hash: string): string | null {
  const match = /^#receipt=([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u.exec(hash);
  return match?.[1] ?? null;
}

function normalizeAllowedOrigin(value: string): string {
  const origin = new URL(value);
  if (
    origin.origin !== value.replace(/\/$/u, "") ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error("ciphertext upload allowlist entry must be an origin");
  }
  if (origin.protocol !== "https:" && !isLoopback(origin.hostname)) {
    throw new Error("ciphertext upload origin must use HTTPS");
  }
  return origin.origin;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
