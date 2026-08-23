import { createHash, randomBytes } from "node:crypto";

export const DESKTOP_CUSTOM_SCHEME = "cosmaneura-capture" as const;
export const DESKTOP_REDIRECT_URI =
  `${DESKTOP_CUSTOM_SCHEME}://oauth/callback` as const;
export const DESKTOP_AUTHORIZATION_MAX_AGE_MS = 3 * 60 * 1000;

const OPAQUE_SECRET = /^[A-Za-z0-9_-]{43,128}$/u;
const SHA256_VALUE = /^[A-Za-z0-9_-]{43}$/u;

export interface PendingDesktopAuthorization {
  readonly schemaVersion: 1;
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: typeof DESKTOP_REDIRECT_URI;
  readonly createdAt: string;
}

export interface DesktopAuthorizationCallback {
  readonly code: string;
  readonly state: string;
}

export interface DesktopBrowserHandoff {
  readonly connectUrl: string;
  readonly pending: PendingDesktopAuthorization;
}

export class DesktopBrowserHandoffError extends Error {
  constructor() {
    super("Desktop browser handoff was rejected");
    this.name = "DesktopBrowserHandoffError";
  }
}

export function createDesktopBrowserHandoff(
  launchTicket: string,
  installationSecret: string,
  platformAppOrigin: string,
  now: Date = new Date(),
  randomSecret: () => string = generateOpaqueSecret,
): DesktopBrowserHandoff {
  const ticket = parseOpaqueSecret(launchTicket);
  const verifier = parseOpaqueSecret(randomSecret());
  const state = parseOpaqueSecret(randomSecret());
  const installationThumbprint = sha256Base64Url(
    parseOpaqueSecret(installationSecret),
  );
  const origin = parsePlatformOrigin(platformAppOrigin);
  const connect = new URL("/desktop-capture/connect", origin);
  const fragment = new URLSearchParams({
    launch_ticket: ticket,
    code_challenge: sha256Base64Url(verifier),
    code_challenge_method: "S256",
    redirect_uri: DESKTOP_REDIRECT_URI,
    installation_thumbprint: installationThumbprint,
    state,
  });
  connect.hash = fragment.toString();
  return Object.freeze({
    connectUrl: connect.toString(),
    pending: Object.freeze({
      schemaVersion: 1,
      state,
      codeVerifier: verifier,
      redirectUri: DESKTOP_REDIRECT_URI,
      createdAt: now.toISOString(),
    }),
  });
}

export function parseDesktopLaunchUrl(value: string): string {
  const parsed = parseCustomUrl(value, "launch");
  assertExactSearchKeys(parsed, ["launch_ticket"]);
  return parseOpaqueSecret(parsed.searchParams.get("launch_ticket"));
}

export function parseDesktopAuthorizationCallback(
  value: string,
): DesktopAuthorizationCallback {
  const parsed = parseCustomUrl(value, "oauth", "/callback");
  assertExactSearchKeys(parsed, ["code", "state"]);
  return Object.freeze({
    code: parseOpaqueSecret(parsed.searchParams.get("code")),
    state: parseOpaqueSecret(parsed.searchParams.get("state")),
  });
}

export function validateDesktopAuthorizationCallback(
  callback: DesktopAuthorizationCallback,
  pending: PendingDesktopAuthorization,
  now: Date = new Date(),
): void {
  parsePendingDesktopAuthorization(pending);
  if (callback.state !== pending.state) {
    throw new DesktopBrowserHandoffError();
  }
  const createdAt = Date.parse(pending.createdAt);
  const age = now.getTime() - createdAt;
  if (age < 0 || age > DESKTOP_AUTHORIZATION_MAX_AGE_MS) {
    throw new DesktopBrowserHandoffError();
  }
}

export function parsePendingDesktopAuthorization(
  value: unknown,
): PendingDesktopAuthorization {
  const pending = asRecord(value);
  assertExactKeys(pending, [
    "schemaVersion",
    "state",
    "codeVerifier",
    "redirectUri",
    "createdAt",
  ]);
  if (
    pending.schemaVersion !== 1 ||
    pending.redirectUri !== DESKTOP_REDIRECT_URI
  ) {
    throw new DesktopBrowserHandoffError();
  }
  const createdAt = parseIsoTimestamp(pending.createdAt);
  return Object.freeze({
    schemaVersion: 1,
    state: parseOpaqueSecret(pending.state),
    codeVerifier: parseOpaqueSecret(pending.codeVerifier),
    redirectUri: DESKTOP_REDIRECT_URI,
    createdAt,
  });
}

export function generateOpaqueSecret(): string {
  return randomBytes(32).toString("base64url");
}

function parsePlatformOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DesktopBrowserHandoffError();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new DesktopBrowserHandoffError();
  }
  return parsed;
}

function parseCustomUrl(value: string, hostname: string, pathname = ""): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DesktopBrowserHandoffError();
  }
  if (
    parsed.protocol !== `${DESKTOP_CUSTOM_SCHEME}:` ||
    parsed.hostname !== hostname ||
    parsed.pathname !== pathname ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new DesktopBrowserHandoffError();
  }
  return parsed;
}

function assertExactSearchKeys(url: URL, keys: readonly string[]): void {
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== keys.length ||
    keys.some((key) => url.searchParams.getAll(key).length !== 1) ||
    entries.some(([key]) => !keys.includes(key))
  ) {
    throw new DesktopBrowserHandoffError();
  }
}

function sha256Base64Url(value: string): string {
  const digest = createHash("sha256").update(value, "utf8").digest("base64url");
  if (!SHA256_VALUE.test(digest)) {
    throw new DesktopBrowserHandoffError();
  }
  return digest;
}

function parseOpaqueSecret(value: unknown): string {
  if (typeof value !== "string" || !OPAQUE_SECRET.test(value)) {
    throw new DesktopBrowserHandoffError();
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
    throw new DesktopBrowserHandoffError();
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DesktopBrowserHandoffError();
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
    throw new DesktopBrowserHandoffError();
  }
}
