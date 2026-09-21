import {
  BetaContractError,
  type BetaIngest,
  isUuid,
  parseBetaIngest,
  parseBetaIngestList,
} from "./contracts";

const API_PATH = "/api/beta/ingests";
const JSON_CONTENT_TYPE = "application/json";
const MAX_RESPONSE_BYTES = 131_072;

export type BetaApiErrorKind =
  | "configuration"
  | "conflict"
  | "invalid_response"
  | "not_found"
  | "unavailable";

export class BetaApiError extends Error {
  public readonly kind: BetaApiErrorKind;
  public readonly status: number | null;

  public constructor(kind: BetaApiErrorKind, status: number | null = null) {
    super("Local Scribe Beta request failed.");
    this.name = "BetaApiError";
    this.kind = kind;
    this.status = status;
  }
}

export interface BetaApi {
  createIngest(includeTranscript: boolean, idempotencyKey: string): Promise<BetaIngest>;
  getIngest(ingestId: string): Promise<BetaIngest>;
  listIngests(): Promise<readonly BetaIngest[]>;
}

export class HttpBetaApi implements BetaApi {
  private readonly tenantId: string;

  public constructor(
    tenantId: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    if (!isUuid(tenantId)) throw new BetaApiError("configuration");
    this.tenantId = tenantId.toLowerCase();
  }

  public async listIngests(): Promise<readonly BetaIngest[]> {
    const value = await this.requestJson(API_PATH, { method: "GET" });
    try {
      return parseBetaIngestList(value, this.tenantId);
    } catch (error) {
      if (error instanceof BetaContractError) throw new BetaApiError("invalid_response");
      throw error;
    }
  }

  public async createIngest(
    includeTranscript: boolean,
    idempotencyKey: string,
  ): Promise<BetaIngest> {
    if (!isValidIdempotencyKey(idempotencyKey)) {
      throw new BetaApiError("configuration");
    }
    const value = await this.requestJson(API_PATH, {
      method: "POST",
      headers: {
        "Content-Type": JSON_CONTENT_TYPE,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ include_transcript: includeTranscript }),
    });
    return this.parseIngest(value);
  }

  public async getIngest(ingestId: string): Promise<BetaIngest> {
    if (!isUuid(ingestId)) throw new BetaApiError("configuration");
    const value = await this.requestJson(`${API_PATH}/${encodeURIComponent(ingestId)}`, {
      method: "GET",
    });
    return this.parseIngest(value);
  }

  private parseIngest(value: unknown): BetaIngest {
    try {
      return parseBetaIngest(value, this.tenantId);
    } catch (error) {
      if (error instanceof BetaContractError) throw new BetaApiError("invalid_response");
      throw error;
    }
  }

  private async requestJson(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImplementation.call(globalThis, path, {
        ...init,
        headers: {
          "X-Tenant-ID": this.tenantId,
          ...init.headers,
        },
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new BetaApiError("unavailable");
    }

    if (!response.ok) {
      const kind = response.status === 404
        ? "not_found"
        : response.status === 409
          ? "conflict"
          : "unavailable";
      throw new BetaApiError(kind, response.status);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== JSON_CONTENT_TYPE) throw new BetaApiError("invalid_response");
    return readBoundedJson(response);
  }
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      throw new BetaApiError("invalid_response");
    }
  }
  if (response.body === null) throw new BetaApiError("invalid_response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new BetaApiError("invalid_response");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const encoded = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)) as unknown;
  } catch {
    throw new BetaApiError("invalid_response");
  }
}

function isValidIdempotencyKey(value: string): boolean {
  return (
    value.length >= 8 &&
    value.length <= 255 &&
    value.trim() === value &&
    !/[\r\n]/u.test(value)
  );
}
