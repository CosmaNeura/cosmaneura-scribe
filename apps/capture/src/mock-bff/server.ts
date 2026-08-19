import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { MAX_ENVELOPE_BYTES } from "@cosmaneura-scribe/capture-protocol";

import type {
  AudioChunkRegister,
  CaptureCompleteRequest,
  CaptureLeaseIssueRequest,
  CaptureLeaseRenewRequest,
  ChunkReservationBatchRequest,
  ChunkUploadAuthorizationRequest,
  ConsentCreate,
  SessionAudioKeyCreate,
  SessionCreate,
} from "../bff/contracts";
import {
  MockBffError,
  MockCaptureService,
  MockDroppedResponseError,
  type MockCaptureServiceOptions,
} from "./state";

const DEFAULT_PORT = 4_174;
const DEFAULT_WEB_ORIGIN = "http://127.0.0.1:5173";
const MAX_JSON_BYTES = 64 * 1_024;

export function createMockBffServer(options: MockCaptureServiceOptions = {}) {
  let service: MockCaptureService | undefined;
  const server = createServer((request, response) => {
    service ??= createServiceForListener(server, options);
    void route(request, response, service).catch((error: unknown) => {
      if (error instanceof MockDroppedResponseError) {
        request.socket.destroy();
        return;
      }
      if (error instanceof MockBffError) {
        sendJson(response, error.status, {
          detail: { code: error.code, message: "synthetic mock request failed" },
        });
        return;
      }
      sendJson(response, 500, {
        detail: { code: "mock_internal_error", message: "synthetic mock request failed" },
      });
    });
  });
  return server;
}

function createServiceForListener(
  server: Server,
  options: MockCaptureServiceOptions,
): MockCaptureService {
  if (options.uploadOrigin !== undefined) return new MockCaptureService(options);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock BFF must be listening on a TCP socket");
  }
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return new MockCaptureService({
    ...options,
    uploadOrigin: `http://${host}:${String(address.port)}`,
  });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  service: MockCaptureService,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "PUT" && url.pathname.startsWith("/mock-upload/")) {
    const objectId = decodeURIComponent(url.pathname.slice("/mock-upload/".length));
    const receiptId = url.searchParams.get("receipt");
    if (receiptId === null) throw new MockBffError(403, "upload_authorization_invalid");
    service.putEnvelope(objectId, receiptId, await readBytes(request, MAX_ENVELOPE_BYTES));
    response.writeHead(201, { "Cache-Control": "no-store" });
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/capture/audio-encryption-key") {
    sendJson(response, 200, service.audioEncryptionKey());
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/capture/consents") {
    sendJson(
      response,
      201,
      service.createConsent(
        await readJson<ConsentCreate>(request),
        requireIdempotencyKey(request),
      ),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/capture/sessions") {
    sendJson(
      response,
      201,
      service.createSession(
        await readJson<SessionCreate>(request),
        requireIdempotencyKey(request),
      ),
    );
    return;
  }

  const prefix = `/api/capture/sessions/${service.sessionId}`;
  if (!url.pathname.startsWith(prefix)) throw new MockBffError(404, "session_not_found");
  const path = url.pathname.slice(prefix.length);

  if (request.method === "POST" && path === "/audio-key") {
    sendJson(
      response,
      201,
      service.bindSessionAudioKey(
        service.sessionId,
        await readJson<SessionAudioKeyCreate>(request),
        requireIdempotencyKey(request),
      ),
    );
    return;
  }

  if (request.method === "GET" && path === "/capture-capabilities") {
    sendJson(response, 200, service.capabilities());
    return;
  }
  if (request.method === "POST" && path === "/capture-lease") {
    sendJson(
      response,
      201,
      service.issueLease(
        await readJson<CaptureLeaseIssueRequest>(request),
        requireIdempotencyKey(request),
      ),
    );
    return;
  }

  const renewal = /^\/capture-leases\/([^/]+)\/renew$/u.exec(path);
  if (request.method === "POST" && renewal !== null) {
    sendJson(
      response,
      200,
      service.renewLease(
        decodeURIComponent(renewal[1] ?? ""),
        await readJson<CaptureLeaseRenewRequest>(request),
        requireIdempotencyKey(request),
      ),
    );
    return;
  }
  if (request.method === "POST" && path === "/chunk-reservations") {
    sendJson(
      response,
      201,
      service.reserveChunks(
        await readJson<ChunkReservationBatchRequest>(request),
        requireIdempotencyKey(request),
      ),
    );
    return;
  }

  const authorization = /^\/chunks\/([^/]+)\/upload-authorization$/u.exec(path);
  if (request.method === "POST" && authorization !== null) {
    sendJson(
      response,
      201,
      service.authorizeUpload(
        decodeURIComponent(authorization[1] ?? ""),
        await readJson<ChunkUploadAuthorizationRequest>(request),
        requireIdempotencyKey(request),
      ),
    );
    return;
  }

  const receipt = /^\/chunks\/([^/]+)$/u.exec(path);
  if (request.method === "GET" && receipt !== null) {
    sendJson(response, 200, service.chunkReceipt(decodeURIComponent(receipt[1] ?? "")));
    return;
  }
  if (request.method === "POST" && path === "/chunks") {
    sendJson(
      response,
      201,
      service.registerChunk(
        await readJson<AudioChunkRegister>(request),
        requireIdempotencyKey(request),
      ),
    );
    return;
  }
  if (request.method === "POST" && path === "/capture-complete") {
    sendJson(
      response,
      200,
      service.completeCapture(
        await readJson<CaptureCompleteRequest>(request),
        requireIdempotencyKey(request),
      ),
    );
    return;
  }
  if (request.method === "GET" && path === "/transcription-status") {
    sendJson(response, 200, service.transcriptionStatus());
    return;
  }
  if (request.method === "GET" && path === "/transcript") {
    sendJson(response, 200, service.transcript());
    return;
  }
  throw new MockBffError(404, "route_not_found");
}

function requireIdempotencyKey(request: IncomingMessage): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 8 || value.length > 255) {
    throw new MockBffError(422, "idempotency_key_required");
  }
  return value;
}

async function readJson<Value>(request: IncomingMessage): Promise<Value> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new MockBffError(415, "json_required");
  const value = await readBytes(request, MAX_JSON_BYTES);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)) as Value;
  } catch {
    throw new MockBffError(400, "invalid_json");
  }
}

async function readBytes(request: IncomingMessage, maximumBytes: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of request as AsyncIterable<Uint8Array>) {
    const bytes = new Uint8Array(part.byteLength);
    bytes.set(part);
    total += bytes.byteLength;
    if (total > maximumBytes) throw new MockBffError(413, "request_too_large");
    parts.push(bytes);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parsePort(process.env.CAPTURE_MOCK_BFF_PORT);
  const server = createMockBffServer({ uploadOrigin: DEFAULT_WEB_ORIGIN });
  server.listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ action: "capture_mock_bff.ready", port }));
  });
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("invalid mock BFF port");
  }
  return port;
}
