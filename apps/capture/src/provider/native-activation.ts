import { isUuid } from "../../../review-ui/src/contracts";
import { checkedProviderSetup, ProviderSetupRequired } from "./account-setup";
import { record } from "./core-client";
import type { NativeProviderSession, ProviderNativePlugin } from "./native-plugin";

/** Explicit account action through the fixed native receiver; no credentials or URL. */
export async function activateNativeScribe(native: ProviderNativePlugin & NativeProviderSession,
  signal: AbortSignal, revision: string): Promise<void> {
  const unavailable = (): Error => new Error("scribe_activation_unconfirmed");
  const before = await native.getState();
  if (signal.aborted || before.phase !== "ready" || before.revision !== revision || !isUuid(revision)) throw unavailable();
  const requestId = crypto.randomUUID(), nonce = crypto.randomUUID();
  const abort = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let cancel: (() => void) | undefined;
  try {
    const reply = await new Promise<Awaited<ReturnType<ProviderNativePlugin["providerRequest"]>>>((resolve, reject) => {
      cancel = (): void => {
        void native.cancelProviderRequest({ requestId }).catch(() => undefined);
        reject(unavailable());
      };
      abort.addEventListener("abort", cancel, { once: true });
      if (abort.aborted) { cancel(); return; }
      void native.providerRequest({ requestId, revision, action: "activation", key: crypto.randomUUID(),
        body: JSON.stringify({ action: "activate", request_nonce: nonce }) }).then(resolve, reject);
    });
    const after = await native.getState();
    if (abort.aborted || after.phase !== "ready" || after.revision !== revision
      || !record(reply) || reply.requestId !== requestId || reply.revision !== revision
      || typeof reply.body !== "string" || new TextEncoder().encode(reply.body).length > 1024) throw unavailable();
    const value: unknown = JSON.parse(reply.body);
    if (reply.status === 409) {
      if (checkedProviderSetup(value, revision, nonce) === "practice") throw new ProviderSetupRequired("practice");
      throw unavailable();
    }
    if (reply.status !== 200 || !record(value)
      || Object.keys(value).sort().join() !== "action,contract_version,request_nonce,revision,state"
      || value.action !== "activate" || value.contract_version !== "1" || value.state !== "active"
      || value.request_nonce !== nonce || value.revision !== revision) throw unavailable();
  } finally { if (cancel) abort.removeEventListener("abort", cancel); }
}
