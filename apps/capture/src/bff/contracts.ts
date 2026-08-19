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

export interface CaptureBff {
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
