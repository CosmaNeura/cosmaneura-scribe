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
  createAccountSelfDeleteScopeGate,
  createDeleteAwareServerScopeRefresh,
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
  const deleteScopeGate = createAccountSelfDeleteScopeGate();
  let rawRefreshServerScope: () => Promise<string | undefined> = () => Promise.resolve(undefined);
  // Single delete-aware wrapper; connect/dispose only rebind rawRefreshServerScope.
  const refreshServerScope = createDeleteAwareServerScopeRefresh({
    refresh: () => rawRefreshServerScope(),
    deleteActive: () => deleteScopeGate.active(),
  });
  const clearWriteOwnerIfMatches = async (sessionId: string | undefined): Promise<void> => {
    if (!sessionId || !isUuid(sessionId)) return;
    try {
      await SecureQueue.setActiveWriteAccount({ accountId: null, ifMatches: sessionId });
    } catch { /* best-effort after successful dispose/sign-out */ }
  };
  const writeClinicalAccount = async (accountId: string, permitted: () => boolean): Promise<void> => {
    if (!isUuid(accountId)) throw new Error("clinical_account_unavailable");
    if (!permitted()) return;
    const state = await native.getState();
    if (!permitted()) return;
    if (state.phase !== "ready" || typeof state.accountIdentitySHA256 !== "string") {
      throw new Error("provider_session_unavailable");
    }
    if (!permitted()) return;
    const id = accountId.toLowerCase();
    await SecureQueue.rememberAccount({
      accountId: id,
      accountIdentitySHA256: state.accountIdentitySHA256,
    });
    if (!permitted()) return;
    await SecureQueue.setActiveWriteAccount({ accountId: id });
    if (!permitted()) return;
    clinicalAccountId = id;
  };
  const rememberClinicalAccount = async (accountId: string): Promise<void> => {
    // In-flight/confirmed delete must not overwrite clinical scope (Fable #566 NB).
    if (deleteScopeGate.active()) return;
    await writeClinicalAccount(accountId, () => !deleteScopeGate.active());
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
        deleteAccount: async (request, signal) => {
          const prior = await native.getState().catch(() => null);
          deleteScopeGate.begin(
            typeof prior?.accountIdentitySHA256 === "string" ? prior.accountIdentitySHA256 : undefined,
          );
          try {
            const result = await nativeAccountSelfDeleteWithRememberRetry({
              nativeDelete: req => native.deleteAccount!(req),
              // Delete-time remember is allowed while in_flight; no-ops once confirmed.
              remember: async scope => {
                if (deleteScopeGate.confirmed()) return;
                await writeClinicalAccount(scope, () => !deleteScopeGate.confirmed());
              },
              // Confirmed: share the delete-aware undefined; in-flight: raw one-shot fetch.
              serverScope: async () => deleteScopeGate.confirmed()
                ? refreshServerScope()
                : rawRefreshServerScope(),
              request, signal,
            });
            if (result.outcome === "deleted" || result.outcome === "gone") deleteScopeGate.confirm();
            else deleteScopeGate.clear();
            return result;
          } catch (error) {
            deleteScopeGate.clear();
            throw error;
          }
        },
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
        // Confirmed delete belongs to the prior identity; a different native identity may remember.
        if (deleteScopeGate.confirmed() && deleteScopeGate.deletedIdentity() !== identity) {
          deleteScopeGate.reset();
        }
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
          try { await SecureQueue.setActiveWriteAccount({ accountId: null }); }
          catch (error) { throw new Error("provider_session_unavailable", { cause: error }); }
        }
        rawRefreshServerScope = async () => {
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
            rawRefreshServerScope = () => Promise.resolve(undefined);
          },
        };
      }
      catch (error) { await backend.dispose(); throw error; }
    },
  });
}
