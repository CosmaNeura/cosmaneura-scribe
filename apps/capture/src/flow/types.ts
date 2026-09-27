import type {
  CaptureLeaseIssueRequest,
  CaptureLeaseReceipt,
  ChunkReservationBatchRequest,
  ConsentCreate,
  SessionCreate,
} from "../bff/contracts";

export const FLOW_RECORD_SCHEMA_VERSION = 2 as const;
/** Non-microphone records fail closed in older microphone-only clients. */
export const CHANNEL_FLOW_RECORD_SCHEMA_VERSION = 3 as const;
/** A continued recording must never be opened by a one-interval writer. */
export const CONTINUATION_FLOW_RECORD_SCHEMA_VERSION = 4 as const;
/** Continuous renewal cannot be interpreted by an older paused-resume writer. */
export const CONTINUOUS_FLOW_RECORD_SCHEMA_VERSION = 5 as const;

export interface CaptureContinuation {
  readonly continuous?: true;
  readonly prepared: boolean;
  readonly firstSequenceNumber: number;
  readonly reservationCount: number;
  readonly previousLease: CaptureLeaseReceipt;
  readonly renewIdempotencyKey: string;
}

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
  readonly schemaVersion: typeof FLOW_RECORD_SCHEMA_VERSION | typeof CHANNEL_FLOW_RECORD_SCHEMA_VERSION
    | typeof CONTINUATION_FLOW_RECORD_SCHEMA_VERSION | typeof CONTINUOUS_FLOW_RECORD_SCHEMA_VERSION;
  readonly continuation?: CaptureContinuation;
  readonly channel?: ChunkReservationBatchRequest["channel"];
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
  /** Configured Core sessions use creator review, never the legacy transcript API. */
  readonly reviewAfterUpload?: true;
}

export interface DirectCapturePreparationState {
  readonly mode?: "direct";
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

export interface ConfiguredCapturePreparationState {
  readonly mode: "configured_core";
  readonly schemaVersion: typeof FLOW_RECORD_SCHEMA_VERSION | typeof CHANNEL_FLOW_RECORD_SCHEMA_VERSION;
  readonly channel?: ChunkReservationBatchRequest["channel"];
  readonly startedAt: string;
  readonly completeIdempotencyKey: string;
  readonly sessionId: string;
  readonly leaseIdempotencyKey: string | null;
  readonly leaseRequest: CaptureLeaseIssueRequest | null;
}

export type CapturePreparationState = DirectCapturePreparationState | ConfiguredCapturePreparationState;

export interface CaptureFlowStore {
  putPreparationState(state: CapturePreparationState): Promise<void>;
  getPreparationState(): Promise<CapturePreparationState | null>;
  putActiveCaptureState(state: ActiveCaptureState): Promise<void>;
  getActiveCaptureState(): Promise<ActiveCaptureState | null>;
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
