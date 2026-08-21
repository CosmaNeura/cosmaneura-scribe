import { START_AUTHORITY_MAX_WINDOW_MS } from "./config.js";
import {
  parseStartAuthorityDecision,
  wipeCaptureCapability,
  type BackendCaptureGrant,
  type FailureCode,
  type OneTimeCaptureCapability,
} from "./protocol.js";

export interface TrustedCaptureAuthority {
  /** Must call the authenticated backend and honor abort; never the renderer. */
  authorizeStart(
    session: BackendCaptureGrant,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export class CaptureAuthorityError extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode) {
    super("Capture authority validation failed");
    this.name = "CaptureAuthorityError";
    this.code = code;
  }
}

export class DenyAllCaptureAuthority implements TrustedCaptureAuthority {
  authorizeStart(
    session: BackendCaptureGrant,
    signal: AbortSignal,
  ): Promise<unknown> {
    void session;
    void signal;
    return Promise.resolve({
      schemaVersion: 1,
      decision: "denied",
      denialCode: "revoked",
    });
  }
}

export class OneTimeCapabilityRegistry {
  readonly #consumed = new Set<string>();

  consume(capabilityId: string): void {
    if (this.#consumed.has(capabilityId)) {
      throw new CaptureAuthorityError("capability_replayed");
    }
    this.#consumed.add(capabilityId);
  }
}

export const processCapabilityRegistry = new OneTimeCapabilityRegistry();

export function validateFreshStartAuthority(
  value: unknown,
  expected: BackendCaptureGrant,
  now: Date,
): OneTimeCaptureCapability {
  const decision = parseStartAuthorityDecision(value);
  if (decision.decision === "denied") {
    throw new CaptureAuthorityError("authority_revoked");
  }
  if (
    decision.captureSessionId !== expected.captureSessionId ||
    decision.actorId !== expected.actorId ||
    decision.consentRecordId !== expected.consentRecordId ||
    decision.consentStatus !== expected.consentStatus ||
    decision.sessionStatus !== expected.sessionStatus ||
    decision.source !== expected.source ||
    decision.sourceLeaseId !== expected.sourceLeaseId
  ) {
    wipeCaptureCapability(decision.captureCapability);
    throw new CaptureAuthorityError("authority_changed");
  }

  const issuedAt = Date.parse(decision.issuedAt);
  const expiresAt = Date.parse(decision.expiresAt);
  const capabilityExpiresAt = Date.parse(decision.captureCapability.expiresAt);
  const nowMs = now.getTime();
  if (
    issuedAt > nowMs ||
    expiresAt <= nowMs ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > START_AUTHORITY_MAX_WINDOW_MS ||
    capabilityExpiresAt !== expiresAt
  ) {
    wipeCaptureCapability(decision.captureCapability);
    throw new CaptureAuthorityError("authority_stale");
  }
  return decision.captureCapability;
}
