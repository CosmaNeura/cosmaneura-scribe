import type { components } from "../generated/capture-api";

export type CaptureCapabilities = components["schemas"]["CaptureCapabilities"];
export type AudioEncryptionPublicKey = components["schemas"]["AudioEncryptionPublicKey"];
export type ConsentCreate = components["schemas"]["ConsentCreate"];
export type ConsentRecord = components["schemas"]["ConsentRecord"];
export type SessionCreate = components["schemas"]["SessionCreate"];
export type SessionAudioKeyCreate = components["schemas"]["SessionAudioKeyCreate"];
export type SessionAudioKeyReceipt = components["schemas"]["SessionAudioKeyReceipt"];
export type Transcript = components["schemas"]["Transcript"];
export type CaptureLeaseIssueRequest = components["schemas"]["CaptureLeaseIssueRequest"];
export type CaptureLeaseRenewRequest = components["schemas"]["CaptureLeaseRenewRequest"];
export type CaptureLeaseReceipt = components["schemas"]["CaptureLeaseReceipt"];
export type ChunkReservationBatchRequest =
  components["schemas"]["ChunkReservationBatchRequest"];
export type ChunkReservationBatchReceipt =
  components["schemas"]["ChunkReservationBatchReceipt"];
export type ChunkUploadAuthorizationRequest =
  components["schemas"]["ChunkUploadAuthorizationRequest"];
export type ChunkUploadAuthorization = components["schemas"]["ChunkUploadAuthorization"];
export type AudioChunkRegister = components["schemas"]["AudioChunkRegister"];
export type AudioChunk = components["schemas"]["AudioChunk"];
export type ChunkReceipt = components["schemas"]["ChunkReceipt"];
export type CaptureCompleteRequest = components["schemas"]["CaptureCompleteRequest"];
export type CaptureSession = components["schemas"]["CaptureSession"];

export interface MutationOptions {
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

/** Closed Core sequence; its three original mutation identities stay stable on replay. */
export interface PrepareRecordingWindowRequest {
  readonly schema_version: "1.0";
  readonly binding: SessionAudioKeyCreate;
  readonly bind_idempotency_key: string;
  readonly lease_idempotency_key: string;
  readonly reserve_idempotency_key: string;
  readonly channel: ChunkReservationBatchRequest["channel"];
  readonly reservation_count: number;
}
export interface PreparedRecordingWindow {
  readonly schema_version: "1.0";
  readonly binding: SessionAudioKeyReceipt;
  readonly lease: CaptureLeaseReceipt;
  readonly reservations: ChunkReservationBatchReceipt;
}
/** Server chooses and durably retains the count within the current creator budget. */
export interface PrepareContinuationWindowRequest {
  readonly schema_version: "1.0";
  readonly channel: "microphone" | "mixed";
  readonly first_sequence_number: number;
  readonly previous_lease_id: string;
  readonly previous_lease_generation: number;
  readonly renew_idempotency_key: string;
  readonly reservation_idempotency_key: string;
}
export interface PreparedContinuationWindow {
  readonly schema_version: "1.0";
  readonly lease: CaptureLeaseReceipt;
  readonly reservations: ChunkReservationBatchReceipt;
}
export interface CaptureBff {
  /** Only fresh configured preparations use this optional receiver-first capability. */
  prepareRecordingWindow?(sessionId: string, request: PrepareRecordingWindowRequest,
    options: MutationOptions): Promise<PreparedRecordingWindow>;
  prepareContinuationWindow?(sessionId: string, request: PrepareContinuationWindowRequest,
    options: MutationOptions): Promise<PreparedContinuationWindow>;
  getAudioEncryptionKey(options?: RequestOptions): Promise<AudioEncryptionPublicKey>;
  createConsent(request: ConsentCreate, options: MutationOptions): Promise<ConsentRecord>;
  createSession(request: SessionCreate, options: MutationOptions): Promise<CaptureSession>;
  bindSessionAudioKey(
    sessionId: string,
    request: SessionAudioKeyCreate,
    options: MutationOptions,
  ): Promise<SessionAudioKeyReceipt>;
  getCapabilities(
    sessionId: string,
    options?: RequestOptions,
  ): Promise<CaptureCapabilities>;
  issueLease(
    sessionId: string,
    request: CaptureLeaseIssueRequest,
    options: MutationOptions,
  ): Promise<CaptureLeaseReceipt>;
  renewLease(
    sessionId: string,
    leaseId: string,
    request: CaptureLeaseRenewRequest,
    options: MutationOptions,
  ): Promise<CaptureLeaseReceipt>;
  reserveChunks(
    sessionId: string,
    request: ChunkReservationBatchRequest,
    options: MutationOptions,
  ): Promise<ChunkReservationBatchReceipt>;
  authorizeUpload(
    sessionId: string,
    objectId: string,
    request: ChunkUploadAuthorizationRequest,
    options: MutationOptions,
  ): Promise<ChunkUploadAuthorization>;
  getChunkReceipt(
    sessionId: string,
    objectId: string,
    options?: RequestOptions,
  ): Promise<ChunkReceipt>;
  registerChunk(
    sessionId: string,
    request: AudioChunkRegister,
    options: MutationOptions,
  ): Promise<AudioChunk>;
  completeCapture(
    sessionId: string,
    request: CaptureCompleteRequest,
    options: MutationOptions,
  ): Promise<CaptureSession>;
  getTranscriptionStatus(
    sessionId: string,
    options?: RequestOptions,
  ): Promise<CaptureTranscriptionStatus>;
  getTranscript(sessionId: string, options?: RequestOptions): Promise<Transcript>;
}

export interface CaptureTranscriptionStatus {
  readonly session_id: string;
  readonly status: "not_requested" | "queued" | "processing" | "completed" | "terminal";
  readonly transcript_available: boolean;
  readonly updated_at: string;
}

export interface CiphertextUploadTarget {
  putCompleteEnvelope(
    uploadUrl: string,
    envelope: Uint8Array,
    options?: RequestOptions,
  ): Promise<void>;
}
