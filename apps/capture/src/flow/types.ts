import type {
  CaptureLeaseIssueRequest,
  CaptureLeaseReceipt,
  ChunkReservationBatchRequest,
  ConsentCreate,
  SessionCreate,
} from "../bff/contracts";

export const FLOW_RECORD_SCHEMA_VERSION = 2 as const;
export const CAPTURE_RECOVERY_SCHEMA_VERSION = 1 as const;

export type ActiveCapturePhase =
  | "ready"
  | "recording"
  | "paused"
  | "uploading"
  | "completing"
  | "processing";

export type CaptureFlowState =
  | "idle"
  | "preparing"
  | "ready"
  | "recording"
  | "paused"
  | "uploading"
  | "processing"
  | "complete"
  | "error";

export type CaptureRecoveryPhase =
  | "ready"
  | "recording"
  | "interruption_closing"
  | "ack_required"
  | "authority_required"
  | "stopped";

export type CaptureGapReasonCode =
  | "audio_context_suspended"
  | "audio_device_disconnected"
  | "audio_route_changed"
  | "audio_session_interrupted"
  | "capture_backgrounded"
  | "capture_source_stalled"
  | "capture_source_failed"
  | "capture_authority_expired"
  | "process_recovery_unknown";

export interface CaptureSegmentV1 {
  readonly segmentId: string;
  /** Stable candidate used if this physical recording run terminates with a gap. */
  readonly recoveryGapId: string;
  readonly ordinal: number;
  readonly firstSequenceNumber: number;
  readonly lastSequenceNumber: number | null;
  readonly state: "recording" | "stopped" | "interrupted" | "uncertain";
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly leaseGeneration: number;
  readonly captureAuthorizedUntil: string;
}

export interface CaptureGapAcknowledgementV1 {
  readonly decision: "continue_with_known_gap";
  readonly acknowledgedAt: string;
  readonly idempotencyKey: string;
}

export interface CaptureGapV1 {
  readonly gapId: string;
  readonly precedingSegmentId: string;
  /** Reserved for a later receiver-backed resume packet. A2a never populates it. */
  readonly followingSegmentId: null;
  readonly reasonCode: CaptureGapReasonCode;
  readonly observedAt: string;
  readonly lastCommittedSequenceNumber: number | null;
  readonly acknowledgement: CaptureGapAcknowledgementV1 | null;
  readonly reviewState: "required";
}

/**
 * Local, metadata-only recovery evidence. It is not capture authority and it
 * deliberately contains no actor, practice, patient, consent, token, or AAD.
 */
export interface CaptureRecoveryStateV1 {
  readonly schemaVersion: typeof CAPTURE_RECOVERY_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly localRevision: number;
  readonly phase: CaptureRecoveryPhase;
  readonly nextSegmentOrdinal: number;
  readonly nextSequenceNumber: number;
  readonly currentSegmentId: string | null;
  readonly segments: readonly CaptureSegmentV1[];
  readonly gaps: readonly CaptureGapV1[];
  readonly noteReadiness: "eligible" | "review_required";
}

export interface ReservationIntent {
  readonly schemaVersion: typeof FLOW_RECORD_SCHEMA_VERSION;
  readonly intentId: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly request: ChunkReservationBatchRequest;
  readonly createdAt: string;
}

export interface SessionKeyBindingState {
  readonly schemaVersion: typeof FLOW_RECORD_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly keyVersion: string;
  readonly wrappedDek: string;
  readonly idempotencyKey: string;
  readonly state: "pending" | "bound";
}

export interface PreparedCaptureSession {
  readonly sessionId: string;
  readonly lease: CaptureLeaseReceipt;
}

export interface ActiveCaptureState {
  readonly schemaVersion: typeof FLOW_RECORD_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly lease: CaptureLeaseReceipt;
  /** Exact server receipt value. Null only while the first reservation mutation is pending. */
  readonly captureAuthorizedUntil: string | null;
  /** Initial aggregate plaintext budget from the capability bootstrap. */
  readonly aggregatePlaintextBudgetBytes: number;
  readonly phase: ActiveCapturePhase;
  readonly completeIdempotencyKey: string;
  readonly recordedChunks: number;
  readonly recordedPlaintextBytes: number;
  readonly startedAt: string;
}

export interface CapturePreparationState {
  readonly schemaVersion: typeof FLOW_RECORD_SCHEMA_VERSION;
  readonly startedAt: string;
  readonly consentIdempotencyKey: string;
  readonly completeIdempotencyKey: string;
  readonly consentRequest: ConsentCreate;
  readonly consentId: string | null;
  readonly sessionIdempotencyKey: string | null;
  readonly sessionRequest: SessionCreate | null;
  readonly sessionId: string | null;
  readonly leaseIdempotencyKey: string | null;
  readonly leaseRequest: CaptureLeaseIssueRequest | null;
}

export interface CaptureFlowStore {
  putPreparationState(state: CapturePreparationState): Promise<void>;
  getPreparationState(): Promise<CapturePreparationState | null>;
  putActiveCaptureState(state: ActiveCaptureState): Promise<void>;
  getActiveCaptureState(): Promise<ActiveCaptureState | null>;
  putCaptureRecoveryState(state: CaptureRecoveryStateV1): Promise<void>;
  getCaptureRecoveryState(sessionId: string): Promise<CaptureRecoveryStateV1 | null>;
  clearCompletedCapture(sessionId: string): Promise<void>;
  putReservationIntent(intent: ReservationIntent): Promise<void>;
  listReservationIntents(): Promise<readonly ReservationIntent[]>;
  deleteReservationIntent(intentId: string): Promise<void>;
  putSessionKeyCandidate(state: SessionKeyBindingState, key: CryptoKey): Promise<void>;
  replacePendingSessionKeyCandidate(
    state: SessionKeyBindingState,
    key: CryptoKey,
  ): Promise<void>;
  getSessionKeyState(sessionId: string): Promise<SessionKeyBindingState | null>;
  getSessionKey(sessionId: string): Promise<CryptoKey | null>;
  markSessionKeyBound(sessionId: string): Promise<void>;
}
