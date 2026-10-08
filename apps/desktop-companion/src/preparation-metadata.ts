import type { AudioEncryptionPublicKey, CaptureCapabilities, RequestOptions } from "../../capture/src/bff/contracts";
import { CoreCaptureBff, type CoreCaptureClient } from "../../capture/src/provider/core-client";
import { parseCreatorReview, type CreatorReviewView } from "../../review-ui/src/creator-review-api";

/** One recorder's first preparation only; never an authorization or cross-request cache. */
export class DesktopPreparationBff extends CoreCaptureBff {
  private publicKey: AudioEncryptionPublicKey | null = null;
  private capabilities: CaptureCapabilities | null = null;
  private begun = false;

  constructor(private readonly preparationClient: CoreCaptureClient, private readonly admittedSession: string) {
    super(preparationClient, admittedSession);
    preparationClient.signal.addEventListener("abort", () => this.clear(), { once: true });
  }

  async authorizePreparation(fresh: boolean): Promise<{ sessionId: string; status: CreatorReviewView["status"] }> {
    this.current();
    if (this.begun) throw new Error("Desktop preparation has already been checked.");
    this.begun = true;
    const review = async () => parseCreatorReview(
      await this.preparationClient.operation(this.admittedSession, { kind: "creator_review" }), this.admittedSession);
    if (!fresh) {
      const view = await review(); this.current();
      return { sessionId: view.session_id, status: view.status };
    }
    // Every read uses its ordinary authenticated endpoint. Do not wrap/store a
    // key, bind a key, obtain a lease, discover OS windows or publish readiness
    // until the full creator/session preflight and all three reads have settled.
    const [view, key, capabilities] = await Promise.allSettled([
      review(), super.getAudioEncryptionKey(), super.getCapabilities(this.admittedSession),
    ]);
    this.current();
    if (view.status === "rejected") throw view.reason;
    if (key.status === "rejected") throw key.reason;
    if (capabilities.status === "rejected") throw capabilities.reason;
    if (view.value.status === "created") {
      this.publicKey = key.value; this.capabilities = capabilities.value;
    }
    return { sessionId: view.value.session_id, status: view.value.status };
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

  private clear(): void { this.publicKey = null; this.capabilities = null; }
}
