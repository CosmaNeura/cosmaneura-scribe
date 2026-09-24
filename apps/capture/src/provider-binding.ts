import type { CaptureFlowSnapshot } from "./flow";
import type { AuthorizedReviewRequest } from "../../review-ui/src/creator-review-api";
import type { CreatorReviewJournal } from "../../review-ui/src/creator-review-journal";

/** Plain recorder state/commands shared by native hosts and the provider view.
 * Desktop implementations keep the flow, keys, audio and storage in main. */
export interface ProviderRecorderSnapshot extends CaptureFlowSnapshot {
  readonly desktop?: {
    readonly phase: "ready" | "permission_required" | "starting" | "recording" | "stopping"
      | "interrupted" | "stop_unconfirmed" | "stopped";
    readonly coverage: "not_started" | "aligned" | "complete" | "incomplete";
    readonly trimmedStartMs: number;
    readonly trimmedEndMs: number | null;
  };
}
export interface ProviderRecorderController {
  readonly snapshot: ProviderRecorderSnapshot;
  subscribe(listener: (snapshot: ProviderRecorderSnapshot) => void): () => void;
  startRecording(): Promise<void>;
  stopRecording(): Promise<void>;
  refreshTranscriptionStatus(): Promise<void>;
  refreshPermissions?(): Promise<void>;
}
/** Already authorized, restored/prepared and exclusively owned by a native host. */
export interface PreparedProviderRecorder {
  readonly controller: ProviderRecorderController;
  readonly sourceKind: "microphone";
  readonly captureMode: "desktop_meeting";
  deactivate(): Promise<void>;
  resumePendingWork(): Promise<void>;
  releaseUploadedCapture(): Promise<void>;
}

/**
 * Supplied by the existing authenticated native/BFF host after encounter,
 * language, consent and captured-session admission. Never derived from a URL.
 * The host owns recorder lifetime and must stop its source on deactivation.
 * Its native recording indicator must survive view teardown until stop confirms.
 */
export interface ProviderCaptureBinding {
  readonly sessionId: string;
  readonly controller: ProviderRecorderController;
  readonly sourceKind: "synthetic" | "microphone";
  readonly captureMode?: "desktop_meeting";
  readonly languageMode: "english" | "english_spanish";
  readonly authorizedRequest: AuthorizedReviewRequest;
  readonly journal: CreatorReviewJournal;
  /** Abort on sign-out, revocation, encounter change or native host teardown. */
  readonly signal: AbortSignal;
  readonly deactivate: () => Promise<void>;
  /** Optional until the host has a qualified existing Core note entrypoint. */
  readonly continueToNote?: () => Promise<void>;
}
