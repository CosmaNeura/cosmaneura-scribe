import type * as Bff from "../bff/contracts";
import { BffResponseError } from "../bff/http-client";
import { readBoundedJson } from "../../../review-ui/src/beta-api";
import { isUuid } from "../../../review-ui/src/contracts";
import type { AuthorizedReviewRequest } from "../../../review-ui/src/creator-review-api";

/** The authenticated host adds its existing workload/mount context server-side. */
export type AuthorizedCoreRequest = (path: string, body: Readonly<Record<string, unknown>>,
  key: string, signal: AbortSignal) => Promise<Response>;
export interface CoreCaptureScope {
  readonly bindingRef: string;
  readonly workspaceId: string;
  readonly appointmentRef: string;
}
export type LanguageMode = "en-US" | "en-US+es-US";
export interface AdmissionIntent {
  readonly key: string;
  readonly languageMode: LanguageMode;
  readonly attestation: {
    readonly modality: "in_person" | "virtual" | "phone";
    readonly participant_regions: readonly string[];
    readonly method: "verbal_attestation";
    readonly all_parties_consented: true;
    readonly granted_at: string;
  };
}
export type CoreOperation = { readonly kind: string; readonly payload?: unknown;
  readonly object_id?: string; readonly lease_id?: string };

/** Fixed Core facade; never sends demographics, authority claims or transcript text. */
export class CoreCaptureClient {
  constructor(readonly scope: CoreCaptureScope, private readonly request: AuthorizedCoreRequest,
    readonly signal: AbortSignal) {
    requireValue(isUuid(scope.workspaceId) && reference(scope.bindingRef, "scribe_capture_binding")
      && reference(scope.appointmentRef, "appointment") && !signal.aborted);
  }

  async admit(intent: AdmissionIntent): Promise<string> {
    return this.admitWithAttestation(intent, intent.attestation);
  }

  /** Resume server custody before considering another consent submission. */
  async recoverAdmission(intent: AdmissionIntent): Promise<string | null> {
    try { return await this.admitWithAttestation(intent, null); }
    catch (error) {
      if (error instanceof BffResponseError && error.code === "core_capture_consent_required") return null;
      throw error;
    }
  }

  /** Called only after the clinician explicitly reconfirms the displayed consent. */
  async renewAdmission(intent: AdmissionIntent): Promise<string> {
    return this.admitWithAttestation(intent, { ...intent.attestation, granted_at: new Date().toISOString() });
  }

  private async admitWithAttestation(intent: AdmissionIntent, attestation: AdmissionIntent["attestation"] | null): Promise<string> {
    const value = await this.send("capture-admissions", {
      attestation,
      configured_capture: { schema_version: "1.0", language_mode: intent.languageMode },
    }, intent.key);
    requireValue(reference(value.operation_ref, "scribe_admission")
      && value.appointment_ref === this.scope.appointmentRef
      && isUuid(value.consent_record_id) && isUuid(value.session_id));
    return value.session_id;
  }

  async operation(sessionId: string, operation: CoreOperation, key: string = crypto.randomUUID()): Promise<unknown> {
    requireValue(isUuid(sessionId));
    const value = await this.send("capture-operations", { operation }, key);
    requireValue(value.operation === operation.kind && record(value.receipt));
    // All session-bearing receipts must match the admitted session. Core also
    // validates operation-specific contracts before returning this envelope.
    const receipt = value.receipt;
    requireValue(!("session_id" in receipt) || receipt.session_id === sessionId);
    if (operation.kind === "complete") requireValue(receipt.id === sessionId);
    return receipt;
  }

  async note(sessionId: string, action: "templates" | "read" | "prepare" | "save" | "resolve",
    schema?: string, edit?: unknown, key: string = crypto.randomUUID()): Promise<unknown> {
    requireValue(isUuid(sessionId) && (action === "templates" || reference(schema, "doctor_note_schema")));
    const value = await this.send("capture-notes", { expected_session_id: sessionId, action,
      ...(schema ? { schema_ref: schema } : {}), ...(edit ? { edit } : {}) }, key);
    requireValue(value.action === action && record(value.receipt) && value.receipt.session_id === sessionId);
    return value.receipt;
  }

  reviewRequest(sessionId: string): AuthorizedReviewRequest {
    requireValue(isUuid(sessionId));
    const expectedPath = `/v1/captured-sessions/${sessionId}/review`;
    return async (path, request) => {
      requireValue(path === expectedPath && (request.method === "GET"
        ? request.body === undefined && request.key === undefined
        : request.body !== undefined && request.key !== undefined));
      try {
        const value = await this.operation(sessionId, request.method === "GET"
          ? { kind: "creator_review" } : { kind: "decide_translation", payload: request.body }, request.key);
        return Response.json(value);
      } catch (error) {
        if (error instanceof BffResponseError && error.status === 409) return new Response(null, { status: 409 });
        throw error;
      }
    };
  }

  private async send(action: string, payload: Record<string, unknown>, key: string): Promise<Record<string, unknown>> {
    requireValue(!this.signal.aborted && /^[A-Za-z0-9._:-]{8,255}$/u.test(key));
    const nonce = crypto.randomUUID();
    const response = await this.request(`/service/v1/agent/scribe/${action}`, {
      ...payload, binding_ref: this.scope.bindingRef, workspace_id: this.scope.workspaceId, request_nonce: nonce,
    }, key, this.signal);
    requireValue(!this.signal.aborted);
    if (response.status !== 200) {
      if (action === "capture-admissions" && response.status === 409
        && response.headers.get("content-type")?.split(";", 1)[0] === "application/json") {
        const failure: unknown = await readBoundedJson(response, 1024);
        requireValue(!this.signal.aborted);
        if (record(failure) && Object.keys(failure).length === 1 && failure.detail === "provider_consent_required") {
          throw new BffResponseError(409, "core_capture_consent_required", null);
        }
      }
      throw new BffResponseError(response.status, "core_capture_unconfirmed", null);
    }
    requireValue(response.headers.get("content-type")?.split(";", 1)[0] === "application/json");
    const value: unknown = await readBoundedJson(response, 8 * 1024 * 1024);
    requireValue(!this.signal.aborted && record(value) && value.contract_version === "1"
      && value.binding_ref === this.scope.bindingRef && value.workspace_id === this.scope.workspaceId
      && value.request_nonce === nonce && typeof value.checked_at === "string"
      && Number.isFinite(Date.parse(value.checked_at)));
    return value;
  }
}

/** Reuses the recorder/queue protocol after Core's configured admission. */
export class CoreCaptureBff implements Bff.CaptureBff {
  constructor(private readonly client: CoreCaptureClient, private readonly sessionId: string) {}
  private async send<T>(operation: CoreOperation, id = this.sessionId, options?: Bff.MutationOptions | Bff.RequestOptions): Promise<T> {
    requireValue(id === this.sessionId && !options?.signal?.aborted);
    const result = await this.client.operation(id, operation,
      options && "idempotencyKey" in options ? options.idempotencyKey : undefined);
    requireValue(!options?.signal?.aborted);
    return result as T;
  }
  getAudioEncryptionKey(options?: Bff.RequestOptions) {
    return this.send<Bff.AudioEncryptionPublicKey>({ kind: "encryption_key" }, this.sessionId, options);
  }
  createConsent(): Promise<Bff.ConsentRecord> { return Promise.reject(new BffResponseError(409, "core_admission_required", null)); }
  createSession(): Promise<Bff.CaptureSession> { return Promise.reject(new BffResponseError(409, "core_admission_required", null)); }
  bindSessionAudioKey(id: string, payload: Bff.SessionAudioKeyCreate, options: Bff.MutationOptions) {
    return this.send<Bff.SessionAudioKeyReceipt>({ kind: "bind_key", payload }, id, options);
  }
  getCapabilities(id: string, options?: Bff.RequestOptions) {
    return this.send<Bff.CaptureCapabilities>({ kind: "capabilities" }, id, options);
  }
  issueLease(id: string, payload: Bff.CaptureLeaseIssueRequest, options: Bff.MutationOptions) {
    return this.send<Bff.CaptureLeaseReceipt>({ kind: "issue_lease", payload }, id, options);
  }
  renewLease(id: string, leaseId: string, payload: Bff.CaptureLeaseRenewRequest, options: Bff.MutationOptions) {
    return this.send<Bff.CaptureLeaseReceipt>({ kind: "renew_lease", lease_id: leaseId, payload }, id, options);
  }
  reserveChunks(id: string, payload: Bff.ChunkReservationBatchRequest, options: Bff.MutationOptions) {
    return this.send<Bff.ChunkReservationBatchReceipt>({ kind: "reserve_chunks", payload }, id, options);
  }
  authorizeUpload(id: string, objectId: string, payload: Bff.ChunkUploadAuthorizationRequest, options: Bff.MutationOptions) {
    return this.send<Bff.ChunkUploadAuthorization>({ kind: "authorize_upload", object_id: objectId, payload }, id, options);
  }
  getChunkReceipt(id: string, objectId: string, options?: Bff.RequestOptions) {
    return this.send<Bff.ChunkReceipt>({ kind: "chunk_receipt", object_id: objectId }, id, options);
  }
  registerChunk(id: string, payload: Bff.AudioChunkRegister, options: Bff.MutationOptions) {
    return this.send<Bff.AudioChunk>({ kind: "register_chunk", payload }, id, options);
  }
  completeCapture(id: string, payload: Bff.CaptureCompleteRequest, options: Bff.MutationOptions) {
    return this.send<Bff.CaptureSession>({ kind: "complete", payload }, id, options);
  }
  getTranscriptionStatus(): Promise<Bff.CaptureTranscriptionStatus> { return Promise.reject(new BffResponseError(409, "creator_review_required", null)); }
  getTranscript(): Promise<Bff.Transcript> { return Promise.reject(new BffResponseError(409, "creator_review_required", null)); }
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function reference(value: unknown, prefix: string): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}_[0-7][0-9a-hjkmnp-tv-z]{25}$`, "u").test(value);
}
export function requireValue(value: unknown): asserts value { if (!value) invalid(); }
function invalid(): never { throw new BffResponseError(503, "core_capture_receipt_invalid", null); }
