import { describe, expect, it, vi } from "vitest";

import { DESKTOP_REDIRECT_URI } from "./browser-handoff.js";
import {
  DesktopApiClient,
  DesktopApiError,
  PlatformDesktopCaptureAuthority,
} from "./desktop-api.js";

const ACCESS_TOKEN = "t".repeat(43);
const AUTH_CODE = "c".repeat(43);
const VERIFIER = "v".repeat(43);
const grant = {
  captureSessionId: "capture-synthetic-001",
  actorId: "actor-synthetic-001",
  consentRecordId: "consent-synthetic-001",
  consentStatus: "granted",
  sessionStatus: "authorized",
  source: "desktop_companion",
  sourceLeaseId: "lease-synthetic-001",
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("desktop API main-process client", () => {
  it("exchanges PKCE without cookies or redirects and parses the exact grant", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        access_token: ACCESS_TOKEN,
        expires_in: 300,
        grant,
        token_type: "Bearer",
      }),
    );
    const api = new DesktopApiClient("https://api.example.invalid", {
      fetch: fetchMock,
      clock: () => new Date("2030-01-01T00:00:00.000Z"),
    });

    await expect(
      api.exchangeAuthorizationCode(
        {
          code: AUTH_CODE,
          codeVerifier: VERIFIER,
          redirectUri: DESKTOP_REDIRECT_URI,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      accessToken: ACCESS_TOKEN,
      expiresAt: "2030-01-01T00:05:00.000Z",
      grant,
    });
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.example.invalid/desktop/v1/oauth/token");
    expect(options).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(JSON.stringify(options)).not.toContain(ACCESS_TOKEN);
  });

  it("keeps the bearer in the main-process request and sends no domain authority", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        schemaVersion: 1,
        decision: "authorized",
        ...grant,
        issuedAt: "2030-01-01T00:00:00.000Z",
        expiresAt: "2030-01-01T00:05:00.000Z",
        captureCapability: {
          capabilityId: "capability-synthetic-001",
          secret: "u".repeat(43),
          expiresAt: "2030-01-01T00:05:00.000Z",
        },
      }),
    );
    const api = new DesktopApiClient("https://api.example.invalid", {
      fetch: fetchMock,
      clock: () => new Date("2030-01-01T00:00:30.000Z"),
    });
    const credential = {
      accessToken: ACCESS_TOKEN,
      expiresAt: "2030-01-01T00:05:00.000Z",
      grant,
    };

    await api.authorizeStart(
      credential,
      "start.request-synthetic-001",
      new AbortController().signal,
    );
    const [, options] = fetchMock.mock.calls[0] ?? [];
    expect(options?.headers).toMatchObject({
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Idempotency-Key": "start.request-synthetic-001",
    });
    expect(options?.body).toBe("{}");
  });

  it("turns a revoked backend decision into a value-free denial", async () => {
    const api = new DesktopApiClient("https://api.example.invalid", {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ detail: "x" }, 403)),
      clock: () => new Date("2030-01-01T00:00:30.000Z"),
    });
    const authority = new PlatformDesktopCaptureAuthority(
      api,
      () =>
        Promise.resolve({
          accessToken: ACCESS_TOKEN,
          expiresAt: "2030-01-01T00:05:00.000Z",
          grant,
        }),
      () => "start.request-synthetic-002",
    );

    await expect(
      authority.authorizeStart(grant, new AbortController().signal),
    ).resolves.toEqual({
      schemaVersion: 1,
      decision: "denied",
      denialCode: "revoked",
    });
  });

  it("rejects insecure origins, expired credentials, and extra response fields", async () => {
    expect(() => new DesktopApiClient("http://api.example.invalid")).toThrow(
      DesktopApiError,
    );
    const api = new DesktopApiClient("https://api.example.invalid", {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          access_token: ACCESS_TOKEN,
          expires_in: 300,
          grant,
          token_type: "Bearer",
          extra: true,
        }),
      ),
      clock: () => new Date("2030-01-01T00:00:00.000Z"),
    });
    await expect(
      api.exchangeAuthorizationCode(
        {
          code: AUTH_CODE,
          codeVerifier: VERIFIER,
          redirectUri: DESKTOP_REDIRECT_URI,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});
