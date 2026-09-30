import type { MicrophoneInput } from "./native/microphone-input";
import type { CaptureFlowSnapshot } from "./flow";
import type { AuthorizedReviewRequest, CreatorReviewView } from "../../review-ui/src/creator-review-api";
import type { CreatorEditJournal } from "../../review-ui/src/creator-edit";
import type { CreatorReviewJournal } from "../../review-ui/src/creator-review-journal";

/** Plain recorder state/commands shared by native hosts and the provider view.
 * Desktop implementations keep the flow, keys, audio and storage in main. */
export interface DesktopInputFeedback {
  readonly microphone: { readonly level: number; readonly ageMs: number } | null;
  readonly meetingAudio: { readonly level: number; readonly ageMs: number } | null;
}
export interface ProviderRecorderSnapshot extends CaptureFlowSnapshot {
  readonly native?: { readonly phase: string; readonly busy: boolean;
    readonly uploadProgress?: { readonly total: number; readonly registered: number } };
  readonly desktop?: {
    readonly phase: "ready" | "permission_required" | "starting" | "recording" | "stopping"
      | "interrupted" | "stop_unconfirmed" | "stopped";
    readonly coverage: "not_started" | "aligned" | "complete" | "incomplete";
    readonly trimmedStartMs: number;
    readonly trimmedEndMs: number | null;
    readonly inputSignal?: DesktopInputFeedback;
  };
}
export interface ProviderRecorderController {
  readonly snapshot: ProviderRecorderSnapshot;
  subscribe(listener: (snapshot: ProviderRecorderSnapshot) => void): () => void;
  startRecording(): Promise<void>;
  stopRecording(): Promise<void>;
  pauseRecording?(): Promise<void>;
  resumeRecording?(): Promise<void>;
  refreshTranscriptionStatus(): Promise<void>;
  refreshPermissions?(): Promise<void>;
  /** Reveals the current native picker; never creates a choice or starts audio. */
  showWindowChooser?(): Promise<void>;
  selectMicrophoneInput?(input: MicrophoneInput): Promise<void>;
  readonly getCaptureSignal?: () => Promise<unknown>;
}
/** Already authorized, restored/prepared and exclusively owned by a native host. */
export interface PreparedProviderRecorder {
  readonly controller: ProviderRecorderController;
  readonly sourceKind: "microphone";
  readonly captureMode: "desktop_meeting" | "native_microphone";
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
  readonly captureMode?: "desktop_meeting" | "native_microphone";
  readonly languageMode: "english" | "english_spanish";
  /** Verified encounter context, shown only in the authenticated app surface. */
  readonly encounterLabel?: string;
  readonly visitLabel?: string;
  readonly authorizedRequest: AuthorizedReviewRequest;
  readonly journal: CreatorReviewJournal;
  readonly editJournal?: CreatorEditJournal;
  /** Abort on sign-out, revocation, encounter change or native host teardown. */
  readonly signal: AbortSignal;
  readonly deactivate: () => Promise<void>;
  /** Retries the retained upload/completion after confirmed native stop. Never records. */
  readonly resumePendingUpload?: () => Promise<void>;
  /** Optional until the host has a qualified existing Core note entrypoint. */
  readonly continueToNote?: (view: CreatorReviewView) => Promise<void>;
  readonly prepareNoteOpening?: () => Promise<{ view: CreatorReviewView; open: () => Promise<void> }>;
}
