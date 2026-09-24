import type { CiphertextUploadTarget } from "../../capture/src/bff/contracts";
import type { ProviderEncounter } from "../../capture/src/provider/workspace-contracts";
import { exact, object, uuid } from "../../capture/src/provider/desktop-host-protocol";
import { reference } from "../../capture/src/provider/core-client";
import type { DesktopProviderBackend } from "./provider-workspace-factory.js";
import { parseBackendCaptureGrant } from "./protocol.js";
import { parseNativeProcessFence, type NativeProcessFence } from "./native-process-fence.js";
import type { NativeProviderClient } from "./native-provider-client.js";

/** Real native RPC/receiver backend. The helper owns fresh SDK tokens and all
 * source-start proofs; the main process receives only the checked grant/decision. */
export async function connectDesktopNativeBackend(native: NativeProviderClient, options: {
  signal: AbortSignal;
  uploadTarget: CiphertextUploadTarget;
  openCore(appointmentRef: string | null): Promise<void>;
}): Promise<DesktopProviderBackend> {
  const state = await native.getState();
  if (state.phase !== "ready" || options.signal.aborted || native.signal.aborted) throw unavailable();
  const revision = state.revision, abort = new AbortController();
  const lifetime = AbortSignal.any([options.signal, native.signal, abort.signal]);
  const encounters = new Map<string, { workspaceId: string; encounter: ProviderEncounter }>();
  const sources = new Map<string, { sourceLeaseId?: string; retiringPreparation: boolean; processFence?: NativeProcessFence }>();
  const releasePreparation = async (preparationId: string, stopped: boolean): Promise<void> => {
    const source = sources.get(preparationId); if (!source) return;
    if (native.signal.aborted) throw unavailable();
    if (source.sourceLeaseId && !source.retiringPreparation) {
      await native.request(stopped ? "sourceStopped" : "sourceRelease", { sourceLeaseId: source.sourceLeaseId });
    } else {
      // The helper may own a preparation whose pipe reply never arrived. This
      // correlation ID grants no authority and never leaves the main/native pipe.
      source.retiringPreparation = true;
      await native.request("sourcePreparationRelease", { revision, preparationId });
    }
    sources.delete(preparationId);
  };
  const observer = await native.addListener("authStateChanged", next => {
    if (next.phase !== "ready" || next.revision !== revision) abort.abort();
  });
  let disposal: Promise<void> | undefined;
  const current = (signal?: AbortSignal): void => {
    if (lifetime.aborted || signal?.aborted || !native.isReady()) throw unavailable();
  };
  const request = async (action: string, body: Record<string, unknown>, key: string,
    signal: AbortSignal): Promise<Response> => {
    current(signal);
    if (!["catalog", "mount", "recorder", "capture-admissions", "capture-operations", "capture-notes"].includes(action)) throw unavailable();
    const value = exact(await native.request("providerRequest", {
      revision, action, key, body: JSON.stringify(body),
    }, AbortSignal.any([lifetime, signal]), action === "capture-notes" ? 125_000 : 35_000), ["status", "body"]);
    current(signal);
    if (typeof value.status !== "number" || typeof value.body !== "string"
      || ![200, 401, 403, 409, 422, 503].includes(value.status)) throw unavailable();
    if (value.status === 401 || value.status === 403) abort.abort();
    return new Response(value.body, { status: value.status, headers: {
      "Content-Type": "application/json", "Cache-Control": "no-store",
    } });
  };
  const json = async (action: "catalog" | "mount", body: Record<string, unknown>, signal: AbortSignal) => {
    const response = await request(action, body, crypto.randomUUID(), signal);
    if (response.status !== 200) throw unavailable();
    const value = object(await response.json());
    if (value.revision !== revision) throw unavailable();
    return value;
  };
  return {
    signal: lifetime,
    dispose: () => disposal ??= (async () => {
      abort.abort(); await observer.remove();
      for (const preparationId of sources.keys()) await releasePreparation(preparationId, false);
      sources.clear(); encounters.clear();
    })().catch(error => { disposal = undefined; throw error; }),
    listEncounters: async signal => {
      const value = await json("catalog", {}, signal);
      if (!Array.isArray(value.encounters) || value.encounters.length > 100) throw unavailable();
      const next = new Map<string, { workspaceId: string; encounter: ProviderEncounter }>();
      for (const input of value.encounters) {
        const row = object(input), encounter = parseEncounter(row);
        if (next.has(encounter.appointmentRef)) throw unavailable();
        next.set(encounter.appointmentRef, { workspaceId: uuid(row.workspaceId), encounter });
      }
      current(signal); encounters.clear();
      for (const [id, value] of next) encounters.set(id, value);
      return [...next.values()].map(value => value.encounter);
    },
    createEncounter: async signal => { current(signal); await options.openCore(null); current(signal); },
    openEncounter: async (appointmentRef, signal) => {
      current(signal);
      const row = encounters.get(appointmentRef); if (!row) throw unavailable();
      const value = await json("mount", { workspace_id: row.workspaceId }, signal);
      if (value.workspaceId !== row.workspaceId || value.appointmentRef !== appointmentRef
        || !reference(value.bindingRef, "scribe_capture_binding")) throw unavailable();
      const encounter = parseEncounter(object(value.encounter));
      if (encounter.appointmentRef !== appointmentRef) throw unavailable();
      const scope = Object.freeze({ workspaceId: row.workspaceId, appointmentRef, bindingRef: value.bindingRef });
      const ownedSources = new Set<string>();
      const release = async (): Promise<void> => {
        for (const preparationId of ownedSources) {
          await releasePreparation(preparationId, false);
          ownedSources.delete(preparationId);
        }
      };
      const retireSource = async (): Promise<void> => {
        for (const preparationId of ownedSources) {
          await releasePreparation(preparationId, true);
          ownedSources.delete(preparationId);
        }
      };
      return {
        release, retireSource, encounter, scope, signal: AbortSignal.any([lifetime, signal]), recoveryScope: uuid(value.recoveryScope),
        uploadTarget: options.uploadTarget,
        request: (path, body, key, operationSignal) => {
          current(signal);
          const action = path.slice("/service/v1/agent/scribe/".length);
          if (path !== "/service/v1/agent/scribe/" + action
            || !["capture-admissions", "capture-operations", "capture-notes"].includes(action)
            || body.workspace_id !== scope.workspaceId || body.binding_ref !== scope.bindingRef) throw unavailable();
          return request(action, { ...body }, key, AbortSignal.any([signal, operationSignal]));
        },
        authorizeRecorder: async (prepared, operationSignal) => {
          current(signal); current(operationSignal);
          for (const preparationId of ownedSources) {
            if (!sources.get(preparationId)?.sourceLeaseId || sources.get(preparationId)?.retiringPreparation) {
              await releasePreparation(preparationId, false);
              ownedSources.delete(preparationId);
            }
          }
          current(signal); current(operationSignal);
          const preparationId = crypto.randomUUID(), source: { sourceLeaseId?: string; retiringPreparation: boolean; processFence?: NativeProcessFence } = { retiringPreparation: false };
          sources.set(preparationId, source); ownedSources.add(preparationId);
          const raw = await native.request("sourcePrepare", {
            revision, preparationId, workspaceId: scope.workspaceId, bindingRef: scope.bindingRef,
            sessionId: prepared.sessionId, leaseId: prepared.captureLeaseId,
            leaseReceiptId: prepared.leaseReceiptId, leaseGeneration: prepared.captureLeaseGeneration,
            captureAuthorizedUntil: prepared.captureAuthorizedUntil,
            ...(prepared.firstSequenceNumber ? { firstSequenceNumber: prepared.firstSequenceNumber } : {}),
          }, AbortSignal.any([lifetime, signal, operationSignal]));
          const value = exact(raw, ["grant", "processFence"]);
          const grant = parseBackendCaptureGrant(value.grant);
          const processFence = parseNativeProcessFence(value.processFence);
          if (grant.captureSessionId !== prepared.sessionId || sources.get(preparationId) !== source
            || source.retiringPreparation) throw unavailable();
          source.sourceLeaseId = grant.sourceLeaseId; source.processFence = processFence;
          current(signal); current(operationSignal);
          return { grant, status: "created" };
        },
        processFence: () => {
          current(signal);
          const values = [...ownedSources].map(id => sources.get(id));
          if (values.length !== 1 || !values[0]?.sourceLeaseId || values[0].retiringPreparation || !values[0].processFence) throw unavailable();
          return values[0].processFence;
        },
        authority: { authorizeStart: async (grant, operationSignal) => {
          current(signal); current(operationSignal);
          if (![...ownedSources].some(id => sources.get(id)?.sourceLeaseId === grant.sourceLeaseId)) throw unavailable();
          const decision = await native.request("sourceAuthorize", { sourceLeaseId: grant.sourceLeaseId },
            AbortSignal.any([lifetime, signal, operationSignal]));
          current(signal); current(operationSignal);
          return decision; // Existing protected validator binds every grant field and consumes once.
        } },
        openInCore: async noteRef => {
          current(signal);
          if (noteRef !== null && !reference(noteRef, "visit_note")) throw unavailable();
          const checked = await json("mount", { workspace_id: scope.workspaceId }, signal);
          if (checked.bindingRef !== scope.bindingRef || checked.appointmentRef !== appointmentRef) throw unavailable();
          await options.openCore(appointmentRef); current(signal);
        },
      };
    },
  };
}

function parseEncounter(value: Record<string, unknown>): ProviderEncounter {
  if (!reference(value.appointmentRef, "appointment") || typeof value.title !== "string"
    || value.title.length > 300 || typeof value.detail !== "string" || value.detail.length > 1000) throw unavailable();
  return Object.freeze({ appointmentRef: value.appointmentRef, title: value.title, detail: value.detail });
}
function unavailable(): Error { return new Error("provider_native_connection_unavailable"); }
