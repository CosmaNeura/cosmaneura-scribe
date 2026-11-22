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
import {
  clearWriteOwnerAfterBackendDispose,
  nativeAccountSelfDeleteWithRememberRetry,
} from "./account-self-delete-host";

export function mountNativeProviderIOSApplication(root: HTMLElement, options: Omit<NativeProviderOptions, "signal">,
  consentPreparation?: ConsentPreparationRelease): () => Promise<void> {
  const entryStartedAt = performance.now();
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios"
    || !["CosmasWorkspaceAuth", "IOSPCM", "SecureQueue"].every(name => Capacitor.isPluginAvailable(name))) {
    throw new Error("provider_native_application_unavailable");
  }
  let clinicalAccountId: string | undefined;
  let refreshServerScope: () => Promise<string | undefined> = () => Promise.resolve(undefined);
  const clearWriteOwnerIfMatches = async (sessionId: string | undefined): Promise<void> => {
    if (!sessionId || !isUuid(sessionId)) return;
    try {
      await SecureQueue.setActiveWriteAccount({ accountId: null, ifMatches: sessionId });
    } catch { /* best-effort after successful dispose/sign-out */ }
  };
  const rememberClinicalAccount = async (accountId: string): Promise<void> => {
    if (!isUuid(accountId)) throw new Error("clinical_account_unavailable");
    clinicalAccountId = accountId.toLowerCase();
    const state = await native.getState();
    if (state.phase !== "ready" || typeof state.accountIdentitySHA256 !== "string") {
      throw new Error("provider_session_unavailable");
    }
    await SecureQueue.rememberAccount({
      accountId: clinicalAccountId,
      accountIdentitySHA256: state.accountIdentitySHA256,
    });
    await SecureQueue.setActiveWriteAccount({ accountId: clinicalAccountId });
  };
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
        deleteAccount: (request, signal) => nativeAccountSelfDeleteWithRememberRetry({
          nativeDelete: req => native.deleteAccount!(req),
          remember: rememberClinicalAccount,
          serverScope: () => refreshServerScope(),
          request, signal,
        }),
      },
    } : {}),
    connect: async signal => {
      const backend = await connectNativeProviderIOSBackend({ ...options, signal }, native);
      try {
        try { await SecureQueue.migrateAccounts(); } catch { /* best-effort */ }
        clinicalAccountId = undefined;
        const state = await native.getState().catch(() => null);
        if (state?.phase === "ready" && typeof state.accountIdentitySHA256 !== "string") {
          throw new Error("provider_session_unavailable");
        }
        const identity = typeof state?.accountIdentitySHA256 === "string" ? state.accountIdentitySHA256 : undefined;
        if (identity) {
          const remembered = await SecureQueue.rememberedAccount({ accountIdentitySHA256: identity });
          if (typeof remembered.accountId === "string" && isUuid(remembered.accountId)
            && remembered.accountIdentitySHA256 === identity) {
            await rememberClinicalAccount(remembered.accountId);
          }
        }
        const initialCatalog = await backend.listEncounters(signal);
        const catalogScope = backend.recoveryScope;
        if (catalogScope && isUuid(catalogScope) && clinicalAccountId !== catalogScope.toLowerCase()) {
          await rememberClinicalAccount(catalogScope);
        }
        if (!clinicalAccountId) {
          try { await SecureQueue.setActiveWriteAccount({ accountId: null }); } catch { /* best-effort */ }
        }
        refreshServerScope = async () => {
          try {
            await backend.listEncounters(AbortSignal.timeout(30_000));
            return backend.recoveryScope;
          } catch { return undefined; }
        };
        const draftConsent = options.profile === "core-staging-personal-v1"
          && Date.now() < Date.parse("2026-11-17T00:00:00Z");
        const sessionId = clinicalAccountId;
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
            await clearWriteOwnerAfterBackendDispose(
              () => backend.dispose(),
              () => clearWriteOwnerIfMatches(sessionId),
            );
            clinicalAccountId = undefined;
            refreshServerScope = () => Promise.resolve(undefined);
          },
        };
      }
      catch (error) { await backend.dispose(); throw error; }
    },
  });
}
