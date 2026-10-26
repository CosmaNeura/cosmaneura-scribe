import type { NativeRecordingCommand } from "./native-recorder";
import type { MicrophoneInput } from "../native/microphone-input";
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type ProviderAction = "catalog" | "encounters" | "mount" | "recorder" | "recorder-context" | "capture-admissions" | "capture-operations" | "capture-notes" | "note-opening";
export type ProviderSessionPhase = "disabled" | "loading" | "signedOut" | "signingIn" | "ready" | "signOutPending" | "unavailable";
export interface ProviderSessionState {
  readonly phase: ProviderSessionPhase; readonly revision: string;
  /** Optional ready-account correlation metadata; never an authorization grant. */
  readonly accountIdentitySHA256?: string;
  readonly providerDisplayName?: string;
  readonly recordingSignInPreparationVersion?: 1;
}
export interface NativeProviderSession {
  getState(): Promise<ProviderSessionState>;
  signIn(): Promise<ProviderSessionState>;
  signOut(): Promise<ProviderSessionState>;
  addListener(event: "authStateChanged", listener: (state: ProviderSessionState) => void): Promise<PluginListenerHandle>;
}
export interface NativeProviderState {
  readonly phase: string; readonly revision: string; readonly providerReady?: boolean; readonly nativeRecordingVersion?: number; readonly nativePassagePlaybackVersion?: number;
  readonly providerDisplayName?: string;
  readonly recordingSignInPreparationVersion?: 1;
}
export interface ProviderNativePlugin {
  playProviderPassage?(request: { requestId: string; revision: string; workspaceId: string; bindingRef: string; sessionId: string; segmentId: string }): Promise<unknown>;
  readProviderPassage?(request: { requestId: string; revision: string }): Promise<unknown>;
  stopProviderPassage?(request: { requestId: string }): Promise<void>;
  /** Numeric renderer duration only; never start intent, authorization or content. */
  recordProviderReadyTiming?(request: { revision: string; durationMs: number }): Promise<void>;
  /** Optional current-mount auth work only; no consent, session or source grant. */
  prepareProviderSignIn?(request: { preparationId: string; revision: string; workspaceId: string; bindingRef: string }): Promise<{ revision: string }>;
  abandonProviderSignIn?(request: { preparationId: string }): Promise<void>;
  /** Read-only metadata; never starts or admits a recording. */
  getProviderActiveRecording?(request: { revision: string }): Promise<unknown>;
  openProviderRecording?(request: { requestId: string; revision: string; workspaceId: string; bindingRef: string; sessionId: string; authorizationId?: string }): Promise<unknown>;
  providerRecordingCommand?(request: { requestId: string; revision: string; recorderId: string; kind: NativeRecordingCommand; input?: MicrophoneInput; inputId?: string }): Promise<unknown>;
  prepareProviderSource(request: { revision: string; workspaceId: string; bindingRef: string;
    sessionId: string; leaseId: string; leaseReceiptId: string; leaseGeneration: number;
    captureAuthorizedUntil: string; firstSequenceNumber?: number }): Promise<{ revision: string; sessionId: string }>;
  closeProviderSource(request: { sessionId: string }): Promise<void>;
  getProviderState(): Promise<NativeProviderState>;
  addListener(event: "authStateChanged", listener: (state: NativeProviderState) => void): Promise<PluginListenerHandle>;
  providerRequest(request: { requestId: string; revision: string; action: ProviderAction; key: string; body: string }): Promise<{
    readonly requestId: string; readonly revision: string; readonly status: number; readonly body: string;
  }>;
  cancelProviderRequest(request: { requestId: string }): Promise<void>;
}

export interface StandaloneProviderNative {
  getProviderConfiguration(): Promise<{ enabled: boolean; coreOrigin: string; uploadOrigins: string[] }>;
  openProviderCore(request: { appointmentRef: string | null }): Promise<void>;
}

export interface IOSRecordingOpenPlugin {
  takeRecordingOpenRequest(): Promise<unknown>;
  addListener(event: "recordingOpen", listener: (value: unknown) => void): Promise<PluginListenerHandle>;
}

// Register once: startup and the encounter backend share the same native owner.
export const nativeProviderPlugin = registerPlugin<ProviderNativePlugin & NativeProviderSession & StandaloneProviderNative & IOSRecordingOpenPlugin>("CosmasWorkspaceAuth");
