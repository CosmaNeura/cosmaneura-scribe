import type { AudioEncryptionPublicKey, CaptureCapabilities, RequestOptions } from "../../capture/src/bff/contracts";
import { CoreCaptureBff, type CoreCaptureClient } from "../../capture/src/provider/core-client";
import { parseCreatorReview, type CreatorReviewView } from "../../review-ui/src/creator-review-api";

/** One recorder's first preparation only; never an authorization or cross-request cache. */
export class DesktopPreparationBff extends CoreCaptureBff {
  private publicKey: AudioEncryptionPublicKey | null = null;
  private capabilities: CaptureCapabilities | null = null;
  private begun = false;
  private admissionMetadata: unknown;

  constructor(private readonly preparationClient: CoreCaptureClient, private readonly admittedSession: string,
    admissionMetadata?: unknown) {
    super(preparationClient, admittedSession);
    this.admissionMetadata = admissionMetadata;
    preparationClient.signal.addEventListener("abort", () => this.clear(), { once: true });
  }

  async authorizePreparation(fresh: boolean): Promise<{ sessionId: string; status: CreatorReviewView["status"] }> {
    this.current();
    if (this.begun) throw new Error("Desktop preparation has already been checked.");
    this.begun = true;
    const admissionMetadata = this.admissionMetadata; this.admissionMetadata = undefined;
    const review = async () => parseCreatorReview(
      await this.preparationClient.operation(this.admittedSession, { kind: "creator_review" }), this.admittedSession);
    if (!fresh) {
      const view = await review(); this.current();
      return { sessionId: view.session_id, status: view.status };
    }
    // The receiver-first Core sequence preserves each original read's complete
    // authorization and consent checks. It shares only request setup/client
    // connections, and grants no audio permission. No partial result is retained.
    const result = admissionMetadata ?? await this.preparationClient.operation(this.admittedSession, { kind: "preparation_metadata" });
    this.current();
    if (!record(result) || Object.keys(result).sort().join(",") !== "capabilities,encryption_key,review,schema_version"
      || result.schema_version !== "1.0") throw new Error("Desktop preparation metadata is unavailable.");
    const view = parseCreatorReview(result.review, this.admittedSession);
    const key = result.encryption_key, capabilities = result.capabilities;
    if (!record(key) || Object.keys(key).sort().join(",") !== "algorithm,key_version,public_jwk"
      || key.algorithm !== "RSA-OAEP-256" || typeof key.key_version !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(key.key_version)
      || !record(key.public_jwk) || Object.keys(key.public_jwk).sort().join(",") !== "alg,e,ext,key_ops,kty,n"
      || key.public_jwk.kty !== "RSA" || key.public_jwk.alg !== "RSA-OAEP-256" || key.public_jwk.ext !== true
      || typeof key.public_jwk.n !== "string" || !/^[A-Za-z0-9_-]{512}$/.test(key.public_jwk.n)
      || typeof key.public_jwk.e !== "string" || !/^[A-Za-z0-9_-]{1,16}$/.test(key.public_jwk.e)
      || !Array.isArray(key.public_jwk.key_ops) || key.public_jwk.key_ops.join(",") !== "wrapKey"
      || !validCapabilities(capabilities)) throw new Error("Desktop preparation metadata is unavailable.");
    if (view.status === "created") {
      this.publicKey = key as AudioEncryptionPublicKey; this.capabilities = capabilities;
    }
    return { sessionId: view.session_id, status: view.status };
  }

  override async getAudioEncryptionKey(options?: RequestOptions): Promise<AudioEncryptionPublicKey> {
    this.current(options);
    const key = this.publicKey; this.publicKey = null;
    return key === null ? super.getAudioEncryptionKey(options) : key;
  }

  override async getCapabilities(id: string, options?: RequestOptions): Promise<CaptureCapabilities> {
    this.current(options);
    if (id !== this.admittedSession) throw new Error("Desktop preparation session changed.");
    const capabilities = this.capabilities; this.capabilities = null;
    return capabilities === null ? super.getCapabilities(id, options) : capabilities;
  }

  private current(options?: RequestOptions): void {
    if (this.preparationClient.signal.aborted || options?.signal?.aborted) {
      this.clear(); throw new Error("Desktop preparation is unavailable.");
    }
  }

  private clear(): void { this.publicKey = null; this.capabilities = null; this.admissionMetadata = undefined; }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCapabilities(value: unknown): value is CaptureCapabilities {
  if (!record(value) || Object.keys(value).sort().join(",") !==
    "capture_lease_ttl_seconds,max_chunks,max_envelope_bytes,max_reservations_per_batch,media,protocol_version,remaining_aggregate_plaintext_bytes,reservation_window_seconds,target_chunk_duration_ms,upload_concurrency"
    || value.protocol_version !== "1.0" || !record(value.media)
    || Object.keys(value.media).sort().join(",") !== "channels,encoding,media_type,sample_rate_hz"
    || value.media.media_type !== "audio/wav" || value.media.encoding !== "pcm_s16le"
    || value.media.channels !== 1 || value.media.sample_rate_hz !== 16000) return false;
  return ["capture_lease_ttl_seconds", "max_chunks", "max_envelope_bytes", "max_reservations_per_batch",
    "reservation_window_seconds", "target_chunk_duration_ms", "upload_concurrency"].every(name =>
    typeof value[name] === "number" && Number.isSafeInteger(value[name]) && value[name] > 0)
    && typeof value.remaining_aggregate_plaintext_bytes === "number"
    && Number.isSafeInteger(value.remaining_aggregate_plaintext_bytes) && value.remaining_aggregate_plaintext_bytes >= 0;
}
