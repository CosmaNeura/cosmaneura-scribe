import { Capacitor } from "@capacitor/core";
import { mountProviderApplication } from "./application";
import { createProviderIOSHost } from "./ios-host";
import { connectNativeProviderIOSBackend, type NativeProviderOptions } from "./native-backend";
import { nativeProviderPlugin as native } from "./native-plugin";
import { subscribeIOSRecordingOpen } from "./recording-open";
import type { ConsentPreparationRelease } from "./consent-preparation";
import { nativeScribeCancellation } from "./native-cancellation";
import { activateNativeScribe } from "./native-activation";

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
    cancellation: nativeScribeCancellation(native),
    activateScribe: (signal, revision) => activateNativeScribe(native, signal, revision),
    openPracticeSetup: async signal => {
      const before = await native.getState();
      if (signal.aborted || before.phase !== "ready") throw new Error("provider_session_unavailable");
      await native.openProviderCore({ destination: "onboarding" });
      const after = await native.getState();
      if (signal.aborted || after.phase !== "ready" || after.revision !== before.revision) throw new Error("provider_session_unavailable");
    },
    openDashboard: async signal => {
      const before = await native.getState();
      if (signal.aborted || before.phase !== "ready") throw new Error("provider_session_unavailable");
      await native.openProviderCore({ appointmentRef: null });
      const after = await native.getState();
      if (signal.aborted || after.phase !== "ready" || after.revision !== before.revision) throw new Error("provider_session_unavailable");
    },
    supportsRecorderStopReauthentication: true,
    recordingOpen: listener => subscribeIOSRecordingOpen(native, listener),
    connect: async signal => {
      const backend = await connectNativeProviderIOSBackend({ ...options, signal }, native);
      try {
        // Classify setup before mounting a workspace that could own a recorder.
        await backend.listEncounters(signal);
        return { workspace: createProviderIOSHost(backend, consentPreparation), dispose: () => backend.dispose() };
      }
      catch (error) { await backend.dispose(); throw error; }
    },
  });
}
