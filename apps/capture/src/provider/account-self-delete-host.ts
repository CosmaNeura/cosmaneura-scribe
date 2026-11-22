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

/** On clinical_account_unavailable: remember with server scope, retry once, then a specific error. */
export async function nativeAccountSelfDeleteWithRememberRetry(options: {
  nativeDelete: (request: { confirm: "DELETE" }) => Promise<unknown>;
  remember: (scope: string) => Promise<void>;
  serverScope: () => string | undefined;
  request: { confirm: "DELETE" };
  signal?: AbortSignal;
}): Promise<AccountSelfDeleteResult> {
  const attempt = () => nativeAccountSelfDeleteAdapter(options.nativeDelete, options.request, options.signal);
  try {
    return await attempt();
  } catch (error) {
    if (!hasPluginCode(error, "clinical_account_unavailable")) throw error;
    const scope = options.serverScope();
    if (!scope || !isUuid(scope)) {
      throw new Error("clinical_account_unavailable_after_remember", { cause: error });
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
