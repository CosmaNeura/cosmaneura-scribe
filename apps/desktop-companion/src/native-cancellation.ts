import { createHash } from "node:crypto";
import { join } from "node:path";
import { createScribeCancellation } from "../../capture/src/provider/cancellation";
import { exact } from "../../capture/src/provider/desktop-host-protocol";
import { openDeviceCustody, type DeviceProtection } from "./device-custody.js";
import { DurableDesktopRecordStore } from "./durable-record-store.js";
import { desktopJournalRecords } from "./durable-provider-records.js";
import type { NativeProviderClient } from "./native-provider-client.js";

export function desktopScribeCancellation(native: NativeProviderClient, directory: string,
  protection: DeviceProtection, workspaceId: string, lifetime: AbortSignal) {
  return createScribeCancellation({
    state: () => native.getState(),
    records: async (account, signal) => {
      const linked = AbortSignal.any([signal, lifetime, native.signal]);
      const digest = createHash("sha256").update("scribe-cancellation-v1:" + account).digest("hex");
      const recoveryScope = `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
      const root = join(directory, "scribe-cancellation-v1");
      const custody = await openDeviceCustody(root, protection, { recoveryScope, workspaceId }, linked);
      try {
        const store = await DurableDesktopRecordStore.open({ directory: root, recoveryScope, workspaceId, key: custody.key });
        const revoked = (): void => store.close(); linked.addEventListener("abort", revoked, { once: true });
        if (linked.aborted) { store.close(); throw new Error("scribe_cancellation_unavailable"); }
        return { records: desktopJournalRecords(store.namespace("cancellation")),
          close: async () => { linked.removeEventListener("abort", revoked); store.close(); await custody.release(); } };
      } catch (error) { await custody.release(); throw error; }
    },
    send: async (body, key, state, signal) => {
      const linked = AbortSignal.any([signal, lifetime, native.signal]);
      const reply = exact(await native.request("providerRequest", { revision: state.revision,
        action: "cancellation", key, body: JSON.stringify(body) }, linked, 35_000), ["status", "body"]);
      if (linked.aborted || typeof reply.status !== "number" || ![200, 401, 403, 404, 409, 422, 503].includes(reply.status)
        || typeof reply.body !== "string" || Buffer.byteLength(reply.body) > 4096) throw new Error("scribe_cancellation_unavailable");
      return new Response(reply.body, { status: reply.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    },
  });
}
