import { Capacitor } from "@capacitor/core";
import { SecureQueue } from "@cosmaneura-scribe/capacitor-secure-queue";
import { mountProviderApplication } from "./application";
import { createProviderIOSHost } from "./ios-host";
import { connectNativeProviderIOSBackend, type NativeProviderOptions } from "./native-backend";
import { nativeProviderPlugin as native } from "./native-plugin";
import { subscribeIOSRecordingOpen } from "./recording-open";
import type { ConsentPreparationRelease } from "./consent-preparation";
import { nativeScribeCancellation } from "./native-cancellation";
import { activateNativeScribe } from "./native-activation";
import { interpretAccountSelfDeleteBridge, type AccountSelfDeleteResult } from "./account-self-delete";
import { clinicalStoresFromKeys, purgeLocalClinicalData } from "./purge-local-clinical";

/** Standalone iOS startup after the host's upload/Core configuration is supplied.
 * Reuses the registered native sign-in/out UI and existing complete provider
 * workflow. Does not configure a bundle identity or enable an absent receiver.
 */
export function mountNativeProviderIOSApplication(root: HTMLElement, options: Omit<NativeProviderOptions, "signal">,
  consentPreparation?: ConsentPreparationRelease): () => Promise<void> {
  const entryStartedAt = performance.now();
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios"
    || !["CosmasWorkspaceAuth", "IOSPCM", "SecureQueue"].every(name => Capacitor.isPluginAvailable(name))) {
    throw new Error("provider_native_application_unavailable");
  }
  return mountProviderApplication(root, {
    session: native,
    cancellation: nativeScribeCancellation(native),
    purgeLocalClinicalData: async () => {
      await purgeLocalClinicalData(clinicalStoresFromKeys({
        list: async () => (await SecureQueue.list()).keys,
        delete: async key => { await SecureQueue.delete({ key }); },
        clearAll: async () => { await SecureQueue.clearAll(); },
      }));
    },
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
    ...(typeof native.deleteAccount === "function" ? {
      accountSelfDelete: {
        deleteAccount: async (request: { confirm: "DELETE" }, signal?: AbortSignal): Promise<AccountSelfDeleteResult> => {
          if (request.confirm !== "DELETE") throw new Error("account_self_delete_unconfirmed");
          if (signal?.aborted) throw new Error("account_self_delete_aborted");
          // Once Cosmas DELETE is sent, always return the result — even if the
          // dialog aborted afterwards (signedOut during in-flight DELETE).
          const value = await native.deleteAccount!({ confirm: "DELETE" });
          return interpretAccountSelfDeleteBridge(value);
        },
      },
    } : {}),
    connect: async signal => {
      const backend = await connectNativeProviderIOSBackend({ ...options, signal }, native);
      try {
        // Classify setup before mounting a workspace that could own a recorder.
        const initialCatalog = await backend.listEncounters(signal);
        // John Clemente's internal staging comparison, through 16 November.
        // Production and expired candidates retain the existing consent flow.
        const draftConsent = options.profile === "core-staging-personal-v1"
          && Date.now() < Date.parse("2026-11-17T00:00:00Z");
        return { workspace: createProviderIOSHost(backend, consentPreparation, initialCatalog, entryStartedAt, draftConsent), dispose: () => backend.dispose() };
      }
      catch (error) { await backend.dispose(); throw error; }
    },
  });
}
