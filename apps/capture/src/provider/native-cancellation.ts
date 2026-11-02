import { SecureQueue } from "@cosmaneura-scribe/capacitor-secure-queue";
import { createScribeCancellation } from "./cancellation";
import { record } from "./core-client";
import type { NativeProviderSession, ProviderNativePlugin } from "./native-plugin";

/** Tokens stay in the registered native bridge. Only closed cancellation data
 * and encrypted account-keyed retry metadata enter the renderer. */
export function nativeScribeCancellation(native: ProviderNativePlugin & NativeProviderSession) {
  return createScribeCancellation({
    state: () => native.getState(),
    records: () => Promise.resolve({ records: SecureQueue, close: () => Promise.resolve() }),
    send: async (body, key, state, signal) => {
      if (signal.aborted) throw new Error("scribe_cancellation_unavailable");
      const requestId = crypto.randomUUID();
      const cancel = (): void => { void native.cancelProviderRequest({ requestId }).catch(() => undefined); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const reply = await native.providerRequest({ requestId, revision: state.revision,
          action: "cancellation", key, body: JSON.stringify(body) });
        if (signal.aborted || !record(reply) || reply.requestId !== requestId || reply.revision !== state.revision
          || ![200, 401, 403, 404, 409, 422, 503].includes(reply.status)
          || typeof reply.body !== "string" || new TextEncoder().encode(reply.body).length > 4096) throw new Error("scribe_cancellation_unavailable");
        return new Response(reply.body, { status: reply.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      } finally { signal.removeEventListener("abort", cancel); }
    },
  });
}
