import { isUuid } from "../../../review-ui/src/contracts";
import { interpretAccountSelfDeleteBridge, type AccountSelfDeleteResult } from "./account-self-delete";
import { exact, object, jsonCopy, unavailable, type DesktopProviderRequest } from "./desktop-host-protocol";

function hasPluginCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === code;
}

export async function nativeAccountSelfDeleteAdapter(
  nativeDelete: (request: { confirm: "DELETE" }) => Promise<unknown>,
  request: { confirm: "DELETE" }, signal?: AbortSignal,
): Promise<AccountSelfDeleteResult> {
  if (request.confirm !== "DELETE") throw new Error("account_self_delete_unconfirmed");
  if (signal?.aborted) throw new Error("account_self_delete_aborted");
  return interpretAccountSelfDeleteBridge(await nativeDelete({ confirm: "DELETE" }));
}

/** Distinct from clinical_account_unavailable / …_after_remember; maps to keepSession. */
export const CLINICAL_RECOVERY_SCOPE_UNAVAILABLE = "clinical_recovery_scope_unavailable";

export async function nativeAccountSelfDeleteWithRememberRetry(options: {
  nativeDelete: (request: { confirm: "DELETE" }) => Promise<unknown>;
  remember: (scope: string) => Promise<void>;
  serverScope: () => Promise<string | undefined>;
  request: { confirm: "DELETE" };
  signal?: AbortSignal | undefined;
}): Promise<AccountSelfDeleteResult> {
  const attempt = () => nativeAccountSelfDeleteAdapter(options.nativeDelete, options.request, options.signal);
  try {
    return await attempt();
  } catch (error) {
    if (!hasPluginCode(error, "clinical_account_unavailable")) throw error;
    const scope = await options.serverScope();
    // Null/missing/invalid Core recoveryScope: distinct code (parser also drops null at native-backend ~240).
    if (!scope || !isUuid(scope)) {
      throw new Error(CLINICAL_RECOVERY_SCOPE_UNAVAILABLE, { cause: error });
    }
    await options.remember(scope);
    try {
      return await attempt();
    } catch (retryError) {
      if (hasPluginCode(retryError, "clinical_account_unavailable")) {
        throw new Error("clinical_account_unavailable_after_remember", { cause: retryError });
      }
      throw retryError;
    }
  }
}

/** While delete is in flight or confirmed, catalog refresh must not re-supply scope for remember. */
export function createDeleteAwareServerScopeRefresh(options: {
  refresh: () => Promise<string | undefined>;
  deleteActive: () => boolean;
}): () => Promise<string | undefined> {
  return async () => options.deleteActive() ? undefined : options.refresh();
}

export function createAccountSelfDeleteScopeGate(): {
  begin(): void;
  confirm(): void;
  clear(): void;
  active(): boolean;
} {
  let state: "open" | "in_flight" | "confirmed" = "open";
  return {
    begin: () => { if (state !== "confirmed") state = "in_flight"; },
    confirm: () => { state = "confirmed"; },
    clear: () => { if (state === "in_flight") state = "open"; },
    active: () => state !== "open",
  };
}

export async function clearWriteOwnerAfterBackendDispose(
  disposeBackend: () => Promise<void>,
  clearOwner: () => Promise<void>,
): Promise<void> {
  await disposeBackend();
  await clearOwner();
}

export async function desktopAccountSelfDeleteAdapter(
  portRequest: (request: DesktopProviderRequest) => Promise<unknown>,
  body: { confirm: "DELETE" },
  options: { closed: () => boolean; signal?: AbortSignal; onClinicalPurgeFailed?: () => void },
): Promise<AccountSelfDeleteResult> {
  if (body.confirm !== "DELETE" || options.closed() || options.signal?.aborted) throw unavailable();
  const requestId = crypto.randomUUID();
  const reply = exact(await portRequest({
    method: "delete_account", requestId, payload: { confirm: "DELETE" },
    connectionId: null, encounterId: null,
  }), ["requestId", "ok", "result"]);
  if (options.closed() || reply.requestId !== requestId || reply.ok !== true) throw unavailable();
  const raw = object(jsonCopy(reply.result));
  if (raw.clinicalPurgeFailed === true) {
    delete raw.clinicalPurgeFailed; options.onClinicalPurgeFailed?.();
  }
  return interpretAccountSelfDeleteBridge(raw);
}
