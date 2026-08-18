import type {
  CaptureLeaseIssueRequest,
  CaptureLeaseReceipt,
  ChunkReservationBatchRequest,
  ConsentCreate,
  SessionCreate,
} from "../bff/contracts";

export const FLOW_RECORD_SCHEMA_VERSION = 1 as const;

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
  readonly schemaVersion: typeof FLOW_RECORD_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly lease: CaptureLeaseReceipt;
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
