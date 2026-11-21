import { Capacitor } from "@capacitor/core";
import { SecureQueue } from "@cosmaneura-scribe/capacitor-secure-queue";
import { isUuid } from "../../../review-ui/src/contracts";
import { mountProviderApplication } from "./application";
import { createProviderIOSHost, type ProviderIOSBackend } from "./ios-host";
import { connectNativeProviderIOSBackend, type NativeProviderOptions } from "./native-backend";
import { nativeProviderPlugin as native } from "./native-plugin";
import { subscribeIOSRecordingOpen } from "./recording-open";
import type { ConsentPreparationRelease } from "./consent-preparation";
import { nativeScribeCancellation } from "./native-cancellation";
import { activateNativeScribe } from "./native-activation";
import { clinicalStoresFromKeys, purgeLocalClinicalData } from "./purge-local-clinical";
import { nativeAccountSelfDeleteAdapter } from "./account-self-delete-host";

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
  /** Core recoveryScope for the signed-in account; required for per-account SecureQueue wipe. */
  let clinicalAccountId: string | undefined;
  const resetClinicalAccountId = (): void => {
    clinicalAccountId = undefined;
  };
  const rememberClinicalAccount = async (accountId: string): Promise<void> => {
    if (!isUuid(accountId)) return;
    clinicalAccountId = accountId.toLowerCase();
    const state = await native.getState().catch(() => null);
    const identity = state?.accountIdentitySHA256;
    // H7: best-effort; missing identity refuses remember (null never matches).
    if (typeof identity !== "string") return;
    try {
      await SecureQueue.rememberAccount({
        accountId: clinicalAccountId,
        accountIdentitySHA256: identity,
      });
    } catch {
      // Best-effort on connect/openEncounter — do not block the encounter mount.
    }
  };
  /** H2: resolve recoveryScope at delete from session/Core or exact-identity remember — not a stale closure alone. */
  const resolveClinicalAccountId = async (): Promise<string> => {
    if (clinicalAccountId && isUuid(clinicalAccountId)) return clinicalAccountId.toLowerCase();
    const state = await native.getState().catch(() => null);
    const identity = typeof state?.accountIdentitySHA256 === "string" ? state.accountIdentitySHA256 : undefined;
    const remembered = await SecureQueue.rememberedAccount(
      identity ? { accountIdentitySHA256: identity } : undefined,
    );
    if (typeof remembered.accountId === "string" && isUuid(remembered.accountId)
      && identity && remembered.accountIdentitySHA256 === identity) {
      clinicalAccountId = remembered.accountId.toLowerCase();
      return clinicalAccountId;
    }
    // No resolvable scope must not leave clinical data — fail closed.
    throw new Error("clinical_account_unavailable");
  };
  return mountProviderApplication(root, {
    session: native,
    cancellation: nativeScribeCancellation(native),
    purgeLocalClinicalData: async () => {
      const accountId = await resolveClinicalAccountId();
      await purgeLocalClinicalData(clinicalStoresFromKeys({
        accountId,
        list: async () => (await SecureQueue.list()).keys,
        delete: async key => { await SecureQueue.delete({ key }); },
        // H8: verify remaining keys for this account after wipeAccount (0 = empty).
        clearAll: async () => {
          const result = await SecureQueue.wipeAccount({ accountId });
          return result.remaining ?? result.cleared;
        },
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
        deleteAccount: (request, signal) => nativeAccountSelfDeleteAdapter(req => native.deleteAccount!(req), request, signal),
      },
    } : {}),
    connect: async signal => {
      const backend = await connectNativeProviderIOSBackend({ ...options, signal }, native);
      try {
        // H7: best-effort migrate/remember; H4: never claim legacy.
        try { await SecureQueue.migrateAccounts(); } catch { /* best-effort */ }
        resetClinicalAccountId();
        const state = await native.getState().catch(() => null);
        const identity = typeof state?.accountIdentitySHA256 === "string" ? state.accountIdentitySHA256 : undefined;
        if (identity) {
          try {
            const remembered = await SecureQueue.rememberedAccount({ accountIdentitySHA256: identity });
            if (typeof remembered.accountId === "string" && isUuid(remembered.accountId)
              && remembered.accountIdentitySHA256 === identity) {
              clinicalAccountId = remembered.accountId.toLowerCase();
            }
          } catch { /* best-effort */ }
        }
        // Classify setup before mounting a workspace that could own a recorder.
        const initialCatalog = await backend.listEncounters(signal);
        // John Clemente's internal staging comparison, through 16 November.
        // Production and expired candidates retain the existing consent flow.
        const draftConsent = options.profile === "core-staging-personal-v1"
          && Date.now() < Date.parse("2026-11-17T00:00:00Z");
        const scopedBackend: ProviderIOSBackend = {
          ...backend,
          openEncounter: async (appointmentRef, openSignal) => {
            const mount = await backend.openEncounter(appointmentRef, openSignal);
            await rememberClinicalAccount(mount.recoveryScope);
            return mount;
          },
        };
        return {
          workspace: createProviderIOSHost(scopedBackend, consentPreparation, initialCatalog, entryStartedAt, draftConsent),
          dispose: async () => {
            resetClinicalAccountId();
            await backend.dispose();
          },
        };
      }
      catch (error) { await backend.dispose(); throw error; }
    },
  });
}
