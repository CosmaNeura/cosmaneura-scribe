import { PROTOCOL_VERSION } from "@cosmaneura-scribe/capture-protocol";

import type {
  CaptureQueueTransport,
  ChunkReservation,
  RegisterChunkRequest,
  RegistrationReceipt,
  RemoteChunkReceipt,
  UploadAuthorization,
} from "../queue";
import { QueueTransportError } from "../queue";
import type { CaptureBff, CiphertextUploadTarget } from "./contracts";
import { BffResponseError } from "./http-client";
import { UploadResponseError, UploadTargetPolicyError } from "./upload-target";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;

export class BffCaptureQueueTransport implements CaptureQueueTransport {
  public constructor(
    private readonly bff: CaptureBff,
    private readonly uploadTarget: CiphertextUploadTarget,
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
    ) {
      throw new Error("capture transport timeout is invalid");
    }
  }

  public async getReceipt(
    reservation: ChunkReservation,
  ): Promise<RemoteChunkReceipt> {
    let receipt;
    try {
      receipt = await withDeadline(this.requestTimeoutMs, (signal) =>
        this.bff.getChunkReceipt(
          reservation.sessionId,
          reservation.objectId,
          { signal },
        ),
      );
    } catch (error) {
      throw mapBffFailure(error, false);
    }
    if (!sameRemoteReservation(receipt.reservation, reservation)) {
      throw new QueueTransportError("terminal", "chunk_receipt_reservation_mismatch");
    }
    if (receipt.state === "reserved") {
      if (receipt.registration !== null && receipt.registration !== undefined) {
        throw new QueueTransportError("terminal", "chunk_receipt_state_mismatch");
      }
      return { state: "reserved" };
    }
    if (receipt.state !== "registered") {
      throw new QueueTransportError("terminal", "chunk_receipt_state_mismatch");
    }
    if (receipt.registration === null || receipt.registration === undefined) {
      throw new QueueTransportError("terminal", "chunk_receipt_state_mismatch");
    }
    return {
      state: "registered",
      registration: {
        chunkId: receipt.registration.chunk_id,
        sha256: receipt.registration.sha256.toLowerCase(),
        byteLength: receipt.registration.ciphertext_size_bytes,
        registeredAt: receipt.registration.registered_at,
      },
    };
  }

  public async authorizeUpload(
    sessionId: string,
    objectId: string,
    idempotencyKey: string,
  ): Promise<UploadAuthorization> {
    let authorization;
    try {
      authorization = await withDeadline(this.requestTimeoutMs, (signal) =>
        this.bff.authorizeUpload(
          sessionId,
          objectId,
          { protocol_version: PROTOCOL_VERSION },
          { idempotencyKey, signal },
        ),
      );
    } catch (error) {
      throw mapBffFailure(error, true);
    }
    const expiresAtEpochMs = Date.parse(authorization.expires_at);
    if (
      authorization.protocol_version !== PROTOCOL_VERSION ||
      authorization.object_id !== objectId ||
      !Number.isFinite(expiresAtEpochMs)
    ) {
      throw new QueueTransportError("terminal", "upload_authorization_response_mismatch");
    }
    return {
      objectId: authorization.object_id,
      additionalAuthenticatedData: authorization.additional_authenticated_data,
      uploadUrl: authorization.upload_url,
      expiresAtEpochMs,
    };
  }

  public async upload(uploadUrl: string, envelope: Uint8Array): Promise<void> {
    try {
      await withDeadline(this.requestTimeoutMs, (signal) =>
        this.uploadTarget.putCompleteEnvelope(uploadUrl, envelope, { signal }),
      );
    } catch (error) {
      if (error instanceof UploadTargetPolicyError) {
        throw new QueueTransportError("terminal", "upload_target_rejected");
      }
      if (error instanceof UploadResponseError) {
        if (error.status >= 200 && error.status < 300) {
          throw new QueueTransportError("unknown_success", "upload_result_unknown");
        }
        if (error.status === 401 || error.status === 403) {
          throw new QueueTransportError("credential_expired", "upload_credential_expired");
        }
        if (isRetryableStatus(error.status)) {
          throw new QueueTransportError("retryable", "upload_temporarily_unavailable", {
            ...(error.retryAfterMs === null ? {} : { retryAfterMs: error.retryAfterMs }),
          });
        }
        throw new QueueTransportError("terminal", "upload_rejected");
      }
      throw new QueueTransportError("unknown_success", "upload_result_unknown");
    }
  }

  public async register(request: RegisterChunkRequest): Promise<RegistrationReceipt> {
    let receipt;
    try {
      receipt = await withDeadline(this.requestTimeoutMs, (signal) =>
        this.bff.registerChunk(
          request.sessionId,
          {
            object_id: request.objectId,
            channel: request.channel,
            sequence_number: request.sequenceNumber,
            sha256: request.sha256,
            ciphertext_size_bytes: request.byteLength,
          },
          { idempotencyKey: request.idempotencyKey, signal },
        ),
      );
    } catch (error) {
      throw mapBffFailure(error, true);
    }
    if (
      receipt.session_id !== request.sessionId ||
      receipt.object_id !== request.objectId ||
      receipt.channel !== request.channel ||
      receipt.sequence_number !== request.sequenceNumber ||
      receipt.sha256.toLowerCase() !== request.sha256.toLowerCase() ||
      receipt.ciphertext_size_bytes !== request.byteLength
    ) {
      throw new QueueTransportError("terminal", "registration_receipt_mismatch");
    }
    return {
      chunkId: receipt.id,
      sha256: receipt.sha256.toLowerCase(),
      byteLength: receipt.ciphertext_size_bytes,
      registeredAt: receipt.registered_at,
    };
  }
}

function sameRemoteReservation(
  remote: {
    readonly protocol_version: string;
    readonly object_id: string;
    readonly session_id: string;
    readonly channel: string;
    readonly sequence_number: number;
    readonly additional_authenticated_data: string;
    readonly created_at: string;
  },
  local: ChunkReservation,
): boolean {
  return (
    remote.protocol_version === local.protocolVersion &&
    remote.object_id === local.objectId &&
    remote.session_id === local.sessionId &&
    remote.channel === local.channel &&
    remote.sequence_number === local.sequenceNumber &&
    remote.additional_authenticated_data === local.additionalAuthenticatedData &&
    remote.created_at === local.createdAt
  );
}

function mapBffFailure(error: unknown, mutation: boolean): QueueTransportError {
  if (error instanceof BffResponseError) {
    if (mutation && error.status >= 200 && error.status < 300) {
      return new QueueTransportError("unknown_success", "bff_result_unknown");
    }
    if (error.code === "upload_authorization_expired") {
      return new QueueTransportError("credential_expired", "upload_credential_expired");
    }
    if (isRetryableStatus(error.status)) {
      return new QueueTransportError("retryable", "bff_temporarily_unavailable", {
        ...(error.retryAfterMs === null ? {} : { retryAfterMs: error.retryAfterMs }),
      });
    }
    return new QueueTransportError("terminal", "bff_request_rejected");
  }
  return new QueueTransportError(
    mutation ? "unknown_success" : "retryable",
    mutation ? "bff_result_unknown" : "bff_temporarily_unavailable",
  );
}

async function withDeadline<Value>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<Value>,
): Promise<Value> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TransportDeadlineExceeded());
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      deadline,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

class TransportDeadlineExceeded extends Error {
  public constructor() {
    super("capture transport deadline exceeded");
    this.name = "TransportDeadlineExceeded";
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
