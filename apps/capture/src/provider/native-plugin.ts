import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type ProviderAction = "catalog" | "mount" | "recorder" | "capture-admissions" | "capture-operations" | "capture-notes";
export type ProviderSessionPhase = "disabled" | "loading" | "signedOut" | "signingIn" | "ready" | "signOutPending" | "unavailable";
export interface ProviderSessionState { readonly phase: ProviderSessionPhase; readonly revision: string }
export interface NativeProviderSession {
  getState(): Promise<ProviderSessionState>;
  signIn(): Promise<ProviderSessionState>;
  signOut(): Promise<ProviderSessionState>;
  addListener(event: "authStateChanged", listener: (state: ProviderSessionState) => void): Promise<PluginListenerHandle>;
}
export interface NativeProviderState { readonly phase: string; readonly revision: string; readonly providerReady?: boolean }
export interface ProviderNativePlugin {
  getProviderState(): Promise<NativeProviderState>;
  addListener(event: "authStateChanged", listener: (state: NativeProviderState) => void): Promise<PluginListenerHandle>;
  providerRequest(request: { requestId: string; revision: string; action: ProviderAction; key: string; body: string }): Promise<{
    readonly requestId: string; readonly revision: string; readonly status: number; readonly body: string;
  }>;
  cancelProviderRequest(request: { requestId: string }): Promise<void>;
}

// Register once: startup and the encounter backend share the same native owner.
export const nativeProviderPlugin = registerPlugin<ProviderNativePlugin & NativeProviderSession>("CosmasWorkspaceAuth");
