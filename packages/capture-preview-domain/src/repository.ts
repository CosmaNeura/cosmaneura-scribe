import { createHash } from "node:crypto";

export const PREVIEW_STATE_ID = "capture-preview-state";
export const PREVIEW_SCHEMA_VERSION = 1 as const;

export interface StoredIdempotencyRecord {
  readonly fingerprint: string;
  readonly response: JsonValue;
}

export interface StoredReservation {
  readonly objectId: string;
  readonly channel: "microphone";
  readonly sequenceNumber: number;
  readonly additionalAuthenticatedData: string;
  readonly createdAt: string;
}

export interface StoredAuthorization {
  readonly receiptSha256: string;
  readonly expiresAt: string;
}

export interface StoredAuditEvent {
  readonly operation:
    | "bootstrap"
    | "consent"
    | "session"
    | "bind-key"
    | "issue-lease"
    | "renew-lease"
    | "reserve"
    | "authorize"
    | "upload"
    | "register"
    | "complete";
  readonly recordedAt: string;
}

export interface StoredRegistration {
  readonly chunkId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly registeredAt: string;
}

export interface PreviewScopeState {
  readonly id: typeof PREVIEW_STATE_ID;
  readonly scopeId: string;
  readonly kind: "capture-preview-state";
  readonly schemaVersion: typeof PREVIEW_SCHEMA_VERSION;
  readonly ttl: number;
  readonly tenantId: string;
  readonly sessionId: string;
  consent: JsonObject | null;
  session: JsonObject | null;
  audioKeyReceipt: JsonObject | null;
  lease: JsonObject | null;
  audit: Record<string, StoredAuditEvent>;
  reservations: Record<string, StoredReservation>;
  authorizations: Record<string, StoredAuthorization>;
  registrations: Record<string, StoredRegistration>;
  idempotency: Record<string, StoredIdempotencyRecord>;
  completed: boolean;
  transcriptionPolls: number;
}

export interface PreviewEnvelope {
  readonly id: string;
  readonly scopeId: string;
  readonly kind: "capture-preview-envelope";
  readonly schemaVersion: typeof PREVIEW_SCHEMA_VERSION;
  readonly ttl: number;
  readonly objectId: string;
  readonly bytesBase64: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly uploadedAt: string;
}

export interface VersionedScopeState {
  readonly state: PreviewScopeState;
  readonly etag: string;
}

export interface PreviewRepository {
  health(): Promise<void>;
  claimBootstrapSlot(bucketId: string, maximum: number): Promise<boolean>;
  readScope(scopeId: string): Promise<VersionedScopeState | null>;
  createScope(state: PreviewScopeState): Promise<void>;
  replaceScope(state: PreviewScopeState, expectedEtag: string): Promise<void>;
  readEnvelope(scopeId: string, objectId: string): Promise<PreviewEnvelope | null>;
  createEnvelope(envelope: PreviewEnvelope): Promise<void>;
  deleteEnvelope(scopeId: string, objectId: string): Promise<void>;
}

export class PreviewRepositoryConflictError extends Error {
  public constructor() {
    super("preview repository conditional write conflict");
    this.name = "PreviewRepositoryConflictError";
  }
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export class InMemoryPreviewRepository implements PreviewRepository {
  readonly #states = new Map<string, { state: PreviewScopeState; revision: number }>();
  readonly #envelopes = new Map<string, PreviewEnvelope>();
  readonly #bootstrapBudgets = new Map<string, number>();

  public health(): Promise<void> {
    return Promise.resolve();
  }

  public claimBootstrapSlot(bucketId: string, maximum: number): Promise<boolean> {
    const current = this.#bootstrapBudgets.get(bucketId) ?? 0;
    if (current >= maximum) return Promise.resolve(false);
    this.#bootstrapBudgets.set(bucketId, current + 1);
    return Promise.resolve(true);
  }

  public readScope(scopeId: string): Promise<VersionedScopeState | null> {
    const stored = this.#states.get(scopeId);
    if (stored === undefined) return Promise.resolve(null);
    return Promise.resolve({
      state: structuredClone(stored.state),
      etag: `"${String(stored.revision)}"`,
    });
  }

  public createScope(state: PreviewScopeState): Promise<void> {
    if (this.#states.has(state.scopeId)) {
      return Promise.reject(new PreviewRepositoryConflictError());
    }
    this.#states.set(state.scopeId, { state: structuredClone(state), revision: 1 });
    return Promise.resolve();
  }

  public replaceScope(
    state: PreviewScopeState,
    expectedEtag: string,
  ): Promise<void> {
    const current = this.#states.get(state.scopeId);
    if (current === undefined || expectedEtag !== `"${String(current.revision)}"`) {
      return Promise.reject(new PreviewRepositoryConflictError());
    }
    this.#states.set(state.scopeId, {
      state: structuredClone(state),
      revision: current.revision + 1,
    });
    return Promise.resolve();
  }

  public readEnvelope(
    scopeId: string,
    objectId: string,
  ): Promise<PreviewEnvelope | null> {
    const value = this.#envelopes.get(envelopeKey(scopeId, objectId));
    return Promise.resolve(value === undefined ? null : structuredClone(value));
  }

  public createEnvelope(envelope: PreviewEnvelope): Promise<void> {
    const key = envelopeKey(envelope.scopeId, envelope.objectId);
    if (this.#envelopes.has(key)) {
      return Promise.reject(new PreviewRepositoryConflictError());
    }
    this.#envelopes.set(key, structuredClone(envelope));
    return Promise.resolve();
  }

  public deleteEnvelope(scopeId: string, objectId: string): Promise<void> {
    this.#envelopes.delete(envelopeKey(scopeId, objectId));
    return Promise.resolve();
  }
}

export function validatePreviewScopeState(
  value: unknown,
  expectedScopeId: string,
): PreviewScopeState {
  if (!isRecord(value)) throw new Error("stored preview state is invalid");
  const expectedKeys = [
    "audioKeyReceipt",
    "audit",
    "authorizations",
    "completed",
    "consent",
    "id",
    "idempotency",
    "kind",
    "lease",
    "registrations",
    "reservations",
    "schemaVersion",
    "scopeId",
    "session",
    "sessionId",
    "tenantId",
    "transcriptionPolls",
    "ttl",
  ];
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > 512_000 ||
    value.id !== PREVIEW_STATE_ID ||
    value.scopeId !== expectedScopeId ||
    value.kind !== "capture-preview-state" ||
    value.schemaVersion !== PREVIEW_SCHEMA_VERSION ||
    !isInteger(value.ttl, 900, 7 * 24 * 60 * 60) ||
    !isUuid(value.tenantId) ||
    !isUuid(value.sessionId) ||
    !isNullableRecord(value.consent) ||
    !isNullableRecord(value.session) ||
    !isNullableRecord(value.audioKeyReceipt) ||
    !isNullableRecord(value.lease) ||
    !isRecord(value.audit) ||
    Object.keys(value.audit).length > 72 ||
    !Object.keys(value.audit).every((key) => /^[0-9a-f]{64}$/u.test(key)) ||
    !Object.values(value.audit).every(isAuditEvent) ||
    !isRecord(value.reservations) ||
    Object.keys(value.reservations).length > 6 ||
    !Object.values(value.reservations).every(isReservation) ||
    !isRecord(value.authorizations) ||
    !Object.values(value.authorizations).every(isAuthorization) ||
    !isRecord(value.registrations) ||
    !Object.values(value.registrations).every(isRegistration) ||
    !isRecord(value.idempotency) ||
    Object.keys(value.idempotency).length > 64 ||
    !Object.keys(value.idempotency).every((key) => /^[0-9a-f]{64}$/u.test(key)) ||
    !Object.values(value.idempotency).every(isIdempotencyRecord) ||
    typeof value.completed !== "boolean" ||
    !isInteger(value.transcriptionPolls, 0, 100)
  ) {
    throw new Error("stored preview state is invalid");
  }
  return structuredClone(value) as unknown as PreviewScopeState;
}

export function validatePreviewEnvelope(
  value: unknown,
  expectedScopeId: string,
  expectedObjectId: string,
): PreviewEnvelope {
  if (!isRecord(value)) throw new Error("stored preview envelope is invalid");
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [
    "byteLength",
    "bytesBase64",
    "id",
    "kind",
    "objectId",
    "schemaVersion",
    "scopeId",
    "sha256",
    "ttl",
    "uploadedAt",
  ];
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    value.id !== previewEnvelopeId(expectedObjectId) ||
    value.scopeId !== expectedScopeId ||
    value.kind !== "capture-preview-envelope" ||
    value.schemaVersion !== PREVIEW_SCHEMA_VERSION ||
    value.objectId !== expectedObjectId ||
    !isInteger(value.ttl, 60, 60 * 60) ||
    typeof value.bytesBase64 !== "string" ||
    value.bytesBase64.length > 440_000 ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.sha256) ||
    !isInteger(value.byteLength, 1, 327_680)
    || typeof value.uploadedAt !== "string"
    || !Number.isFinite(Date.parse(value.uploadedAt))
  ) {
    throw new Error("stored preview envelope is invalid");
  }
  const bytes = Buffer.from(value.bytesBase64, "base64");
  if (
    bytes.toString("base64") !== value.bytesBase64 ||
    bytes.byteLength !== value.byteLength ||
    createHash("sha256").update(bytes).digest("hex") !== value.sha256
  ) {
    throw new Error("stored preview envelope is invalid");
  }
  return structuredClone(value) as unknown as PreviewEnvelope;
}

export function previewEnvelopeId(objectId: string): string {
  return `capture-preview-envelope:${objectId}`;
}

function envelopeKey(scopeId: string, objectId: string): string {
  return `${scopeId}:${objectId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableRecord(value: unknown): boolean {
  return value === null || isRecord(value);
}

function isInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  );
}

function isReservation(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "additionalAuthenticatedData",
      "channel",
      "createdAt",
      "objectId",
      "sequenceNumber",
    ]) &&
    isUuid(value.objectId) &&
    value.channel === "microphone" &&
    isInteger(value.sequenceNumber, 0, 5) &&
    typeof value.additionalAuthenticatedData === "string" &&
    value.additionalAuthenticatedData.length <= 1_024 &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt))
  );
}

function isAuthorization(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["expiresAt", "receiptSha256"]) &&
    typeof value.receiptSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.receiptSha256) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt))
  );
}

function isRegistration(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["byteLength", "chunkId", "registeredAt", "sha256"]) &&
    isUuid(value.chunkId) &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.sha256) &&
    isInteger(value.byteLength, 1, 327_680) &&
    typeof value.registeredAt === "string" &&
    Number.isFinite(Date.parse(value.registeredAt))
  );
}

function isIdempotencyRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["fingerprint", "response"]) &&
    typeof value.fingerprint === "string" &&
    /^[0-9a-f]{64}$/u.test(value.fingerprint) &&
    "response" in value
  );
}

function isAuditEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["operation", "recordedAt"]) &&
    typeof value.operation === "string" &&
    [
      "bootstrap",
      "consent",
      "session",
      "bind-key",
      "issue-lease",
      "renew-lease",
      "reserve",
      "authorize",
      "upload",
      "register",
      "complete",
    ].includes(value.operation) &&
    typeof value.recordedAt === "string" &&
    Number.isFinite(Date.parse(value.recordedAt))
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}
