import type { CaptureFlowStore } from "../flow/types";
import type { CaptureStorageCapacity } from "../flow/storage-capacity";
import type { CaptureSource } from "../capture";
import type { CaptureQueueStorage } from "../queue/types";
import type { CiphertextUploadTarget } from "../bff/contracts";
import type { PreparedProviderRecorder } from "../provider-binding";
import type { CreatorReviewJournal } from "../../../review-ui/src/creator-review-journal";
import type { CreatorEditJournal } from "../../../review-ui/src/creator-edit";
import type { AuthorizedCoreRequest, CoreCaptureScope } from "./core-client";
import type { ProviderWorkspaceJournal } from "./workspace-journal";
import type { ProviderOpeningReview } from "./opening-review";
import type { ProviderEncounterSetup, ProviderAccount } from "./encounter-setup";
import type { ProviderAudioPreflight } from "./audio-preflight";
import type { PatientIdentity } from "./visit-features";
import type { ProviderSignInPreparation } from "./signin-preparation";
import type { ConsentPreparationRelease } from "./consent-preparation";

/** Core supplies display values through its existing authorized encounter list. */
export interface ProviderEncounter {
  readonly appointmentRef: string; readonly title: string; readonly detail: string;
  readonly patientRef?: string;
  readonly patientName?: string;
  readonly dateOfBirth?: string | null;
  readonly identity?: PatientIdentity;
  readonly status?: "draft_ready" | "processing" | "paused" | "ready" | "recording_saved";
}
export interface ProviderRecorderResources {
  readonly source: CaptureSource;
  readonly flowStore: CaptureFlowStore;
  readonly storageCapacity: CaptureStorageCapacity;
  readonly queueStorage: CaptureQueueStorage;
  readonly uploadTarget: CiphertextUploadTarget;
  /** Release the host's exclusive flow lock/storage handles after source stop. */
  readonly release: () => Promise<void>;
}
export interface AuthorizedProviderEncounter<R = ProviderRecorderResources | PreparedProviderRecorder> {
  readonly encounter: ProviderEncounter;
  readonly scope: CoreCaptureScope;
  readonly request: AuthorizedCoreRequest;
  readonly openingReview?: ProviderOpeningReview;
  readonly noteOpeningSupported?: true;
  /** Trusted native acquisition checks current created/capturing status itself. */
  readonly recorderRechecksReview?: true;
  readonly signal: AbortSignal;
  readonly journal: ProviderWorkspaceJournal;
  /** Optional native auth preparation for this mounted setup; never an admission. */
  readonly signInPreparation?: ProviderSignInPreparation;
  readonly reviewJournal: (sessionId: string) => CreatorReviewJournal;
  readonly editJournal?: (sessionId: string) => CreatorEditJournal;
  /** Reauthorize and acquire the existing exclusive, creator-scoped recorder. */
  readonly recorder: (sessionId: string, signal: AbortSignal) => Promise<R>;
  readonly playPassage?: (sessionId: string, segmentId: string, signal: AbortSignal) => Promise<{ wavBase64: string } | null>;
  readonly openInCore: (noteRef: string | null) => Promise<void>;
}
export interface ProviderWorkspaceHost<R = ProviderRecorderResources | PreparedProviderRecorder> {
  /** Trusted, reversible beta control; omitted controls retain explicit-start preparation. */
  readonly consentPreparation?: ConsentPreparationRelease;
  /** Actual native owner mapped only against a fresh authorized encounter catalog. */
  readonly activeRecording?: (signal: AbortSignal) => Promise<{ appointmentRef: string; sessionId: string } | null>;
  readonly audioPreflight?: (signal: AbortSignal) => Promise<ProviderAudioPreflight>;
  /** Ephemeral name from the current native authenticated profile, not an identity. */
  readonly providerDisplayName?: string | undefined;
  /** Trusted recorder independently checks current review status at acquisition. */
  readonly recorderRechecksReview?: true;
  readonly encounterSetup?: ProviderEncounterSetup | undefined;
  readonly account?: ProviderAccount | undefined;
  readonly signal: AbortSignal;
  readonly listEncounters: (signal: AbortSignal) => Promise<readonly ProviderEncounter[]>;
  /** Uses Core's existing encounter/mount authorization, never a browser actor claim. */
  readonly openEncounter: (appointmentRef: string, signal: AbortSignal) => Promise<AuthorizedProviderEncounter<R>>;
  readonly createEncounter: (signal: AbortSignal) => Promise<void>;
}
