import type { TrustedCaptureAuthority } from "./capture-authority.js";
import type { DESKTOP_REDIRECT_URI } from "./browser-handoff.js";
import {
  parseBackendCaptureGrant,
  parseMetadataIdentifier,
  parseStartAuthorityDecision,
  type BackendCaptureGrant,
  type StartAuthorityDecision,
} from "./protocol.js";

const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_SESSION_SECONDS = 6 * 60 * 60;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,254}$/u;

export interface DesktopSessionCredential {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly grant: BackendCaptureGrant;
}

export interface AuthorizationCodeExchangeInput {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: typeof DESKTOP_REDIRECT_URI;
}

export interface DesktopLifecycleDecision {
  readonly schemaVersion: 1;
  readonly decision: "accepted";
  readonly captureSessionId: string;
  readonly capabilityId: string;
  readonly receiptId: string;
  readonly sessionStatus: "recording" | "stopping";
}

export class DesktopApiError extends Error {
  readonly code:
    | "invalid_configuration"
    | "invalid_response"
    | "rejected"
    | "unauthorized"
    | "unavailable";

  constructor(code: DesktopApiError["code"]) {
    super("Desktop API operation failed");
    this.name = "DesktopApiError";
    this.code = code;
  }
}

export class DesktopApiClient {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #clock: () => Date;

  constructor(
    baseUrl: string,
    options: {
      readonly fetch?: typeof fetch;
      readonly clock?: () => Date;
      readonly allowInsecureLoopback?: boolean;
    } = {},
  ) {
    this.#baseUrl = parseApiOrigin(
      baseUrl,
      options.allowInsecureLoopback ?? false,
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? (() => new Date());
  }

  async exchangeAuthorizationCode(
    input: AuthorizationCodeExchangeInput,
    signal: AbortSignal,
  ): Promise<DesktopSessionCredential> {
    const response = await this.#request(
      "/desktop/v1/oauth/token",
      {
        grant_type: "authorization_code",
        code: parseSecret(input.code, 43, 128),
        code_verifier: parseSecret(input.codeVerifier, 43, 128),
        redirect_uri: input.redirectUri,
      },
      signal,
    );
    if (!response.ok) {
      throwForStatus(response.status);
    }
    return parseTokenResponse(
      await readBoundedJson(response),
      this.#clock(),
    );
  }

  async authorizeStart(
    credential: DesktopSessionCredential,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<StartAuthorityDecision> {
    const response = await this.#authorizedRequest(
      credential,
      `/desktop/v1/capture-sessions/${encodeURIComponent(
        parseMetadataIdentifier(credential.grant.captureSessionId),
      )}/segments/start-authorizations`,
      {},
      idempotencyKey,
      signal,
    );
    if ([401, 403, 409].includes(response.status)) {
      return Object.freeze({
        schemaVersion: 1,
        decision: "denied",
        denialCode: "revoked",
      });
    }
    if (!response.ok) {
      throwForStatus(response.status);
    }
    return parseStartAuthorityDecision(await readBoundedJson(response));
  }

  async heartbeat(
    credential: DesktopSessionCredential,
    capabilityId: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<DesktopLifecycleDecision> {
    return this.#lifecycleRequest(
      credential,
      capabilityId,
      "heartbeats",
      idempotencyKey,
      signal,
    );
  }

  async requestStop(
    credential: DesktopSessionCredential,
    capabilityId: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<DesktopLifecycleDecision> {
    return this.#lifecycleRequest(
      credential,
      capabilityId,
      "stop-requests",
      idempotencyKey,
      signal,
    );
  }

  async #lifecycleRequest(
    credential: DesktopSessionCredential,
    capabilityId: string,
    operation: "heartbeats" | "stop-requests",
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<DesktopLifecycleDecision> {
    const captureSessionId = parseMetadataIdentifier(
      credential.grant.captureSessionId,
    );
    const validatedCapabilityId = parseMetadataIdentifier(capabilityId);
    const response = await this.#authorizedRequest(
      credential,
      `/desktop/v1/capture-sessions/${encodeURIComponent(
        captureSessionId,
      )}/${operation}`,
      { capabilityId: validatedCapabilityId },
      idempotencyKey,
      signal,
    );
    if (!response.ok) {
      throwForStatus(response.status);
    }
    return parseLifecycleDecision(
      await readBoundedJson(response),
      captureSessionId,
      validatedCapabilityId,
    );
  }

  #authorizedRequest(
    credential: DesktopSessionCredential,
    path: string,
    body: unknown,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<Response> {
    if (Date.parse(credential.expiresAt) <= this.#clock().getTime()) {
      throw new DesktopApiError("unauthorized");
    }
    const accessToken = parseSecret(credential.accessToken, 43, 8192);
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new DesktopApiError("invalid_configuration");
    }
    return this.#request(path, body, signal, {
      Authorization: `Bearer ${accessToken}`,
      "Idempotency-Key": idempotencyKey,
    });
  }

  async #request(
    path: string,
    body: unknown,
    signal: AbortSignal,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    try {
      return await this.#fetch(new URL(path, this.#baseUrl), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw new DesktopApiError("unavailable");
    }
  }
}

export class PlatformDesktopCaptureAuthority
  implements TrustedCaptureAuthority
{
  readonly #api: DesktopApiClient;
  readonly #credential: () => Promise<DesktopSessionCredential>;
  readonly #idempotencyKey: () => string;

  constructor(
    api: DesktopApiClient,
    credential: () => Promise<DesktopSessionCredential>,
    idempotencyKey: () => string,
  ) {
    this.#api = api;
    this.#credential = credential;
    this.#idempotencyKey = idempotencyKey;
  }

  async authorizeStart(
    session: BackendCaptureGrant,
    signal: AbortSignal,
  ): Promise<unknown> {
    const credential = await this.#credential();
    if (
      JSON.stringify(parseBackendCaptureGrant(credential.grant)) !==
      JSON.stringify(parseBackendCaptureGrant(session))
    ) {
      return Object.freeze({
        schemaVersion: 1,
        decision: "denied",
        denialCode: "revoked",
      });
    }
    return this.#api.authorizeStart(
      credential,
      this.#idempotencyKey(),
      signal,
    );
  }
}

function parseApiOrigin(value: string, allowInsecureLoopback: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DesktopApiError("invalid_configuration");
  }
  const loopback =
    allowInsecureLoopback &&
    parsed.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !loopback) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new DesktopApiError("invalid_configuration");
  }
  return parsed;
}

function parseTokenResponse(value: unknown, now: Date): DesktopSessionCredential {
  const response = asRecord(value);
  assertExactKeys(response, ["access_token", "expires_in", "grant", "token_type"]);
  if (
    response.token_type !== "Bearer" ||
    typeof response.expires_in !== "number" ||
    !Number.isInteger(response.expires_in) ||
    response.expires_in < 1 ||
    response.expires_in > MAX_SESSION_SECONDS
  ) {
    throw new DesktopApiError("invalid_response");
  }
  return Object.freeze({
    accessToken: parseSecret(response.access_token, 43, 8192),
    expiresAt: new Date(now.getTime() + response.expires_in * 1000).toISOString(),
    grant: parseBackendCaptureGrant(response.grant),
  });
}

export function parseDesktopSessionCredential(
  value: unknown,
): DesktopSessionCredential {
  const credential = asRecord(value);
  assertExactKeys(credential, ["accessToken", "expiresAt", "grant"]);
  const expiresAt = parseIsoTimestamp(credential.expiresAt);
  return Object.freeze({
    accessToken: parseSecret(credential.accessToken, 43, 8192),
    expiresAt,
    grant: parseBackendCaptureGrant(credential.grant),
  });
}

function parseLifecycleDecision(
  value: unknown,
  expectedCaptureSessionId: string,
  expectedCapabilityId: string,
): DesktopLifecycleDecision {
  const decision = asRecord(value);
  assertExactKeys(decision, [
    "schemaVersion",
    "decision",
    "captureSessionId",
    "capabilityId",
    "receiptId",
    "sessionStatus",
  ]);
  const captureSessionId = parseMetadataIdentifier(decision.captureSessionId);
  const capabilityId = parseMetadataIdentifier(decision.capabilityId);
  if (
    decision.schemaVersion !== 1 ||
    decision.decision !== "accepted" ||
    captureSessionId !== expectedCaptureSessionId ||
    capabilityId !== expectedCapabilityId ||
    (decision.sessionStatus !== "recording" &&
      decision.sessionStatus !== "stopping")
  ) {
    throw new DesktopApiError("invalid_response");
  }
  return Object.freeze({
    schemaVersion: 1,
    decision: "accepted",
    captureSessionId,
    capabilityId,
    receiptId: parseMetadataIdentifier(decision.receiptId),
    sessionStatus: decision.sessionStatus,
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (
    new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES ||
    text.length === 0
  ) {
    throw new DesktopApiError("invalid_response");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DesktopApiError("invalid_response");
  }
}

function throwForStatus(status: number): never {
  if (status === 401 || status === 403) {
    throw new DesktopApiError("unauthorized");
  }
  if (status === 400 || status === 409 || status === 422) {
    throw new DesktopApiError("rejected");
  }
  throw new DesktopApiError("unavailable");
}

function parseSecret(value: unknown, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    /[\r\n]/u.test(value)
  ) {
    throw new DesktopApiError("invalid_response");
  }
  return value;
}

function parseIsoTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !value.endsWith("Z") ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new DesktopApiError("invalid_response");
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DesktopApiError("invalid_response");
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new DesktopApiError("invalid_response");
  }
}
