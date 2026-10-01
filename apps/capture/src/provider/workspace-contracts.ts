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

/** Core supplies display values through its existing authorized encounter list. */
export interface ProviderEncounter {
  readonly appointmentRef: string; readonly title: string; readonly detail: string;
  readonly patientRef?: string;
  readonly patientName?: string;
  readonly dateOfBirth?: string | null;
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
  readonly signal: AbortSignal;
  readonly journal: ProviderWorkspaceJournal;
  readonly reviewJournal: (sessionId: string) => CreatorReviewJournal;
  readonly editJournal?: (sessionId: string) => CreatorEditJournal;
  /** Reauthorize and acquire the existing exclusive, creator-scoped recorder. */
  readonly recorder: (sessionId: string, signal: AbortSignal) => Promise<R>;
  readonly openInCore: (noteRef: string | null) => Promise<void>;
}
export interface ProviderWorkspaceHost<R = ProviderRecorderResources | PreparedProviderRecorder> {
  /** Ephemeral name from the current native authenticated profile, not an identity. */
  readonly providerDisplayName?: string | undefined;
  readonly encounterSetup?: ProviderEncounterSetup | undefined;
  readonly account?: ProviderAccount | undefined;
  readonly signal: AbortSignal;
  readonly listEncounters: (signal: AbortSignal) => Promise<readonly ProviderEncounter[]>;
  /** Uses Core's existing encounter/mount authorization, never a browser actor claim. */
  readonly openEncounter: (appointmentRef: string, signal: AbortSignal) => Promise<AuthorizedProviderEncounter<R>>;
  readonly createEncounter: (signal: AbortSignal) => Promise<void>;
}
