import type { CaptureFlowController } from "./flow";
import type { AuthorizedReviewRequest } from "../../review-ui/src/creator-review-api";
import type { CreatorReviewJournal } from "../../review-ui/src/creator-review-journal";

/**
 * Supplied by the existing authenticated native/BFF host after encounter,
 * language, consent and captured-session admission. Never derived from a URL.
 * The host owns recorder lifetime and must stop its source on deactivation.
 * Its native recording indicator must survive view teardown until stop confirms.
 */
export interface ProviderCaptureBinding {
  readonly sessionId: string;
  readonly controller: CaptureFlowController;
  readonly sourceKind: "synthetic" | "microphone";
  readonly languageMode: "english" | "english_spanish";
  readonly authorizedRequest: AuthorizedReviewRequest;
  readonly journal: CreatorReviewJournal;
  /** Abort on sign-out, revocation, encounter change or native host teardown. */
  readonly signal: AbortSignal;
  readonly deactivate: () => Promise<void>;
  /** Optional until the host has a qualified existing Core note entrypoint. */
  readonly continueToNote?: () => Promise<void>;
}
