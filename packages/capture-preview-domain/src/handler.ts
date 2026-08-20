import { createHash, randomBytes } from "node:crypto";

import { MAX_ENVELOPE_BYTES } from "@cosmaneura-scribe/capture-protocol";

import {
  HOSTED_MAX_CHUNKS,
  PREVIEW_COOKIE_NAME,
  PREVIEW_TTL_SECONDS,
} from "./constants";
import {
  PreviewDomainError,
  PreviewValidationError,
} from "./domain";
import type { PreviewCaptureDomain } from "./domain";
import type { JsonValue } from "./repository";

const CONTROL_PREFIX = "/api/capture";
const UPLOAD_PREFIX = "/api/capture/preview/uploads/";
const MAX_JSON_BYTES = 65_536;
const COOKIE_VALUE = /^[A-Za-z0-9_-]{43}$/u;
const SCOPE_ID = /^[0-9a-f]{64}$/u;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u;

export interface PreviewRequestHandlerOptions {
  readonly allowedHosts?: readonly string[];
  readonly allowedHostSuffixes?: readonly string[];
  readonly cookieFactory?: () => string;
}

export function createPreviewRequestHandler(
  domain: PreviewCaptureDomain,
  options: PreviewRequestHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const allowedHosts = new Set(options.allowedHosts ?? []);
  const allowedHostSuffixes = options.allowedHostSuffixes ?? [".azurestaticapps.net"];
  const cookieFactory = options.cookieFactory ?? (() => randomBytes(32).toString("base64url"));

  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const host = effectiveHost(request, url, allowedHosts, allowedHostSuffixes);
      if (url.search !== "") throw new PreviewDomainError(404, "route_not_found");
      if (request.method === "GET" && url.pathname === `${CONTROL_PREFIX}/preview/health`) {
        await domain.health();
        return jsonResponse(200, { status: "ok", mode: "synthetic" });
      }
      if (request.method === "POST" && url.pathname === `${CONTROL_PREFIX}/preview/bootstrap`) {
        await requireEmptyBody(request);
        const existing = readCookie(request.headers.get("cookie"), PREVIEW_COOKIE_NAME);
        const cookieValue = existing !== null && COOKIE_VALUE.test(existing)
          ? existing
          : cookieFactory();
        if (!COOKIE_VALUE.test(cookieValue)) throw new Error("invalid preview cookie factory");
        const scopeId = deriveScopeId(host, cookieValue);
        await domain.bootstrap(scopeId);
        return jsonResponse(
          200,
          {
            mode: "synthetic",
            microphone_enabled: false,
            max_chunks: HOSTED_MAX_CHUNKS,
          },
          {
            "Set-Cookie": `${PREVIEW_COOKIE_NAME}=${cookieValue}; Path=/; Max-Age=${String(PREVIEW_TTL_SECONDS)}; Secure; HttpOnly; SameSite=Strict`,
          },
        );
      }

      if (request.method === "PUT" && url.pathname.startsWith(UPLOAD_PREFIX)) {
        const match = /^\/api\/capture\/preview\/uploads\/([0-9a-f]{64})\/([^/]+)$/u.exec(
          url.pathname,
        );
        if (match === null) throw new PreviewDomainError(404, "route_not_found");
        const scopeId = match[1] ?? "";
        const objectId = decodeURIComponent(match[2] ?? "");
        const receiptId = request.headers.get("x-capture-upload-receipt");
        if (!SCOPE_ID.test(scopeId) || receiptId === null) {
          throw new PreviewDomainError(403, "upload_authorization_invalid");
        }
        requireContentType(request, "application/octet-stream");
        const bytes = await readBoundedBytes(request, MAX_ENVELOPE_BYTES);
        await domain.putEnvelope(scopeId, objectId, receiptId, bytes);
        return emptyResponse(201);
      }

      const cookie = requireCookie(request.headers.get("cookie"));
      const scopeId = deriveScopeId(host, cookie);
      if (request.method === "GET" && url.pathname === `${CONTROL_PREFIX}/audio-encryption-key`) {
        return jsonResponse(200, await domain.audioEncryptionKey(scopeId));
      }
      if (request.method === "POST" && url.pathname === `${CONTROL_PREFIX}/consents`) {
        return jsonResponse(
          201,
          await domain.createConsent(scopeId, await readJson(request), requireIdempotency(request)),
        );
      }
      if (request.method === "POST" && url.pathname === `${CONTROL_PREFIX}/sessions`) {
        return jsonResponse(
          201,
          await domain.createSession(scopeId, await readJson(request), requireIdempotency(request)),
        );
      }

      const sessionMatch = /^\/api\/capture\/sessions\/([^/]+)(\/.*)$/u.exec(url.pathname);
      if (sessionMatch === null) throw new PreviewDomainError(404, "route_not_found");
      const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
      const path = sessionMatch[2] ?? "";

      if (request.method === "POST" && path === "/audio-key") {
        return jsonResponse(
          201,
          await domain.bindAudioKey(
            scopeId,
            sessionId,
            await readJson(request),
            requireIdempotency(request),
          ),
        );
      }
      if (request.method === "GET" && path === "/capture-capabilities") {
        return jsonResponse(200, await domain.capabilities(scopeId, sessionId));
      }
      if (request.method === "POST" && path === "/capture-lease") {
        return jsonResponse(
          201,
          await domain.issueLease(
            scopeId,
            sessionId,
            await readJson(request),
            requireIdempotency(request),
          ),
        );
      }
      const renewal = /^\/capture-leases\/([^/]+)\/renew$/u.exec(path);
      if (request.method === "POST" && renewal !== null) {
        return jsonResponse(
          200,
          await domain.renewLease(
            scopeId,
            sessionId,
            decodeURIComponent(renewal[1] ?? ""),
            await readJson(request),
            requireIdempotency(request),
          ),
        );
      }
      if (request.method === "POST" && path === "/chunk-reservations") {
        return jsonResponse(
          201,
          await domain.reserveChunks(
            scopeId,
            sessionId,
            await readJson(request),
            requireIdempotency(request),
          ),
        );
      }
      const authorization = /^\/chunks\/([^/]+)\/upload-authorization$/u.exec(path);
      if (request.method === "POST" && authorization !== null) {
        return jsonResponse(
          201,
          await domain.authorizeUpload(
            scopeId,
            sessionId,
            decodeURIComponent(authorization[1] ?? ""),
            await readJson(request),
            requireIdempotency(request),
          ),
        );
      }
      const receipt = /^\/chunks\/([^/]+)$/u.exec(path);
      if (request.method === "GET" && receipt !== null) {
        return jsonResponse(
          200,
          await domain.chunkReceipt(
            scopeId,
            sessionId,
            decodeURIComponent(receipt[1] ?? ""),
          ),
        );
      }
      if (request.method === "POST" && path === "/chunks") {
        return jsonResponse(
          201,
          await domain.registerChunk(
            scopeId,
            sessionId,
            await readJson(request),
            requireIdempotency(request),
          ),
        );
      }
      if (request.method === "POST" && path === "/capture-complete") {
        return jsonResponse(
          200,
          await domain.completeCapture(
            scopeId,
            sessionId,
            await readJson(request),
            requireIdempotency(request),
          ),
        );
      }
      if (request.method === "GET" && path === "/transcription-status") {
        return jsonResponse(200, await domain.transcriptionStatus(scopeId, sessionId));
      }
      if (request.method === "GET" && path === "/transcript") {
        return jsonResponse(200, await domain.transcript(scopeId, sessionId));
      }
      throw new PreviewDomainError(404, "route_not_found");
    } catch (error) {
      if (error instanceof PreviewDomainError || error instanceof PreviewValidationError) {
        return jsonResponse(error.status, {
          detail: { code: error.code, message: "synthetic preview request rejected" },
        });
      }
      return jsonResponse(500, {
        detail: { code: "preview_internal_error", message: "synthetic preview request failed" },
      });
    }
  };
}

export function deriveScopeId(host: string, cookieValue: string): string {
  return createHash("sha256")
    .update("capture-preview-scope-v1\0")
    .update(host)
    .update("\0")
    .update(cookieValue)
    .digest("hex");
}

function effectiveHost(
  request: Request,
  url: URL,
  allowedHosts: ReadonlySet<string>,
  allowedHostSuffixes: readonly string[],
): string {
  const originalUrl = parseOriginalUrl(request.headers.get("x-ms-original-url"));
  const forwarded = request.headers.get("x-forwarded-host");
  const origin = request.headers.get("origin");
  const forwardedHost = forwarded?.split(",", 1)[0]?.trim().toLowerCase();
  const candidate = originalUrl?.hostname.toLowerCase()
    ?? forwardedHost
    ?? url.hostname.toLowerCase();
  if (
    !HOST.test(candidate) ||
    candidate.includes(":") ||
    (!allowedHosts.has(candidate) &&
      !allowedHostSuffixes.some((suffix) => candidate.endsWith(suffix)))
  ) {
    throw new PreviewDomainError(403, "preview_host_rejected");
  }
  if (originalUrl !== null && originalUrl.pathname !== url.pathname) {
    throw new PreviewDomainError(403, "preview_host_rejected");
  }
  if (originalUrl === null && forwardedHost !== undefined && forwardedHost !== candidate) {
    throw new PreviewDomainError(403, "preview_host_rejected");
  }
  if (request.method === "POST" || request.method === "PUT") {
    if (origin === null) throw new PreviewDomainError(403, "preview_origin_required");
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new PreviewDomainError(403, "preview_origin_rejected");
    }
    if (
      parsedOrigin.protocol !== "https:" ||
      parsedOrigin.username !== "" ||
      parsedOrigin.password !== "" ||
      parsedOrigin.pathname !== "/" ||
      parsedOrigin.search !== "" ||
      parsedOrigin.hash !== "" ||
      parsedOrigin.port !== "" ||
      parsedOrigin.hostname.toLowerCase() !== candidate
    ) {
      throw new PreviewDomainError(403, "preview_origin_rejected");
    }
  }
  return candidate;
}

function parseOriginalUrl(value: string | null): URL | null {
  if (value === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PreviewDomainError(403, "preview_host_rejected");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.hash !== ""
  ) {
    throw new PreviewDomainError(403, "preview_host_rejected");
  }
  return parsed;
}

function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  let found: string | null = null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    if (found !== null) throw new PreviewDomainError(401, "preview_cookie_invalid");
    found = part.slice(separator + 1).trim();
  }
  return found;
}

function requireCookie(header: string | null): string {
  const value = readCookie(header, PREVIEW_COOKIE_NAME);
  if (value === null || !COOKIE_VALUE.test(value)) {
    throw new PreviewDomainError(401, "preview_bootstrap_required");
  }
  return value;
}

function requireIdempotency(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (
    value === null ||
    value.length < 8 ||
    value.length > 255 ||
    !/^[A-Za-z0-9._:-]+$/u.test(value)
  ) {
    throw new PreviewValidationError(422, "idempotency_key_required");
  }
  return value;
}

async function readJson(request: Request): Promise<JsonValue> {
  requireContentType(request, "application/json");
  const bytes = await readBoundedBytes(request, MAX_JSON_BYTES);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as JsonValue;
  } catch {
    throw new PreviewValidationError(400, "invalid_json");
  }
}

async function requireEmptyBody(request: Request): Promise<void> {
  const bytes = await readBoundedBytes(request, 0);
  if (bytes.byteLength !== 0) throw new PreviewValidationError(422, "request_invalid");
}

function requireContentType(request: Request, expected: string): void {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== expected) throw new PreviewValidationError(415, "content_type_invalid");
}

async function readBoundedBytes(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const value = Number(declared);
    if (!Number.isSafeInteger(value) || value < 0 || value > maximumBytes) {
      throw new PreviewValidationError(413, "request_too_large");
    }
  }
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new PreviewValidationError(413, "request_too_large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function jsonResponse(
  status: number,
  body: JsonValue,
  additionalHeaders: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...additionalHeaders,
    },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
