import { MAX_CHUNKS } from "@cosmaneura-scribe/capture-protocol";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import type { CiphertextUploadTarget } from "../bff/contracts";
import { BffResponseError } from "../bff/http-client";
import { QueueInvariantError } from "../queue/errors";
import { isUuid } from "../../../review-ui/src/contracts";
import { coreCaptureResponseLimit } from "../../../review-ui/src/capture-response-limits";
import { record, reference } from "./core-client";
import type { ProviderIOSBackend } from "./ios-host";
import { nativeProviderPlugin, type ProviderAction as Action, type NativeProviderState as NativeState,
  type ProviderNativePlugin } from "./native-plugin";
import type { NativeRecordingPort } from "./native-recorder";
import type { ProviderEncounter } from "./workspace";

const limits: Record<Action, number> = { catalog: 2, mount: 256, recorder: 1024,
  "capture-admissions": 2048, "capture-operations": 4_194_304, "capture-notes": 262_144 + 8192 };
type NativeReply = Awaited<ReturnType<ProviderNativePlugin["providerRequest"]>>;
export type { ProviderNativePlugin } from "./native-plugin";
export interface NativeProviderOptions {
  readonly signal: AbortSignal;
  /** Existing authorized ciphertext target and Core navigation, configured by the native host. */
  readonly uploadTarget: CiphertextUploadTarget;
  readonly core: {
    createEncounter(signal: AbortSignal): Promise<void>;
    openEncounter(appointmentRef: string, noteRef: string | null, signal: AbortSignal): Promise<void>;
  };
}
export interface NativeProviderBackend extends ProviderIOSBackend { dispose(): Promise<void> }

/** Bind the existing signed-in iOS session to the fixed provider receiver.
 * The plugin obtains a fresh SDK token natively for every operation. This module
 * never calls getToken, receives credentials or accepts a backend URL/headers.
 */
export async function connectNativeProviderIOSBackend(options: NativeProviderOptions,
  plugin: ProviderNativePlugin = nativeProviderPlugin): Promise<NativeProviderBackend> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios"
    || !Capacitor.isPluginAvailable("CosmasWorkspaceAuth")) throw unavailable();
  const abort = new AbortController();
  let nativeRecording = false;
  let revision: string | null = null, observed: NativeState | null = null;
  let listener: PluginListenerHandle | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let checking: Promise<void> | null = null, disposal: Promise<void> | null = null;
  const encounters = new Map<string, { workspaceId: string; encounter: ProviderEncounter }>();
  const inheritedAbort = (): void => abort.abort();
  options.signal.addEventListener("abort", inheritedAbort, { once: true });
  const current = (signal?: AbortSignal): void => {
    if (abort.signal.aborted || options.signal.aborted || signal?.aborted) throw unavailable();
  };
  const accept = (state: NativeState): void => {
    if (!record(state) || typeof state.phase !== "string" || !isUuid(state.revision)) {
      abort.abort(); return;
    }
    observed = { phase: state.phase, revision: state.revision };
    if (revision && (state.phase !== "ready" || state.revision !== revision)) abort.abort();
  };
  const dispose = (): Promise<void> => disposal ??= (async () => {
    abort.signal.removeEventListener("abort", teardown);
    document.removeEventListener("visibilitychange", resume);
    abort.abort();
    if (timer !== undefined) clearInterval(timer);
    options.signal.removeEventListener("abort", inheritedAbort);
    encounters.clear();
    await listener?.remove();
  })();
  const refresh = (): Promise<void> => {
    if (abort.signal.aborted) return Promise.resolve();
    return checking ??= (async () => {
      try {
        const state = await plugin.getProviderState();
        if (state.providerReady !== true) abort.abort();
        else accept(state);
      } catch { abort.abort(); }
      finally { checking = null; }
    })();
  };
  const resume = (): void => { if (document.visibilityState === "visible") void refresh(); };
  const teardown = (): void => {
    document.removeEventListener("visibilitychange", resume);
    void dispose().catch(() => undefined);
  };
  abort.signal.addEventListener("abort", teardown, { once: true });
  try {
    current();
    const added = await plugin.addListener("authStateChanged", accept);
    if (abort.signal.aborted || options.signal.aborted) {
      await added.remove(); throw unavailable();
    }
    listener = added;
    current();
    const state = await plugin.getProviderState();
    current();
    // A native state event racing this read must not be overwritten by an older reply.
    const duringRead = observed as NativeState | null;
    if (!record(state) || state.phase !== "ready" || state.providerReady !== true || !isUuid(state.revision)
      || duringRead && (duringRead.phase !== state.phase || duringRead.revision !== state.revision)) throw unavailable();
    revision = state.revision;
    nativeRecording = state.nativeRecordingVersion === 1 && typeof plugin.openProviderRecording === "function"
      && typeof plugin.providerRecordingCommand === "function";
    document.addEventListener("visibilitychange", resume);
    timer = setInterval(() => { void refresh(); }, 5000); // Existing native state check, no SDK token request.
  } catch (error) { await dispose(); throw error; }

  const request = (action: Action, body: Readonly<Record<string, unknown>>, key: string,
    signals: readonly AbortSignal[]): Promise<Response> => {
    current();
    const json = JSON.stringify(body), requestId = crypto.randomUUID(), expected = revision;
    if (!/^[A-Za-z0-9._:-]{8,255}$/u.test(key) || new TextEncoder().encode(json).length > limits[action]) throw unavailable();
    const allSignals = [...new Set([abort.signal, ...signals])];
    if (allSignals.some(signal => signal.aborted)) return Promise.reject(unavailable());
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const clear = (): void => { for (const signal of allSignals) signal.removeEventListener("abort", cancel); };
      const cancel = (): void => {
        if (settled) return;
        settled = true; clear();
        void plugin.cancelProviderRequest({ requestId }).catch(() => undefined);
        reject(unavailable());
      };
      for (const signal of allSignals) signal.addEventListener("abort", cancel, { once: true });
      // No token, destination or caller-chosen authority crosses this bridge.
      let nativeRequest: Promise<NativeReply>;
      try { nativeRequest = plugin.providerRequest({ requestId, revision: expected, action, key, body: json }); }
      catch { settled = true; clear(); reject(unavailable()); return; }
      void nativeRequest.then(reply => {
        if (settled) return;
        settled = true; clear();
        try {
          current();
          if (!record(reply) || reply.requestId !== requestId || reply.revision !== expected
            || ![200, 401, 403, 409, 422, 503].includes(reply.status) || typeof reply.body !== "string"
            || new TextEncoder().encode(reply.body).length > coreCaptureResponseLimit(action)) throw unavailable();
          if (reply.status === 401 || reply.status === 403) {
            abort.abort(); throw new BffResponseError(reply.status, "provider_access_unavailable", null);
          }
          resolve(new Response(reply.body, { status: reply.status,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }));
        } catch (error) { reject(error instanceof Error ? error : unavailable()); }
      }, () => {
        if (!settled) { settled = true; clear(); reject(unavailable()); }
      });
    });
  };
  const json = async (action: "catalog" | "mount" | "recorder", body: Record<string, unknown>,
    signal: AbortSignal): Promise<Record<string, unknown>> => {
    const response = await request(action, body, crypto.randomUUID(), [signal]);
    if (response.status !== 200) throw new BffResponseError(response.status, "provider_request_unconfirmed", null);
    const value: unknown = await response.json();
    current(signal);
    if (!record(value) || value.revision !== revision) throw unavailable();
    return value;
  };

  return {
    signal: abort.signal, dispose,
    listEncounters: async signal => {
      const value = await json("catalog", {}, signal);
      if (!Array.isArray(value.encounters) || value.encounters.length > 100) throw unavailable();
      const next = new Map<string, { workspaceId: string; encounter: ProviderEncounter }>();
      for (const row of value.encounters) {
        if (!record(row) || !isUuid(row.workspaceId)) throw unavailable();
        const entry = encounter(row);
        if (next.has(entry.appointmentRef)) throw unavailable();
        next.set(entry.appointmentRef, { workspaceId: row.workspaceId, encounter: entry });
      }
      current(signal); encounters.clear();
      for (const [key, row] of next) encounters.set(key, row);
      return [...next.values()].map(row => row.encounter);
    },
    createEncounter: async signal => {
      current(signal); await refresh(); current(signal);
      await options.core.createEncounter(signal); current(signal);
    },
    openEncounter: async (appointmentRef, signal) => {
      current(signal);
      const row = encounters.get(appointmentRef);
      if (!row) throw unavailable();
      const value = await json("mount", { workspace_id: row.workspaceId }, signal);
      if (!isUuid(value.recoveryScope) || value.workspaceId !== row.workspaceId || value.appointmentRef !== appointmentRef
        || !reference(value.bindingRef, "scribe_capture_binding") || !record(value.encounter)) throw unavailable();
      const displayed = encounter(value.encounter);
      if (displayed.appointmentRef !== appointmentRef) throw unavailable();
      const scope = Object.freeze({ workspaceId: row.workspaceId, appointmentRef, bindingRef: value.bindingRef });
      return {
        encounter: displayed, recoveryScope: value.recoveryScope, scope, signal,
        uploadTarget: options.uploadTarget,
        ...(nativeRecording ? { nativeRecording: {
          open: (sessionId: string, requestId: string) => {
            current(signal);
            if (!revision || !isUuid(sessionId) || !isUuid(requestId)) throw unavailable();
            // Deliver late ownership handles so workspace teardown can close them.
            return plugin.openProviderRecording!({ requestId, revision, workspaceId: scope.workspaceId,
              bindingRef: scope.bindingRef, sessionId });
          },
          command: (command: Parameters<NativeRecordingPort["command"]>[0]) => {
            if (command.kind !== "close") current(signal);
            if (!revision) throw unavailable();
            return plugin.providerRecordingCommand!({ ...command, revision });
          },
        } } : {}),
        request: async (path, body, key, operationSignal) => {
          current(signal);
          const action = path.slice("/service/v1/agent/scribe/".length);
          if (path !== "/service/v1/agent/scribe/" + action
            || !["capture-admissions", "capture-operations", "capture-notes"].includes(action)
            || body.workspace_id !== scope.workspaceId || body.binding_ref !== scope.bindingRef) throw unavailable();
          return request(action as Action, body, key, [signal, operationSignal]);
        },
        reauthorizeRecorder: async (sessionId, recorderSignal) => {
          current(signal);
          if (!isUuid(sessionId)) throw unavailable();
          const response = await request("recorder", { workspace_id: scope.workspaceId,
            binding_ref: scope.bindingRef, session_id: sessionId, request_nonce: crypto.randomUUID() },
          crypto.randomUUID(), [signal, recorderSignal]);
          if (response.status !== 200) throw unavailable();
          const receipt: unknown = await response.json();
          current(signal); current(recorderSignal);
          if (!record(receipt) || receipt.revision !== revision || receipt.session_id !== sessionId) throw unavailable();
        },
        prepareNativeSource: async (prepared, sourceSignal) => {
          current(signal); current(sourceSignal);
          if (!revision || !isUuid(prepared.sessionId) || !isUuid(prepared.leaseId)
            || !isUuid(prepared.leaseReceiptId) || !Number.isSafeInteger(prepared.leaseGeneration)
            || prepared.leaseGeneration < 1 || prepared.firstSequenceNumber !== undefined
              && (!Number.isSafeInteger(prepared.firstSequenceNumber) || prepared.firstSequenceNumber < 1
                || prepared.firstSequenceNumber >= MAX_CHUNKS)) throw unavailable();
          const reply = await plugin.prepareProviderSource({ revision, workspaceId: scope.workspaceId,
            bindingRef: scope.bindingRef, ...prepared });
          current(signal); current(sourceSignal);
          if (!record(reply) || reply.revision !== revision || reply.sessionId !== prepared.sessionId) throw unavailable();
        },
        releaseNativeSource: sessionId => plugin.closeProviderSource({ sessionId }),
        openInCore: async noteRef => {
          current(signal);
          if (noteRef !== null && !reference(noteRef, "visit_note")) throw unavailable();
          const checked = await json("mount", { workspace_id: scope.workspaceId }, signal);
          if (checked.bindingRef !== scope.bindingRef || checked.appointmentRef !== appointmentRef) throw unavailable();
          await options.core.openEncounter(appointmentRef, noteRef, signal); current(signal);
        },
      };
    },
  };
}

function encounter(value: Record<string, unknown>): ProviderEncounter {
  if (!reference(value.appointmentRef, "appointment") || typeof value.title !== "string" || value.title.length > 300
    || typeof value.detail !== "string" || value.detail.length > 1000) throw unavailable();
  return Object.freeze({ appointmentRef: value.appointmentRef, title: value.title, detail: value.detail });
}
function unavailable(): QueueInvariantError { return new QueueInvariantError("provider_native_connection_unavailable"); }
