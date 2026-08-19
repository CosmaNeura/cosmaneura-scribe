import type {
  AudioEncryptionPublicKey,
  AudioChunk,
  AudioChunkRegister,
  CaptureBff,
  CaptureCapabilities,
  CaptureCompleteRequest,
  CaptureLeaseIssueRequest,
  CaptureLeaseReceipt,
  CaptureLeaseRenewRequest,
  CaptureSession,
  CaptureTranscriptionStatus,
  ChunkReceipt,
  ChunkReservationBatchReceipt,
  ChunkReservationBatchRequest,
  ChunkUploadAuthorization,
  ChunkUploadAuthorizationRequest,
  MutationOptions,
  RequestOptions,
  ConsentCreate,
  ConsentRecord,
  SessionAudioKeyCreate,
  SessionAudioKeyReceipt,
  SessionCreate,
  Transcript,
} from "./contracts";

const JSON_CONTENT_TYPE = "application/json";
const MAX_JSON_RESPONSE_BYTES = 65_536;
const SAME_ORIGIN_VALIDATION_BASE = "https://capture.invalid";

export class BffResponseError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string | null,
    public readonly retryAfterMs: number | null,
    message = "capture BFF request failed",
  ) {
    super(message);
    this.name = "BffResponseError";
  }
}

export class HttpCaptureBff implements CaptureBff {
  public constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly basePath = "/api/capture",
  ) {
    if (!isCanonicalSameOriginPath(basePath)) {
      throw new Error("capture BFF base path must be same-origin");
    }
  }

  public getAudioEncryptionKey(
    options: RequestOptions = {},
  ): Promise<AudioEncryptionPublicKey> {
    return this.requestJson("/audio-encryption-key", {
      method: "GET",
      ...signalInit(options.signal),
    });
  }

  public createConsent(
    request: ConsentCreate,
    options: MutationOptions,
  ): Promise<ConsentRecord> {
    return this.mutate("/consents", request, options);
  }

  public createSession(
    request: SessionCreate,
    options: MutationOptions,
  ): Promise<CaptureSession> {
    return this.mutate("/sessions", request, options);
  }

  public bindSessionAudioKey(
    sessionId: string,
    request: SessionAudioKeyCreate,
    options: MutationOptions,
  ): Promise<SessionAudioKeyReceipt> {
    return this.mutate(
      `/sessions/${encodeURIComponent(sessionId)}/audio-key`,
      request,
      options,
    );
  }

  public getCapabilities(
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<CaptureCapabilities> {
    return this.requestJson(
      `/sessions/${encodeURIComponent(sessionId)}/capture-capabilities`,
      { method: "GET", ...signalInit(options.signal) },
    );
  }

  public issueLease(
    sessionId: string,
    request: CaptureLeaseIssueRequest,
    options: MutationOptions,
  ): Promise<CaptureLeaseReceipt> {
    return this.mutate(`/sessions/${encodeURIComponent(sessionId)}/capture-lease`, request, options);
  }

  public renewLease(
    sessionId: string,
    leaseId: string,
    request: CaptureLeaseRenewRequest,
    options: MutationOptions,
  ): Promise<CaptureLeaseReceipt> {
    return this.mutate(
      `/sessions/${encodeURIComponent(sessionId)}/capture-leases/${encodeURIComponent(leaseId)}/renew`,
      request,
      options,
    );
  }

  public reserveChunks(
    sessionId: string,
    request: ChunkReservationBatchRequest,
    options: MutationOptions,
  ): Promise<ChunkReservationBatchReceipt> {
    return this.mutate(
      `/sessions/${encodeURIComponent(sessionId)}/chunk-reservations`,
      request,
      options,
    );
  }

  public authorizeUpload(
    sessionId: string,
    objectId: string,
    request: ChunkUploadAuthorizationRequest,
    options: MutationOptions,
  ): Promise<ChunkUploadAuthorization> {
    return this.mutate(
      `/sessions/${encodeURIComponent(sessionId)}/chunks/${encodeURIComponent(objectId)}/upload-authorization`,
      request,
      options,
    );
  }

  public getChunkReceipt(
    sessionId: string,
    objectId: string,
    options: RequestOptions = {},
  ): Promise<ChunkReceipt> {
    return this.requestJson(
      `/sessions/${encodeURIComponent(sessionId)}/chunks/${encodeURIComponent(objectId)}`,
      { method: "GET", ...signalInit(options.signal) },
    );
  }

  public registerChunk(
    sessionId: string,
    request: AudioChunkRegister,
    options: MutationOptions,
  ): Promise<AudioChunk> {
    return this.mutate(`/sessions/${encodeURIComponent(sessionId)}/chunks`, request, options);
  }

  public completeCapture(
    sessionId: string,
    request: CaptureCompleteRequest,
    options: MutationOptions,
  ): Promise<CaptureSession> {
    return this.mutate(`/sessions/${encodeURIComponent(sessionId)}/capture-complete`, request, options);
  }

  public getTranscriptionStatus(
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<CaptureTranscriptionStatus> {
    return this.requestJson(
      `/sessions/${encodeURIComponent(sessionId)}/transcription-status`,
      { method: "GET", ...signalInit(options.signal) },
    );
  }

  public getTranscript(
    sessionId: string,
    options: RequestOptions = {},
  ): Promise<Transcript> {
    return this.requestJson(
      `/sessions/${encodeURIComponent(sessionId)}/transcript`,
      { method: "GET", ...signalInit(options.signal) },
    );
  }

  private mutate<Response, Request>(
    path: string,
    request: Request,
    options: MutationOptions,
  ): Promise<Response> {
    validateIdempotencyKey(options.idempotencyKey);
    return this.requestJson(path, {
      method: "POST",
      ...signalInit(options.signal),
      headers: {
        "Content-Type": JSON_CONTENT_TYPE,
        "Idempotency-Key": options.idempotencyKey,
      },
      body: JSON.stringify(request),
    });
  }

  private async requestJson<Response>(path: string, init: RequestInit): Promise<Response> {
    const response = await this.fetchImplementation.call(
      globalThis,
      `${this.basePath}${path}`,
      {
        ...init,
        credentials: "include",
        redirect: "error",
        cache: "no-store",
      },
    );
    if (!response.ok) {
      throw new BffResponseError(
        response.status,
        await readFixedErrorCode(response),
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== JSON_CONTENT_TYPE) {
      throw new BffResponseError(
        response.status,
        null,
        null,
        "capture BFF returned an invalid content type",
      );
    }
    return (await readBoundedJson(response)) as Response;
  }
}

function isCanonicalSameOriginPath(value: string): boolean {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    hasControlCharacter(value)
  ) {
    return false;
  }
  try {
    const resolved = new URL(value, SAME_ORIGIN_VALIDATION_BASE);
    return (
      resolved.origin === SAME_ORIGIN_VALIDATION_BASE &&
      resolved.pathname === value &&
      resolved.search === "" &&
      resolved.hash === ""
    );
  } catch {
    return false;
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

async function readFixedErrorCode(response: Response): Promise<string | null> {
  try {
    const value = await readBoundedJson(response, 8_192);
    if (
      typeof value === "object" &&
      value !== null &&
      "detail" in value &&
      typeof value.detail === "object" &&
      value.detail !== null &&
      "code" in value.detail &&
      typeof value.detail.code === "string" &&
      /^[a-z0-9_]{1,64}$/u.test(value.detail.code)
    ) {
      return value.detail.code;
    }
  } catch {
    return null;
  }
  return null;
}

async function readBoundedJson(
  response: Response,
  maximumBytes = MAX_JSON_RESPONSE_BYTES,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
      throw new BffResponseError(
        response.status,
        null,
        null,
        "capture BFF response exceeded its size limit",
      );
    }
  }
  if (response.body === null) {
    throw new BffResponseError(
      response.status,
      null,
      null,
      "capture BFF returned an invalid JSON response",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new BffResponseError(
          response.status,
          null,
          null,
          "capture BFF response exceeded its size limit",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const encoded = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)) as unknown;
  } catch (error) {
    if (error instanceof BffResponseError) throw error;
    throw new BffResponseError(
      response.status,
      null,
      null,
      "capture BFF returned an invalid JSON response",
    );
  }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  if (/^[0-9]+$/u.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? Math.min(seconds * 1_000, 300_000) : null;
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(0, at - now), 300_000);
}

function signalInit(signal: AbortSignal | undefined): Pick<RequestInit, "signal"> | object {
  return signal === undefined ? {} : { signal };
}

function validateIdempotencyKey(value: string): void {
  if (value.length < 8 || value.length > 255 || /[\r\n]/u.test(value)) {
    throw new Error("invalid idempotency key");
  }
}
