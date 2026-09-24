import type { CaptureFlowStore } from "../flow/types";
import type { CaptureSource } from "../capture";
import type { CaptureQueueStorage } from "../queue/types";
import type { CiphertextUploadTarget } from "../bff/contracts";
import type { PreparedProviderRecorder } from "../provider-binding";
import type { CreatorReviewJournal } from "../../../review-ui/src/creator-review-journal";
import type { AuthorizedCoreRequest, CoreCaptureScope } from "./core-client";
import type { ProviderWorkspaceJournal } from "./workspace-journal";

/** Core supplies display values through its existing authorized encounter list. */
export interface ProviderEncounter { readonly appointmentRef: string; readonly title: string; readonly detail: string }
export interface ProviderRecorderResources {
  readonly source: CaptureSource;
  readonly flowStore: CaptureFlowStore;
  readonly queueStorage: CaptureQueueStorage;
  readonly uploadTarget: CiphertextUploadTarget;
  /** Release the host's exclusive flow lock/storage handles after source stop. */
  readonly release: () => Promise<void>;
}
export interface AuthorizedProviderEncounter<R = ProviderRecorderResources | PreparedProviderRecorder> {
  readonly encounter: ProviderEncounter;
  readonly scope: CoreCaptureScope;
  readonly request: AuthorizedCoreRequest;
  readonly signal: AbortSignal;
  readonly journal: ProviderWorkspaceJournal;
  readonly reviewJournal: (sessionId: string) => CreatorReviewJournal;
  /** Reauthorize and acquire the existing exclusive, creator-scoped recorder. */
  readonly recorder: (sessionId: string, signal: AbortSignal) => Promise<R>;
  readonly openInCore: (noteRef: string | null) => Promise<void>;
}
export interface ProviderWorkspaceHost<R = ProviderRecorderResources | PreparedProviderRecorder> {
  readonly signal: AbortSignal;
  readonly listEncounters: (signal: AbortSignal) => Promise<readonly ProviderEncounter[]>;
  /** Uses Core's existing encounter/mount authorization, never a browser actor claim. */
  readonly openEncounter: (appointmentRef: string, signal: AbortSignal) => Promise<AuthorizedProviderEncounter<R>>;
  readonly createEncounter: (signal: AbortSignal) => Promise<void>;
}
