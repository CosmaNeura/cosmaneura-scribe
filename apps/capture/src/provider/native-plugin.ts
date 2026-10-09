import type { NativeRecordingCommand } from "./native-recorder";
import type { MicrophoneInput } from "../native/microphone-input";
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type ProviderAction = "catalog" | "encounters" | "mount" | "recorder" | "recorder-context" | "capture-admissions" | "capture-operations" | "capture-notes" | "note-opening";
export type ProviderSessionPhase = "disabled" | "loading" | "signedOut" | "signingIn" | "ready" | "signOutPending" | "unavailable";
export interface ProviderSessionState {
  readonly phase: ProviderSessionPhase; readonly revision: string;
  readonly providerDisplayName?: string;
}
export interface NativeProviderSession {
  getState(): Promise<ProviderSessionState>;
  signIn(): Promise<ProviderSessionState>;
  signOut(): Promise<ProviderSessionState>;
  addListener(event: "authStateChanged", listener: (state: ProviderSessionState) => void): Promise<PluginListenerHandle>;
}
export interface NativeProviderState {
  readonly phase: string; readonly revision: string; readonly providerReady?: boolean; readonly nativeRecordingVersion?: number;
  readonly providerDisplayName?: string;
}
export interface ProviderNativePlugin {
  openProviderRecording?(request: { requestId: string; revision: string; workspaceId: string; bindingRef: string; sessionId: string; authorizationId?: string }): Promise<unknown>;
  providerRecordingCommand?(request: { requestId: string; revision: string; recorderId: string; kind: NativeRecordingCommand; input?: MicrophoneInput }): Promise<unknown>;
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

// Register once: startup and the encounter backend share the same native owner.
export const nativeProviderPlugin = registerPlugin<ProviderNativePlugin & NativeProviderSession & StandaloneProviderNative>("CosmasWorkspaceAuth");
