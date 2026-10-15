import type { MicrophoneInput } from "./native/microphone-input";
import type { CaptureFlowSnapshot } from "./flow";
import type { AuthorizedReviewRequest, CreatorReviewView } from "../../review-ui/src/creator-review-api";
import type { CreatorEditJournal } from "../../review-ui/src/creator-edit";
import type { SpeakerNameSuggestions } from "../../review-ui/src/creator-edit-view";
import type { CreatorReviewJournal } from "../../review-ui/src/creator-review-journal";
import type { PrivateNoteSession } from "./provider/private-note-session";
import type { AudioInputDevice } from "./provider/audio-preflight";

/** Plain recorder state/commands shared by native hosts and the provider view.
 * Desktop implementations keep the flow, keys, audio and storage in main. */
export interface DesktopInputFeedback {
  readonly microphone: { readonly level: number; readonly ageMs: number } | null;
  readonly meetingAudio: { readonly level: number; readonly ageMs: number } | null;
}
export interface ProviderRecorderSnapshot extends CaptureFlowSnapshot {
  readonly inputDevices?: readonly AudioInputDevice[];
  readonly selectedInputId?: string | null;
  readonly reconnecting?: boolean;
  readonly native?: { readonly phase: string; readonly busy: boolean;
    readonly uploadProgress?: { readonly total: number; readonly registered: number } };
  readonly desktop?: {
    readonly phase: "preparing" | "ready" | "permission_required" | "starting" | "recording" | "stopping"
      | "interrupted" | "stop_unconfirmed" | "stopped";
    readonly coverage: "not_started" | "aligned" | "complete" | "incomplete";
    readonly trimmedStartMs: number;
    readonly trimmedEndMs: number | null;
    readonly inputSignal?: DesktopInputFeedback;
    readonly audioMode?: "microphone" | "meeting";
    readonly meetingWindows?: {
      readonly state: "ready" | "unavailable";
      readonly selectedId: string | null;
      readonly windows: readonly { readonly id: string; readonly title: string }[];
    };
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
  selectDesktopAudio?(mode: "microphone" | "meeting"): Promise<void>;
  refreshMeetingWindows?(): Promise<void>;
  selectMeetingWindow?(id: string): Promise<void>;
  selectMicrophoneInput?(input: MicrophoneInput): Promise<void>;
  selectAudioInput?(id: string): Promise<void>;
  readonly getCaptureSignal?: () => Promise<unknown>;
}
/** Admitted and exclusively owned by a native host; preparation may still be pending. */
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
  readonly privateNotes?: PrivateNoteSession | undefined;
  readonly onFinishVisit?: () => Promise<void>;
  readonly authorizedRequest: AuthorizedReviewRequest;
  readonly journal: CreatorReviewJournal;
  readonly editJournal?: CreatorEditJournal;
  readonly playPassage?: (sessionId: string, segmentId: string, signal: AbortSignal) => Promise<{ wavBase64: string } | null>;
  readonly speakerNameSuggestions?: SpeakerNameSuggestions;
  /** Abort on sign-out, revocation, encounter change or native host teardown. */
  readonly signal: AbortSignal;
  readonly deactivate: () => Promise<void>;
  /** Retries the retained upload/completion after confirmed native stop. Never records. */
  readonly resumePendingUpload?: () => Promise<void>;
  /** Optional until the host has a qualified existing Core note entrypoint. */
  readonly continueToNote?: (view: CreatorReviewView, prepareAfterFinish?: boolean) => Promise<void>;
  readonly prepareNoteOpening?: () => Promise<{ view: CreatorReviewView; open: () => Promise<void> }>;
}
