import { Capacitor } from "@capacitor/core";
import { mountProviderApplication } from "./application";
import { createProviderIOSHost } from "./ios-host";
import { connectNativeProviderIOSBackend, type NativeProviderOptions } from "./native-backend";
import { nativeProviderPlugin as native } from "./native-plugin";
import { subscribeIOSRecordingOpen } from "./recording-open";
import type { ConsentPreparationRelease } from "./consent-preparation";

/** Standalone iOS startup after the host's upload/Core configuration is supplied.
 * Reuses the registered native sign-in/out UI and existing complete provider
 * workflow. Does not configure a bundle identity or enable an absent receiver.
 */
export function mountNativeProviderIOSApplication(root: HTMLElement, options: Omit<NativeProviderOptions, "signal">,
  consentPreparation?: ConsentPreparationRelease): () => Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios"
    || !["CosmasWorkspaceAuth", "IOSPCM", "SecureQueue"].every(name => Capacitor.isPluginAvailable(name))) {
    throw new Error("provider_native_application_unavailable");
  }
  return mountProviderApplication(root, {
    session: native,
    supportsRecorderStopReauthentication: true,
    recordingOpen: listener => subscribeIOSRecordingOpen(native, listener),
    connect: async signal => {
      const backend = await connectNativeProviderIOSBackend({ ...options, signal }, native);
      try { return { workspace: createProviderIOSHost(backend, consentPreparation), dispose: () => backend.dispose() }; }
      catch (error) { await backend.dispose(); throw error; }
    },
  });
}
