import {
  ELECTRON_IPC_MAX_PAYLOAD_BYTES,
  ELECTRON_IPC_SCHEMA_VERSION,
} from "./config.js";

export const COMPANION_STATES = [
  "permission_required",
  "meeting_detected",
  "ready",
  "recording",
  "stopped",
  "failed",
] as const;

export type CompanionState = (typeof COMPANION_STATES)[number];

export const FAILURE_CODES = [
  "adapter_failure",
  "authority_changed",
  "authority_revoked",
  "authority_stale",
  "authority_unavailable",
  "capability_replayed",
  "device_changed",
  "feature_disabled",
  "indicator_failure",
  "invalid_transition",
  "lease_unavailable",
  "network_lost",
  "precondition_failed",
  "renderer_unauthorized",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

/** Main-process-only value. It must never be sent to the renderer. */
export interface BackendCaptureGrant {
  readonly captureSessionId: string;
  readonly actorId: string;
  readonly consentRecordId: string;
  readonly consentStatus: "granted";
  readonly sessionStatus: "authorized";
  readonly source: "desktop_companion";
  readonly sourceLeaseId: string;
}

export interface OneTimeCaptureCapability {
  readonly capabilityId: string;
  secret: string;
  readonly expiresAt: string;
}

export type StartAuthorityDecision =
  | {
      readonly schemaVersion: typeof ELECTRON_IPC_SCHEMA_VERSION;
      readonly decision: "denied";
      readonly denialCode: "revoked";
    }
  | {
      readonly schemaVersion: typeof ELECTRON_IPC_SCHEMA_VERSION;
      readonly decision: "authorized";
      readonly captureSessionId: string;
      readonly actorId: string;
      readonly consentRecordId: string;
      readonly consentStatus: "granted";
      readonly sessionStatus: "authorized";
      readonly source: "desktop_companion";
      readonly sourceLeaseId: string;
      readonly issuedAt: string;
      readonly expiresAt: string;
      readonly captureCapability: OneTimeCaptureCapability;
    };

export type RendererCommandKind = "refresh_permissions" | "start" | "stop";

export interface RendererCommand {
  readonly schemaVersion: typeof ELECTRON_IPC_SCHEMA_VERSION;
  readonly kind: RendererCommandKind;
  readonly requestId: string;
}

export interface GetStateRequest {
  readonly schemaVersion: typeof ELECTRON_IPC_SCHEMA_VERSION;
  readonly requestId: string;
}

export interface ControllerStateEvent {
  readonly schemaVersion: typeof ELECTRON_IPC_SCHEMA_VERSION;
  readonly requestId: string | null;
  readonly state: CompanionState;
  readonly captureSessionId: string | null;
  readonly reasonCode: FailureCode | null;
}

export interface IpcCommandResult {
  readonly schemaVersion: typeof ELECTRON_IPC_SCHEMA_VERSION;
  readonly requestId: string;
  readonly ok: boolean;
  readonly errorCode: FailureCode | null;
}

export class ProtocolValidationError extends Error {
  constructor() {
    super("Invalid desktop companion IPC message");
    this.name = "ProtocolValidationError";
  }
}

function fail(): never {
  throw new ProtocolValidationError();
}

function assertBounded(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return fail();
  }
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength >
      ELECTRON_IPC_MAX_PAYLOAD_BYTES
  ) {
    fail();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail();
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const required = [...requiredKeys].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    fail();
  }
}

export function parseMetadataIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    return fail();
  }
  return value;
}

function asCapabilitySecret(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 8192 ||
    /[\r\n]/u.test(value)
  ) {
    return fail();
  }
  return value;
}

function asIsoTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !value.endsWith("Z") ||
    Number.isNaN(Date.parse(value))
  ) {
    return fail();
  }
  return value;
}

function asSchemaVersion(value: unknown): typeof ELECTRON_IPC_SCHEMA_VERSION {
  if (value !== ELECTRON_IPC_SCHEMA_VERSION) {
    return fail();
  }
  return ELECTRON_IPC_SCHEMA_VERSION;
}

function asState(value: unknown): CompanionState {
  if (
    typeof value !== "string" ||
    !COMPANION_STATES.includes(value as CompanionState)
  ) {
    return fail();
  }
  return value as CompanionState;
}

function asFailureCode(value: unknown): FailureCode {
  if (
    typeof value !== "string" ||
    !FAILURE_CODES.includes(value as FailureCode)
  ) {
    return fail();
  }
  return value as FailureCode;
}

export function parseBackendCaptureGrant(value: unknown): BackendCaptureGrant {
  assertBounded(value);
  const grant = asRecord(value);
  assertExactKeys(grant, [
    "captureSessionId",
    "actorId",
    "consentRecordId",
    "consentStatus",
    "sessionStatus",
    "source",
    "sourceLeaseId",
  ]);
  if (
    grant.consentStatus !== "granted" ||
    grant.sessionStatus !== "authorized" ||
    grant.source !== "desktop_companion"
  ) {
    return fail();
  }
  return Object.freeze({
    captureSessionId: parseMetadataIdentifier(grant.captureSessionId),
    actorId: parseMetadataIdentifier(grant.actorId),
    consentRecordId: parseMetadataIdentifier(grant.consentRecordId),
    consentStatus: "granted",
    sessionStatus: "authorized",
    source: "desktop_companion",
    sourceLeaseId: parseMetadataIdentifier(grant.sourceLeaseId),
  });
}

export function parseStartAuthorityDecision(
  value: unknown,
): StartAuthorityDecision {
  assertBounded(value);
  const decision = asRecord(value);
  if (decision.decision === "denied") {
    assertExactKeys(decision, ["schemaVersion", "decision", "denialCode"]);
    if (decision.denialCode !== "revoked") {
      return fail();
    }
    return Object.freeze({
      schemaVersion: asSchemaVersion(decision.schemaVersion),
      decision: "denied",
      denialCode: "revoked",
    });
  }
  if (decision.decision !== "authorized") {
    return fail();
  }
  assertExactKeys(decision, [
    "schemaVersion",
    "decision",
    "captureSessionId",
    "actorId",
    "consentRecordId",
    "consentStatus",
    "sessionStatus",
    "source",
    "sourceLeaseId",
    "issuedAt",
    "expiresAt",
    "captureCapability",
  ]);
  if (
    decision.consentStatus !== "granted" ||
    decision.sessionStatus !== "authorized" ||
    decision.source !== "desktop_companion"
  ) {
    return fail();
  }
  const captureCapability = asRecord(decision.captureCapability);
  assertExactKeys(captureCapability, [
    "capabilityId",
    "secret",
    "expiresAt",
  ]);
  return Object.freeze({
    schemaVersion: asSchemaVersion(decision.schemaVersion),
    decision: "authorized",
    captureSessionId: parseMetadataIdentifier(decision.captureSessionId),
    actorId: parseMetadataIdentifier(decision.actorId),
    consentRecordId: parseMetadataIdentifier(decision.consentRecordId),
    consentStatus: "granted",
    sessionStatus: "authorized",
    source: "desktop_companion",
    sourceLeaseId: parseMetadataIdentifier(decision.sourceLeaseId),
    issuedAt: asIsoTimestamp(decision.issuedAt),
    expiresAt: asIsoTimestamp(decision.expiresAt),
    captureCapability: {
      capabilityId: parseMetadataIdentifier(captureCapability.capabilityId),
      secret: asCapabilitySecret(captureCapability.secret),
      expiresAt: asIsoTimestamp(captureCapability.expiresAt),
    },
  });
}

/** Best-effort reference scrubbing; JavaScript cannot guarantee heap zeroization. */
export function wipeCaptureCapability(
  capability: OneTimeCaptureCapability,
): void {
  capability.secret = "";
}

export function parseRendererCommand(value: unknown): RendererCommand {
  assertBounded(value);
  const message = asRecord(value);
  assertExactKeys(message, ["schemaVersion", "kind", "requestId"]);
  const schemaVersion = asSchemaVersion(message.schemaVersion);
  if (
    message.kind !== "refresh_permissions" &&
    message.kind !== "start" &&
    message.kind !== "stop"
  ) {
    return fail();
  }
  return Object.freeze({
    schemaVersion,
    kind: message.kind,
    requestId: parseMetadataIdentifier(message.requestId),
  });
}

export function parseGetStateRequest(value: unknown): GetStateRequest {
  assertBounded(value);
  const request = asRecord(value);
  assertExactKeys(request, ["schemaVersion", "requestId"]);
  return Object.freeze({
    schemaVersion: asSchemaVersion(request.schemaVersion),
    requestId: parseMetadataIdentifier(request.requestId),
  });
}

export function parseControllerStateEvent(value: unknown): ControllerStateEvent {
  assertBounded(value);
  const event = asRecord(value);
  assertExactKeys(event, [
    "schemaVersion",
    "requestId",
    "state",
    "captureSessionId",
    "reasonCode",
  ]);
  const state = asState(event.state);
  const reasonCode =
    event.reasonCode === null ? null : asFailureCode(event.reasonCode);
  if ((state === "failed") !== (reasonCode !== null)) {
    return fail();
  }
  return Object.freeze({
    schemaVersion: asSchemaVersion(event.schemaVersion),
    requestId:
      event.requestId === null ? null : parseMetadataIdentifier(event.requestId),
    state,
    captureSessionId:
      event.captureSessionId === null
        ? null
        : parseMetadataIdentifier(event.captureSessionId),
    reasonCode,
  });
}

export function parseIpcCommandResult(value: unknown): IpcCommandResult {
  assertBounded(value);
  const result = asRecord(value);
  assertExactKeys(result, [
    "schemaVersion",
    "requestId",
    "ok",
    "errorCode",
  ]);
  if (typeof result.ok !== "boolean") {
    return fail();
  }
  const errorCode =
    result.errorCode === null ? null : asFailureCode(result.errorCode);
  if (result.ok === (errorCode !== null)) {
    return fail();
  }
  return Object.freeze({
    schemaVersion: asSchemaVersion(result.schemaVersion),
    requestId: parseMetadataIdentifier(result.requestId),
    ok: result.ok,
    errorCode,
  });
}
