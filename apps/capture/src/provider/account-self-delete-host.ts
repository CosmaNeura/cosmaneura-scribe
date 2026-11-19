import { interpretAccountSelfDeleteBridge, type AccountSelfDeleteResult } from "./account-self-delete";
import { exact, object, jsonCopy, unavailable, type DesktopProviderRequest } from "./desktop-host-protocol";

export async function nativeAccountSelfDeleteAdapter(
  nativeDelete: (request: { confirm: "DELETE" }) => Promise<unknown>,
  request: { confirm: "DELETE" }, signal?: AbortSignal,
): Promise<AccountSelfDeleteResult> {
  if (request.confirm !== "DELETE") throw new Error("account_self_delete_unconfirmed");
  if (signal?.aborted) throw new Error("account_self_delete_aborted");
  return interpretAccountSelfDeleteBridge(await nativeDelete({ confirm: "DELETE" }));
}
export async function desktopAccountSelfDeleteAdapter(
  portRequest: (request: DesktopProviderRequest) => Promise<unknown>,
  body: { confirm: "DELETE" },
  options: { closed: () => boolean; signal?: AbortSignal; onClinicalPurgeFailed?: () => void },
): Promise<AccountSelfDeleteResult> {
  if (body.confirm !== "DELETE") throw unavailable();
  if (options.closed() || options.signal?.aborted) throw unavailable();
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
