import { scopedSignInPreparation } from "../../capture/src/provider/signin-preparation";
import { NO_DIAGNOSTICS, type RuntimeDiagnostic, type RuntimeTimingEvent } from "./runtime-diagnostics.js";
import { parseEncounterDisplay } from "../../capture/src/provider/encounter-display";
import { openingResultFromCore } from "../../capture/src/provider/opening-review";
import type { CiphertextUploadTarget } from "../../capture/src/bff/contracts";
import type { ProviderEncounter } from "../../capture/src/provider/workspace-contracts";
import { exact, object, uuid } from "../../capture/src/provider/desktop-host-protocol";
import { reference } from "../../capture/src/provider/core-client";
import type { DesktopProviderBackend } from "./provider-workspace-factory.js";
import { parseBackendCaptureGrant } from "./protocol.js";
import { parseNativeProcessFence, type NativeProcessFence } from "./native-process-fence.js";
import type { NativeProviderClient } from "./native-provider-client.js";
import { parseProviderAccount, existingPatientSetup, fullNativeVisitSetup, providerVisitCapabilities, type ProviderAccount, createEncounterSetup, type CreationRecords } from "../../capture/src/provider/encounter-setup";
import { claimDesktopInitialWindow } from "./desktop-initial-window.js";
import type { PreparedDesktopCapture } from "./provider-recorder.js";

/** Real native RPC/receiver backend. The helper owns fresh SDK tokens and all
 * source-start proofs; the main process receives only the checked grant/decision. */
export async function connectDesktopNativeBackend(native: NativeProviderClient, options: {
  signal: AbortSignal;
  diagnostics?: RuntimeDiagnostic;
  uploadTarget: CiphertextUploadTarget;
  openCore(appointmentRef: string | null): Promise<void>;
  creationRecords?: (scope: string, signal: AbortSignal) => Promise<{ records: CreationRecords; close(): Promise<void> }>;
}): Promise<DesktopProviderBackend> {
  const diagnostics = options.diagnostics ?? NO_DIAGNOSTICS;
  const timed = async <T>(event: RuntimeTimingEvent, run: () => Promise<T>): Promise<T> => {
    const began = performance.now();
    try { return await run(); }
    finally { try { diagnostics(event, Math.max(0, performance.now() - began)); } catch { /* Observation cannot affect authority. */ } }
  };
  const state = await native.getState();
  if (state.phase !== "ready" || options.signal.aborted || native.signal.aborted) throw unavailable();
  const revision = state.revision, abort = new AbortController();
  const lifetime = AbortSignal.any([options.signal, native.signal, abort.signal]);
  let openingReviewSupported = false, noteOpeningSupported = false, creationSupported = false;
  let account: ProviderAccount | undefined;
  let existingPatientOnly = false, fullNativeVisits = false;
  const encounters = new Map<string, { workspaceId: string; encounter: ProviderEncounter }>();
  type Source = { sourceLeaseId?: string; retiringPreparation: boolean; processFence?: NativeProcessFence;
    grant?: ReturnType<typeof parseBackendCaptureGrant>;
    ready?: { prepared: PreparedDesktopCapture; expiresAt?: string; grant?: ReturnType<typeof parseBackendCaptureGrant> } };
  const sources = new Map<string, Source>();
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
  const response = (input: unknown, signal: AbortSignal): Response => {
    const value = exact(input, ["status", "body"]); current(signal);
    if (typeof value.status !== "number" || typeof value.body !== "string"
      || ![200, 401, 403, 409, 422, 503].includes(value.status)) throw unavailable();
    if (value.status === 401 || value.status === 403) abort.abort();
    return new Response(value.body, { status: value.status, headers: {
      "Content-Type": "application/json", "Cache-Control": "no-store",
    } });
  };
  const abandonWindow = (): Promise<unknown> => native.request("providerInitialWindowAbandon", {});
  const request = async (action: string, body: Record<string, unknown>, key: string,
    signal: AbortSignal): Promise<Response> => {
    current(signal);
    if (!["catalog", "encounters", "mount", "recorder", "capture-admissions", "capture-operations", "capture-notes", "note-opening"].includes(action)) throw unavailable();
    const operation = typeof body.operation === "object" && body.operation !== null && "kind" in body.operation ? body.operation.kind : null;
    const event: RuntimeTimingEvent = action === "catalog" ? "provider_catalog" : action === "mount" ? "provider_mount"
      : action === "capture-admissions" ? "provider_admission" : operation === "creator_review" ? "provider_review"
      : operation === "capabilities" ? "provider_capabilities" : operation === "encryption_key" ? "provider_encryption_key"
      : operation === "prepare_recording_window" ? "provider_recording_window"
      : operation === "authorize_upload" ? "provider_upload_authorization"
      : operation === "register_chunk" ? "provider_chunk_registration"
      : operation === "chunk_receipt" ? "provider_chunk_receipt"
      : operation === "renew_lease" ? "provider_lease_renewal"
      : operation === "reserve_chunks" ? "provider_chunk_reservation"
      : operation === "preparation_metadata" ? "provider_preparation_metadata" : "provider_other_operation";
    const cancel = (): void => { void abandonWindow().catch(() => undefined); };
    if (action === "capture-admissions") signal.addEventListener("abort", cancel, { once: true });
    try {
      const value = await timed(event, () => native.request("providerRequest", {
        revision, action, key, body: JSON.stringify(body),
      }, AbortSignal.any([lifetime, signal]), action === "capture-admissions" ? 220_000
        : ["capture-notes", "note-opening"].includes(action) ? 125_000 : 35_000));
      return response(value, signal);
    } finally { signal.removeEventListener("abort", cancel); }
  };
  const json = async (action: "catalog" | "mount", body: Record<string, unknown>, signal: AbortSignal) => {
    const response = await request(action, body, crypto.randomUUID(), signal);
    if (response.status !== 200) throw unavailable();
    const value = object(await response.json());
    if (value.revision !== revision) throw unavailable();
    return value;
  };
  const encounterSetup = options.creationRecords ? createEncounterSetup({
    existingPatientOnly: () => existingPatientOnly,
    current, records: options.creationRecords,
    canHide: appointmentRef => encounters.has(appointmentRef),
    created: entry => { encounters.set(entry.appointmentRef, { workspaceId: entry.workspaceId, encounter: entry }); },
    request: async (body, key, signal) => {
      const response = await request("encounters", body, key, signal);
      if (response.status !== 200) throw unavailable();
      const value = object(await response.json()); current(signal);
      if (value.revision !== revision) throw unavailable();
      return value;
    },
  }) : undefined;
  return {
    get encounterSetup() { return creationSupported && encounterSetup ? existingPatientOnly ? existingPatientSetup(encounterSetup) : fullNativeVisits ? fullNativeVisitSetup(encounterSetup) : encounterSetup : undefined; },
    get account() { return account; },
    signal: lifetime,
    dispose: () => disposal ??= (async () => {
      abort.abort(); await observer.remove();
      for (const preparationId of sources.keys()) await releasePreparation(preparationId, false);
      sources.clear(); encounters.clear();
      await encounterSetup?.dispose();
    })().catch(error => { disposal = undefined; throw error; }),
    listEncounters: async signal => {
      const value = await json("catalog", {}, signal);
      if (!Array.isArray(value.encounters) || value.encounters.length > 1000) throw unavailable();
      const next = new Map<string, { workspaceId: string; encounter: ProviderEncounter }>();
      for (const input of value.encounters) {
        const row = object(input), encounter = parseEncounter(row);
        if (next.has(encounter.appointmentRef)) throw unavailable();
        next.set(encounter.appointmentRef, { workspaceId: uuid(row.workspaceId), encounter });
      }
      const capabilities = providerVisitCapabilities(value);
      const { supportsCreation, existingPatientOnly: nextExistingPatientOnly } = capabilities;
      const nextAccount = supportsCreation ? parseProviderAccount({ email: objectAccount(value.account).email, environment: value.environment }, capabilities.environment) : undefined;
      if (supportsCreation) {
        if ("recoveryScope" in value) uuid(value.recoveryScope);
        encounterSetup?.initializeCatalog(value, signal);
      }
      current(signal); encounters.clear();
      openingReviewSupported = value.opening_review_v1 === true;
      noteOpeningSupported = value.note_opening_v1 === true;
      creationSupported = supportsCreation;
      existingPatientOnly = nextExistingPatientOnly; fullNativeVisits = capabilities.fullNativeVisits;
      account = nextAccount;
      for (const [id, value] of next) encounters.set(id, value);
      return [...next.values()].map(value => value.encounter);
    },
    createEncounter: async signal => { current(signal); await options.openCore(null); current(signal); },
    openEncounter: async (appointmentRef, signal) => {
      current(signal);
      const row = encounters.get(appointmentRef); if (!row) throw unavailable();
      const supportsNoteOpening = noteOpeningSupported;
      const openingNonce = openingReviewSupported ? crypto.randomUUID() : undefined;
      const value = await json("mount", { workspace_id: row.workspaceId,
        ...(openingNonce ? { opening_nonce: openingNonce } : {}) }, signal);
      if (value.workspaceId !== row.workspaceId || value.appointmentRef !== appointmentRef
        || !reference(value.bindingRef, "scribe_capture_binding")) throw unavailable();
      const encounter = parseEncounter(object(value.encounter));
      if (encounter.appointmentRef !== appointmentRef) throw unavailable();
      const scope = Object.freeze({ workspaceId: row.workspaceId, appointmentRef, bindingRef: value.bindingRef });
      const openingResult = openingNonce ? openingResultFromCore(scope, openingNonce, value) : {};
      const ownedSources = new Set<string>();
      let sourceWork: Promise<unknown> = Promise.resolve();
      const serializeSource = <T>(run: () => Promise<T>): Promise<T> => {
        const next = sourceWork.then(run); sourceWork = next.catch(() => undefined); return next;
      };
      const mountedSignal = AbortSignal.any([lifetime, signal]);
      mountedSignal.addEventListener("abort", () => { void abandonWindow().catch(() => undefined); }, { once: true });
      const release = (): Promise<void> => serializeSource(async () => {
        // RAM metadata is already unusable in main. Notify native without adding
        // its RPC timeout to the existing confirmed source-cleanup path.
        void abandonWindow().catch(() => undefined);
        for (const preparationId of ownedSources) {
          await releasePreparation(preparationId, false);
          ownedSources.delete(preparationId);
        }
      });
      const retireSource = (): Promise<void> => serializeSource(async () => {
        for (const preparationId of ownedSources) {
          await releasePreparation(preparationId, true);
          ownedSources.delete(preparationId);
        }
      });
      const prepareSource = async (prepared: PreparedDesktopCapture, operationSignal: AbortSignal, ready: boolean) => {
        current(signal); current(operationSignal);
        const preparationId = crypto.randomUUID(), source: Source = { retiringPreparation: false,
          ...(ready ? { ready: { prepared: Object.freeze({ ...prepared }) } } : {}) };
        sources.set(preparationId, source); ownedSources.add(preparationId);
        // Journal custody precedes dispatch, including a missing pipe reply.
        const raw = await timed("provider_source_prepare", () => native.request(ready ? "sourcePrepare" : "sourcePrepareForStart", {
          revision, preparationId, workspaceId: scope.workspaceId, bindingRef: scope.bindingRef,
          sessionId: prepared.sessionId, leaseId: prepared.captureLeaseId,
          leaseReceiptId: prepared.leaseReceiptId, leaseGeneration: prepared.captureLeaseGeneration,
          captureAuthorizedUntil: prepared.captureAuthorizedUntil,
          ...(prepared.firstSequenceNumber ? { firstSequenceNumber: prepared.firstSequenceNumber } : {}),
        }, AbortSignal.any([lifetime, signal, operationSignal])));
        const value = exact(raw, ready ? ["grant", "processFence", "preparationExpiresAt"] : ["grant", "processFence"]);
        const grant = parseBackendCaptureGrant(value.grant), processFence = parseNativeProcessFence(value.processFence);
        if (grant.captureSessionId !== prepared.sessionId || sources.get(preparationId) !== source || source.retiringPreparation) throw unavailable();
        if (ready) {
          if (typeof value.preparationExpiresAt !== "string" || !Number.isFinite(Date.parse(value.preparationExpiresAt))
            || Date.parse(value.preparationExpiresAt) <= Date.now()
            || Date.parse(value.preparationExpiresAt) > Date.parse(prepared.captureAuthorizedUntil)) throw unavailable();
          source.ready!.expiresAt = value.preparationExpiresAt; source.ready!.grant = grant;
        }
        source.sourceLeaseId = grant.sourceLeaseId; source.processFence = processFence; source.grant = grant;
        current(signal); current(operationSignal);
        return source;
      };
      const releaseReady = (): Promise<void> => serializeSource(async () => {
        for (const id of ownedSources) if (sources.get(id)?.ready) {
          // Preparation-only cancellation, never a physical-stop claim.
          const source = sources.get(id)!; source.retiringPreparation = true;
          await releasePreparation(id, false); ownedSources.delete(id);
        }
      });
      return {
        release, retireSource, encounter, scope, signal: mountedSignal, recoveryScope: uuid(value.recoveryScope),
        ...(state.recordingSignInPreparationVersion === 1 ? { signInPreparation: scopedSignInPreparation({
          signal: mountedSignal, current: () => current(mountedSignal),
          prepare: async (preparationId, operationSignal) => {
            const reply = exact(await native.request("prepareProviderSignIn", { preparationId, revision,
              workspaceId: scope.workspaceId, bindingRef: scope.bindingRef }, operationSignal), ["revision"]);
            current(mountedSignal); current(operationSignal);
            if (reply.revision !== revision) throw unavailable();
          },
          abandon: preparationId => native.request("abandonProviderSignIn", { preparationId }).then(() => undefined),
        }) } : {}),
        ...(object(value.encounter).admission_metadata_v1 === true ? { admissionMetadataSupported: true as const } : {}),
        ...(supportsNoteOpening ? { noteOpeningSupported: true as const } : {}),
        ...openingResult,
        ...(state.desktopSourcePreparationVersion === 1 ? { readySourcePreparation: {
          release: releaseReady,
          prepare: (prepared: PreparedDesktopCapture, operationSignal: AbortSignal) => serializeSource(async () => {
            current(signal); current(operationSignal);
            if (prepared.captureLeaseGeneration !== 1 || prepared.firstSequenceNumber) throw unavailable();
            for (const id of ownedSources) {
              const prior = sources.get(id);
              if (!prior?.ready) throw unavailable();
              if (!prior.retiringPreparation && prior.ready.expiresAt && prior.ready.grant
                && Date.parse(prior.ready.expiresAt) > Date.now() && samePrepared(prior.ready.prepared, prepared)) {
                return { expiresAt: prior.ready.expiresAt };
              }
              prior.retiringPreparation = true;
              await releasePreparation(id, false); ownedSources.delete(id);
            }
            const source = await prepareSource(prepared, operationSignal, true);
            return { expiresAt: source.ready!.expiresAt! };
          }),
        } } : {}),
        uploadTarget: options.uploadTarget,
        sendFreshInitialWindow: (proof, body, key, operationSignal) => {
          const admission = claimDesktopInitialWindow(proof, { scope, body, key });
          current(signal); current(operationSignal);
          const cancel = (): void => { void abandonWindow().catch(() => undefined); };
          operationSignal.addEventListener("abort", cancel, { once: true });
          return timed("provider_recording_window", async () => {
            try { return response(await native.request("providerInitialWindow", {
              revision, key, body: JSON.stringify(body), admissionKey: admission.key,
              admissionNonce: admission.nonce, admissionReceipt: admission.receipt,
            }, AbortSignal.any([lifetime, signal, operationSignal])), operationSignal); }
            finally { operationSignal.removeEventListener("abort", cancel); }
          });
        },
        request: (path, body, key, operationSignal) => {
          current(signal);
          const action = path.slice("/service/v1/agent/scribe/".length);
          if (path !== "/service/v1/agent/scribe/" + action
            || !["capture-admissions", "capture-operations", "capture-notes", ...(supportsNoteOpening ? ["note-opening"] : [])].includes(action)
            || body.workspace_id !== scope.workspaceId || body.binding_ref !== scope.bindingRef) throw unavailable();
          return request(action, { ...body }, key, AbortSignal.any([signal, operationSignal]));
        },
        authorizeRecorder: (prepared, operationSignal) => serializeSource(async () => {
          current(signal); current(operationSignal);
          for (const preparationId of ownedSources) {
            const source = sources.get(preparationId);
            if (source?.ready) {
              if (!source.retiringPreparation && source.ready.expiresAt && source.ready.grant && source.processFence
                && Date.parse(source.ready.expiresAt) > Date.now() && samePrepared(source.ready.prepared, prepared)) {
                const grant = source.ready.grant;
                delete source.ready;
                return { grant, status: "created" as const };
              }
              source.retiringPreparation = true;
            }
            if (!sources.get(preparationId)?.sourceLeaseId || sources.get(preparationId)?.retiringPreparation) {
              await releasePreparation(preparationId, false);
              ownedSources.delete(preparationId);
            }
          }
          current(signal); current(operationSignal);
          // Called after deliberate Start and window selection. The native
          // owner keeps the short-lived decision until sourceAuthorize consumes
          // it; this reply exposes only the original grant and process fence.
          const source = await prepareSource(prepared, operationSignal, false);
          // A combined owner has no Ready metadata; obtain its checked grant.
          return { grant: source.grant!, status: "created" as const };
        }),
        processFence: () => {
          current(signal);
          const values = [...ownedSources].map(id => sources.get(id));
          if (values.length !== 1 || !values[0]?.sourceLeaseId || values[0].retiringPreparation || !values[0].processFence) throw unavailable();
          return values[0].processFence;
        },
        authority: { authorizeStart: async (grant, operationSignal) => {
          current(signal); current(operationSignal);
          if (![...ownedSources].some(id => sources.get(id)?.sourceLeaseId === grant.sourceLeaseId)) throw unavailable();
          const decision = await timed("provider_source_authorize", () => native.request("sourceAuthorize", { sourceLeaseId: grant.sourceLeaseId },
            AbortSignal.any([lifetime, signal, operationSignal])));
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

const parseEncounter = parseEncounterDisplay;

function unavailable(): Error { return new Error("provider_native_connection_unavailable"); }

function samePrepared(left: PreparedDesktopCapture, right: PreparedDesktopCapture): boolean {
  return left.sessionId === right.sessionId && left.captureLeaseId === right.captureLeaseId
    && left.leaseReceiptId === right.leaseReceiptId && left.captureLeaseGeneration === right.captureLeaseGeneration
    && left.captureAuthorizedUntil === right.captureAuthorizedUntil && (left.firstSequenceNumber ?? 0) === (right.firstSequenceNumber ?? 0);
}

function objectAccount(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
