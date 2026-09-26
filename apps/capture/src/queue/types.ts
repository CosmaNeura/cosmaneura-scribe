import type {
  CaptureChannel,
  PROTOCOL_VERSION,
} from "@cosmaneura-scribe/capture-protocol";

export const QUEUE_RECORD_SCHEMA_VERSION = 1 as const;

export type ChunkState =
  | "reserved"
  | "encrypted"
  | "uploading"
  | "uploaded"
  | "registered"
  | "purged";

export interface ChunkReservation {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly objectId: string;
  readonly sessionId: string;
  readonly channel: CaptureChannel;
  readonly sequenceNumber: number;
  readonly additionalAuthenticatedData: string;
  readonly createdAt: string;
}

export interface ChunkIdempotencyKeys {
  /** The key used for the reservation batch that produced this reservation. */
  readonly reservation: string;
  /** Stable for one authorization request; rotated only after definite expiry. */
  readonly uploadAuthorization: string;
  readonly uploadAuthorizationGeneration: number;
  /** Stable for every replay of the immutable registration body. */
  readonly registration: string;
}

export interface OperationRetryState {
  readonly attempts: number;
  readonly notBeforeEpochMs: number | null;
  /** A fixed metadata-only code. Error messages are never persisted. */
  readonly terminalCode: string | null;
}

export interface ChunkRetryState {
  readonly upload: OperationRetryState;
  readonly registration: OperationRetryState;
}

export interface RegistrationReceipt {
  readonly chunkId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly registeredAt: string;
}

interface CommonChunkRecord<State extends ChunkState> {
  readonly schemaVersion: typeof QUEUE_RECORD_SCHEMA_VERSION;
  readonly revision: number;
  readonly state: State;
  readonly reservation: ChunkReservation;
  readonly idempotencyKeys: ChunkIdempotencyKeys;
  readonly retry: ChunkRetryState;
}

export type ReservedChunkRecord = CommonChunkRecord<"reserved">;

export interface EncryptedChunkPayload {
  /** Complete, immutable capture-protocol envelope bytes. */
  readonly envelope: Uint8Array;
  /** Lowercase SHA-256 over the complete envelope. */
  readonly sha256: string;
  readonly byteLength: number;
}

export type EncryptedChunkRecord = CommonChunkRecord<"encrypted"> & EncryptedChunkPayload;
export type UploadingChunkRecord = CommonChunkRecord<"uploading"> & EncryptedChunkPayload;
export type UploadedChunkRecord = CommonChunkRecord<"uploaded"> & EncryptedChunkPayload;
export type RegisteredChunkRecord = CommonChunkRecord<"registered"> &
  EncryptedChunkPayload & {
    readonly registrationReceipt: RegistrationReceipt;
  };
export type PurgedChunkRecord = CommonChunkRecord<"purged"> & {
  readonly registrationReceipt: RegistrationReceipt;
  readonly purgedAt: string;
};

export type CaptureChunkRecord =
  | ReservedChunkRecord
  | EncryptedChunkRecord
  | UploadingChunkRecord
  | UploadedChunkRecord
  | RegisteredChunkRecord
  | PurgedChunkRecord;

/** Validated queue state without retained audio bytes. Never used for a write. */
type WithoutEnvelope<Record> = Record extends CaptureChunkRecord ? Omit<Record, "envelope"> : never;
export type CaptureChunkMetadata = WithoutEnvelope<CaptureChunkRecord>;

/**
 * Atomic record storage shared by the PWA implementation and a future native
 * secure-storage plugin. Implementations must make create/CAS indivisible.
 */
export interface CaptureQueueStorage {
  create(record: ReservedChunkRecord): Promise<boolean>;
  get(objectId: string): Promise<CaptureChunkRecord | null>;
  /** Operational enumeration must authenticate each record with bounded audio memory. */
  listMetadata(): Promise<readonly CaptureChunkMetadata[]>;
  /** Full payload enumeration for diagnostics; use listMetadata for restore/drain. */
  list(): Promise<readonly CaptureChunkRecord[]>;
  compareAndSwap(
    objectId: string,
    expectedRevision: number,
    replacement: CaptureChunkRecord,
  ): Promise<boolean>;
}

export type RemoteChunkReceipt =
  | { readonly state: "reserved" }
  | { readonly state: "registered"; readonly registration: RegistrationReceipt };

export interface UploadAuthorization {
  readonly objectId: string;
  readonly additionalAuthenticatedData: string;
  /** Ephemeral capability. Queue implementations must never persist this value. */
  readonly uploadUrl: string;
  readonly expiresAtEpochMs: number;
}

export interface RegisterChunkRequest {
  readonly sessionId: string;
  readonly objectId: string;
  readonly channel: CaptureChannel;
  readonly sequenceNumber: number;
  readonly sha256: string;
  readonly byteLength: number;
  readonly idempotencyKey: string;
}

/** Normalized BFF boundary. This module deliberately contains no HTTP client. */
export interface CaptureQueueTransport {
  getReceipt(reservation: ChunkReservation): Promise<RemoteChunkReceipt>;
  authorizeUpload(
    sessionId: string,
    objectId: string,
    idempotencyKey: string,
  ): Promise<UploadAuthorization>;
  upload(uploadUrl: string, envelope: Uint8Array): Promise<void>;
  register(request: RegisterChunkRequest): Promise<RegistrationReceipt>;
}

export type QueueOperation = "upload" | "registration";

export interface DrainItemResult {
  readonly objectId: string;
  readonly outcome: "registered" | "deferred" | "terminal" | "skipped";
  readonly code?: string;
}

export interface DrainResult {
  readonly items: readonly DrainItemResult[];
}
