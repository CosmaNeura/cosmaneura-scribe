import { passageWav, retainPassageAudio } from "./passage-playback.js";
import { NativeCreatorEditJournal } from "../../review-ui/src/native-edit-journal";
import type { DesktopRecordingWindow } from "./recording-window.js";
import type { ProviderWorkspaceHost, AuthorizedProviderEncounter } from "../../capture/src/provider/workspace-contracts";
import { CoreCaptureClient, reference } from "../../capture/src/provider/core-client";
import { NativeProviderWorkspaceJournal } from "../../capture/src/provider/workspace-journal";
import { NativeCreatorReviewJournal } from "../../review-ui/src/native-review-journal";
import type { CiphertextUploadTarget } from "../../capture/src/bff/contracts";
import type { DesktopProviderMainHost } from "./provider-workspace-main.js";
import { DesktopProviderRecorder, type DesktopProviderRecorderOptions } from "./provider-recorder.js";
import { DurableDesktopRecordStore, uuid } from "./durable-record-store.js";
import { DurableDesktopFlowStore } from "./durable-flow-store.js";
import { DurableDesktopQueueStorage } from "./durable-queue-store.js";
import { DurableDesktopCoverage, desktopJournalRecords } from "./durable-provider-records.js";
import type { NativePresentationOwner } from "./native-provider-presentation.js";
import { parseCreatorReview } from "../../review-ui/src/creator-review-api";
import type { PreparedDesktopCapture } from "./provider-recorder.js";
import { DesktopPreparationBff } from "./preparation-metadata.js";
import { readBoundedJson } from "../../review-ui/src/beta-api";
import { coreCaptureResponseLimit } from "../../review-ui/src/capture-response-limits";
import { canonical } from "../../capture/src/provider/core-notes";
import { DesktopInitialWindowOwner, type DesktopInitialWindowProof } from "./desktop-initial-window.js";
import type { DesktopAudioPreflight } from "./desktop-audio-preflight.js";

export interface AuthorizedDesktopProviderMount extends Omit<AuthorizedProviderEncounter,
  "journal" | "reviewJournal" | "recorder"> {
  readonly recoveryScope: string;
  /** Optional receiver capability, confined to this backend-issued mount. */
  readonly admissionMetadataSupported?: true;
  /** Main-owned opaque proof; never part of ProviderWorkspaceHost/renderer IPC. */
  readonly sendFreshInitialWindow?: (proof: DesktopInitialWindowProof, body: Readonly<Record<string, unknown>>,
    key: string, signal: AbortSignal) => Promise<Response>;
  readonly release?: () => Promise<void>;
  readonly uploadTarget: CiphertextUploadTarget;
  /** Backend-issued authority. A session/capabilities receipt is insufficient. */
  readonly retireSource: () => Promise<void>;
  readonly authorizeRecorder: (prepared: PreparedDesktopCapture, signal: AbortSignal) => ReturnType<DesktopProviderRecorderOptions["authorizeMount"]>;
  readonly readySourcePreparation?: DesktopProviderRecorderOptions["readySourcePreparation"];
  readonly authority: DesktopProviderRecorderOptions["authority"];
  readonly processFence?: DesktopProviderRecorderOptions["native"]["getProcessFence"];
}
export interface DesktopProviderBackend extends Pick<ProviderWorkspaceHost, "signal" | "listEncounters" | "createEncounter" | "encounterSetup" | "account"> {
  readonly openEncounter: (appointmentRef: string, signal: AbortSignal) => Promise<AuthorizedDesktopProviderMount>;
  dispose(): Promise<void>;
}
export interface DesktopProviderResources {
  readonly enabled?: boolean;
  readonly prepareInBackground?: boolean;
  /** Explicit app-owned directory, separate from every existing app namespace. */
  readonly directory: string;
  /** The native owner supplies a stable device-protected key after authorization.
   * Rejected acquisitions must clean themselves up. Never replace a lost key. */
  readonly openCustody: (scope: { readonly recoveryScope: string; readonly workspaceId: string }, signal: AbortSignal) => Promise<{
    readonly key: CryptoKey;
    release(): Promise<void>;
  }>;
  readonly indicator: DesktopProviderRecorderOptions["indicator"];
  readonly native: DesktopProviderRecorderOptions["native"];
  readonly audioPreflight?: DesktopAudioPreflight;
  readonly selectWindow: DesktopProviderRecorderOptions["selectWindow"];
  readonly listMeetingWindows?: DesktopProviderRecorderOptions["listMeetingWindows"];
  readonly showWindowChooser?: () => Promise<void>;
  /** When using the native presentation transport, retain its lifecycle/events
   * with the connection. Existing injected fixture resources may omit it. */
  readonly presentation?: NativePresentationOwner;
  readonly recordingWindow?: DesktopRecordingWindow;
}
type Connection = Awaited<ReturnType<DesktopProviderMainHost["connect"]>>;
type Custody = Awaited<ReturnType<DesktopProviderResources["openCustody"]>>;
interface Mount {
  readonly abort: AbortController;
  readonly work: Set<Promise<unknown>>;
  opening?: Promise<AuthorizedProviderEncounter<DesktopProviderRecorder>>;
  store?: DurableDesktopRecordStore;
  custody?: Custody;
  releaseBackend?: () => Promise<void>;
  recorder?: DesktopProviderRecorder;
  recorderOpening: boolean;
  closing?: Promise<void>;
  removeAbort?: () => void;
  removeWindow?: () => void;
}

/** Trusted connection factory for the existing main host. It owns real encrypted
 * journals/flow/queue/coverage and composes the existing recorder/Core client.
 * No native identity, credential, key, grant, helper, picker or environment is
 * invented here. No audio source starts during connection or encounter opening.
 * Ownership of backend transfers on success; a rejected call leaves it to caller.
 */
export function createDesktopProviderConnection(backend: DesktopProviderBackend,
  resources: DesktopProviderResources, signal: AbortSignal): Connection {
  if (resources.enabled !== true || signal.aborted || backend.signal.aborted
    || typeof process === "undefined" || !process.versions.node || typeof window !== "undefined"
    || "type" in process && process.type === "renderer") throw unavailable();
  resources = Object.freeze({ ...resources, native: Object.freeze({ ...resources.native }) });
  const abort = new AbortController(), lifetime = AbortSignal.any([signal, backend.signal, abort.signal]);
  const work = new Set<Promise<unknown>>();
  let mount: Mount | undefined, transitioning = false, closing: Promise<void> | undefined, closed = false;
  const current = (operation?: AbortSignal): void => {
    if (closed || lifetime.aborted || operation?.aborted
      || resources.presentation && !resources.presentation.isHealthy()) throw unavailable();
  };
  const closeMount = (owned = mount): Promise<void> => {
    if (!owned) return Promise.resolve();
    owned.abort.abort();
    return owned.closing ??= (async () => {
      await owned.opening?.catch(() => undefined);
      await Promise.allSettled([...owned.work]);
      // Failed native stop retains store/key ownership and blocks replacement.
      await owned.recorder?.deactivate();
      owned.removeWindow?.(); delete owned.removeWindow; resources.recordingWindow?.update(null);
      await owned.releaseBackend?.();
      owned.store?.close();
      await owned.custody?.release();
      owned.removeAbort?.();
      delete owned.store; delete owned.custody; delete owned.recorder;
      if (mount === owned) mount = undefined;
    })().catch(error => { delete owned.closing; throw error; });
  };
  const dispose = (): Promise<void> => {
    if (closed) return Promise.resolve();
    abort.abort();
    return closing ??= (async () => {
      await Promise.allSettled([...work]);
      await closeMount();
      await resources.audioPreflight?.close();
      await resources.presentation?.dispose();
      await backend.dispose();
      removePresentation?.();
      lifetime.removeEventListener("abort", onAbort); closed = true;
    })().catch(error => { closing = undefined; throw error; });
  };
  const onAbort = (): void => { void dispose().catch(() => undefined); };
  const removePresentation = resources.presentation?.onEvent(event => {
    if (closed) return;
    if (event.kind === "failed") {
      // Notify the app even when idle so it can offer a fresh connection.
      // Normal disposal still retains custody after an unconfirmed source stop.
      abort.abort();
    } else if (mount && event.sessionId === mount.recorder?.snapshot.sessionId) {
      void mount.recorder.stopRecording().catch(() => undefined);
    }
  });
  lifetime.addEventListener("abort", onAbort, { once: true });
  const transition = async <T>(operation: AbortSignal, run: () => Promise<T>): Promise<T> => {
    current(operation); if (transitioning) throw unavailable();
    transitioning = true;
    try {
      return await track(work, async () => {
        await closeMount(); current(operation);
        const value = await run(); current(operation); return value;
      });
    } finally { transitioning = false; }
  };
  return { dispose, workspace: {
    signal: lifetime,
    ...(resources.audioPreflight ? { audioPreflight: async (operation: AbortSignal) => {
      current(operation); if (!mount || mount.recorder || mount.recorderOpening) throw unavailable();
      return resources.audioPreflight!.open(AbortSignal.any([lifetime, mount.abort.signal, operation]));
    } } : {}),
    listEncounters: operation => transition(operation, () => backend.listEncounters(AbortSignal.any([lifetime, operation]))),
    get encounterSetup() { return backend.encounterSetup; },
    get account() { return backend.account; },
    createEncounter: operation => transition(operation, () => backend.createEncounter(AbortSignal.any([lifetime, operation]))),
    openEncounter: (appointmentRef, operation) => transition(operation, async () => {
      if (!reference(appointmentRef, "appointment")) throw unavailable();
      const owned: Mount = { abort: new AbortController(), work: new Set(), recorderOpening: false };
      mount = owned;
      const mountSignal = AbortSignal.any([lifetime, operation, owned.abort.signal]);
      const cancel = (): void => { void closeMount(owned).catch(() => undefined); };
      mountSignal.addEventListener("abort", cancel, { once: true });
      owned.removeAbort = () => mountSignal.removeEventListener("abort", cancel);
      const check = (): void => { current(mountSignal); if (mount !== owned) throw unavailable(); };
      owned.opening = Promise.resolve().then(async () => {
        const opened = await backend.openEncounter(appointmentRef, mountSignal);
        if (opened.release) owned.releaseBackend = opened.release; check();
        if (opened.signal.aborted || opened.scope.appointmentRef !== appointmentRef || opened.encounter.appointmentRef !== appointmentRef
          || !reference(opened.scope.bindingRef, "scribe_capture_binding")) throw unavailable();
        const selected = { ...opened, recoveryScope: uuid(opened.recoveryScope),
          scope: Object.freeze({ ...opened.scope, workspaceId: uuid(opened.scope.workspaceId) }),
          encounter: Object.freeze({ ...opened.encounter }) };
        opened.signal.addEventListener("abort", cancel, { once: true });
        owned.removeAbort = () => {
          mountSignal.removeEventListener("abort", cancel); opened.signal.removeEventListener("abort", cancel);
        };
        owned.custody = await resources.openCustody({ recoveryScope: selected.recoveryScope,
          workspaceId: selected.scope.workspaceId }, mountSignal); check();
        owned.store = await DurableDesktopRecordStore.open({ directory: resources.directory,
          recoveryScope: selected.recoveryScope, workspaceId: selected.scope.workspaceId, key: owned.custody.key }); check();
        const records = desktopJournalRecords(owned.store.namespace("provider-journals"));
        const journal = new NativeProviderWorkspaceJournal(records, selected.recoveryScope, selected.scope);
        let admissionMetadata: { sessionId: string; key: string; nonce: string; value: unknown;
          receipt: Record<string, unknown>; complete: boolean; signal: AbortSignal } | undefined;
        let admissionGeneration = 0;
        let cleanAdmissionKey: string | undefined, cleanSessionKey: string | undefined;
        let freshWindow: DesktopInitialWindowOwner | undefined;
        const discardFresh = (): void => { freshWindow?.invalidate(); freshWindow = undefined; cleanAdmissionKey = undefined; cleanSessionKey = undefined; };
        mountSignal.addEventListener("abort", () => { admissionGeneration++; admissionMetadata = undefined; discardFresh(); }, { once: true });
        const guarded = <T>(run: () => Promise<T>): Promise<T> => track(owned.work, async () => {
          check(); const value = await run(); check(); return value;
        });
        const request: typeof selected.request = (path, body, key, operationSignal) => {
          const window = path === "/service/v1/agent/scribe/capture-operations" && record(body.operation)
            && body.operation.kind === "prepare_recording_window";
          const proof = window ? freshWindow?.take(body, key) : null;
          if (!window && path !== "/service/v1/agent/scribe/capture-admissions") freshWindow?.invalidate();
          return guarded(async () => {
          check();
          const linked = AbortSignal.any([mountSignal, operationSignal]);
          if (linked.aborted) throw unavailable();
          const admission = path === "/service/v1/agent/scribe/capture-admissions";
          if (admission && "preparation_metadata" in body) throw unavailable();
          const generation = admission ? ++admissionGeneration : admissionGeneration;
          let combine = false;
          if (admission) {
            admissionMetadata = undefined;
            freshWindow?.invalidate(); freshWindow = undefined; cleanSessionKey = undefined;
            // Only the already-journaled, deliberate first admission opts in.
            // Recovery, renewal and renderer-supplied options keep the old path.
            if (selected.admissionMetadataSupported && body.attestation !== null
              && Object.keys(body).sort().join(",") === "attestation,binding_ref,configured_capture,request_nonce,workspace_id") {
              const saved = (await journal.load()).progress; check();
              combine = saved?.sessionId === null && saved.admission?.key === key
                && canonical(body.attestation) === canonical(saved.admission.attestation)
                && canonical(body.configured_capture) === canonical({ schema_version: "1.0", language_mode: saved.admission.languageMode });
            }
          }
          check(); if (linked.aborted) throw unavailable();
          const value = proof && selected.sendFreshInitialWindow
            ? await selected.sendFreshInitialWindow(proof, body, key, linked)
            : await selected.request(path, combine ? { ...body, preparation_metadata: true } : body, key, linked);
          if (combine && value.status === 200) {
            if (value.headers.get("content-type")?.split(";", 1)[0] !== "application/json") throw unavailable();
            const result = await readBoundedJson(value, coreCaptureResponseLimit("capture-admissions"));
            check(); if (linked.aborted || generation !== admissionGeneration) throw unavailable();
            if (typeof result !== "object" || result === null || Array.isArray(result)) throw unavailable();
            const row = result as Record<string, unknown>;
            if (row.contract_version !== "1" || row.workspace_id !== selected.scope.workspaceId
              || row.binding_ref !== selected.scope.bindingRef || row.request_nonce !== body.request_nonce
              || row.appointment_ref !== selected.scope.appointmentRef || !reference(row.operation_ref, "scribe_admission")
              || typeof row.session_id !== "string" || typeof row.consent_record_id !== "string"
              || typeof row.checked_at !== "string" || !Number.isFinite(Date.parse(row.checked_at))
              || row.preparation_metadata === null || typeof row.preparation_metadata !== "object") throw unavailable();
            const sessionId = uuid(row.session_id); uuid(row.consent_record_id);
            const complete = Object.keys(row).sort().join(",") === "appointment_ref,binding_ref,checked_at,configured_capture,consent_record_id,contract_version,operation_ref,preparation_metadata,request_nonce,session_id,status,workspace_id"
              && row.status === "admitted" && canonical(row.configured_capture) === canonical(body.configured_capture);
            admissionMetadata = { sessionId, key, nonce: String(body.request_nonce), value: row.preparation_metadata,
              receipt: structuredClone(row), complete, signal: linked };
            linked.addEventListener("abort", () => {
              if (generation === admissionGeneration) { admissionGeneration++; admissionMetadata = undefined; discardFresh(); }
            }, { once: true });
            delete row.preparation_metadata;
            return Response.json(row, { headers: { "Cache-Control": "no-store" } });
          }
          check(); if (linked.aborted) throw unavailable(); return value;
          });
        };
        return {
          scope: selected.scope, encounter: selected.encounter, signal: mountSignal, request,
          ...(selected.signInPreparation ? { signInPreparation: {
            prepare: (signal: AbortSignal) => guarded(() => selected.signInPreparation!.prepare(AbortSignal.any([mountSignal, signal]))),
            abandon: () => selected.signInPreparation!.abandon(),
          } } : {}),
          ...(selected.noteOpeningSupported ? { noteOpeningSupported: true as const } : {}),
          ...(selected.openingReview ? { openingReview: selected.openingReview } : {}),
          ...(selected.openingRecovery ? { openingRecovery: selected.openingRecovery } : {}),
          playPassage: (sessionId, segmentId, operation) => guarded(async () => {
            uuid(sessionId); uuid(segmentId);
            const recorder = owned.recorder;
            const playbackCurrent = (): void => {
              check();
              if (operation.aborted || owned.recorderOpening || owned.recorder !== recorder
                || recorder && !["ready", "stopped"].includes(recorder.snapshot.desktop?.phase ?? "")) throw unavailable();
            };
            playbackCurrent();
            const saved = await journal.load(); playbackCurrent();
            if (saved.progress?.sessionId !== sessionId) throw unavailable();
            const client = new CoreCaptureClient(selected.scope, request, AbortSignal.any([mountSignal, operation]));
            const view = parseCreatorReview(await client.operation(sessionId, { kind: "creator_review" }), sessionId); playbackCurrent();
            const segment = view.source?.segments.find(item => item.source_segment_id === segmentId);
            if (!segment) return null;
            const archive = owned.store!.namespace(`playback:${sessionId}`);
            const key = await new DurableDesktopFlowStore(owned.store!.namespace("flow")).playbackKey(sessionId, owned.store!.namespace(`playback-key:${sessionId}`)); playbackCurrent();
            if (!key) return null;
            const wav = await passageWav(archive, sessionId, key, segment.start_ms, Math.min(segment.end_ms, segment.start_ms + 30_000), playbackCurrent,
              view.capture_continuity ?? undefined);
            if (!wav) return null;
            try { playbackCurrent(); return { wavBase64: Buffer.from(wav).toString("base64") }; }
            finally { wav.fill(0); }
          }),
          openInCore: noteRef => guarded(() => selected.openInCore(noteRef)),
          journal: { load: () => guarded(() => journal.load()), save: (previous, progress) => guarded(async () => {
            try {
              const saved = await journal.save(previous, progress); check();
              if (previous.revision === null && previous.progress === null && progress.sessionId === null && progress.admission) {
                cleanAdmissionKey = progress.admission.key; cleanSessionKey = undefined;
              } else if (progress.admission?.key === cleanAdmissionKey && previous.progress?.sessionId === null
                && canonical(previous.progress.admission) === canonical(progress.admission)
                && progress.sessionId === admissionMetadata?.sessionId && admissionMetadata?.key === cleanAdmissionKey
                && !progress.uploaded && progress.pendingSave === null) cleanSessionKey = cleanAdmissionKey;
              else discardFresh();
              return saved;
            } catch (error) { discardFresh(); throw error; }
          }) },
          editJournal: sessionId => {
            check(); uuid(sessionId);
            const edit = new NativeCreatorEditJournal(records, selected.recoveryScope, sessionId);
            return { load: () => guarded(() => edit.load()), save: value => guarded(() => edit.save(value)),
              clear: key => guarded(() => edit.clear(key)) };
          },
          reviewJournal: sessionId => {
            check(); uuid(sessionId);
            const review = new NativeCreatorReviewJournal(records, selected.recoveryScope, sessionId);
            return { load: () => guarded(() => review.load()), save: value => guarded(() => review.save(value)),
              clear: key => guarded(() => review.clear(key)) };
          },
          recorder: (sessionId, recorderSignal) => guarded(async () => {
            freshWindow?.invalidate(); freshWindow = undefined;
            uuid(sessionId);
            if (owned.recorderOpening || owned.recorder?.availableForView) throw unavailable();
            owned.recorderOpening = true;
            try {
              await owned.recorder?.deactivate();
              owned.removeWindow?.(); delete owned.removeWindow; resources.recordingWindow?.update(null); check();
              const saved = await journal.load(); check();
              if (saved.progress?.sessionId !== sessionId || recorderSignal.aborted) throw unavailable();
              const initialMetadata = admissionMetadata;
              admissionMetadata = undefined;
              const matchingMetadata = initialMetadata?.sessionId === sessionId
                && initialMetadata.key === saved.progress.admission?.key ? initialMetadata.value : undefined;
              const linked = AbortSignal.any([mountSignal, recorderSignal]);
              const inputRecords = owned.store!.namespace("recording-input");
              const inputKey = `audio-mode:${sessionId}`;
              const storedInput = await inputRecords.get(inputKey);
              let inputRevision = storedInput?.revision ?? null;
              let audioMode: "microphone" | "meeting" = saved.progress.admission?.attestation.modality === "virtual" ? "meeting" : "microphone";
              if (storedInput) {
                try {
                  const mode = new TextDecoder().decode(storedInput.data);
                  if (mode !== "meeting" && mode !== "microphone") throw unavailable();
                  audioMode = mode;
                } finally { storedInput.data.fill(0); }
              } else {
                // Existing desktop recordings keep their original combined input.
                const prior = await new DurableDesktopFlowStore(owned.store!.namespace("flow")).getActiveCaptureState(); check();
                if (prior) audioMode = "meeting";
              }
              const saveAudioMode = async (mode: "microphone" | "meeting") => {
                const bytes = new TextEncoder().encode(mode);
                try { inputRevision = await inputRecords.save(inputKey, inputRevision, bytes); check(); }
                finally { bytes.fill(0); }
              };
              if (!storedInput) await saveAudioMode(audioMode);
              const flow = new DurableDesktopFlowStore(owned.store!.namespace("flow"), {
                preparation: (prior, next) => freshWindow?.preparation(prior, next),
                newKey: state => freshWindow?.newKey(state), invalidate: () => freshWindow?.invalidate(),
              });
              const coverage = new DurableDesktopCoverage(owned.store!.namespace("coverage"), sessionId);
              let preparationBff: DesktopPreparationBff | undefined, preparationSignal: AbortSignal | undefined;
              const bff = (captureSignal: AbortSignal): DesktopPreparationBff => {
                if (preparationBff) {
                  if (preparationSignal !== captureSignal) throw unavailable();
                  return preparationBff;
                }
                preparationSignal = captureSignal;
                return preparationBff = new DesktopPreparationBff(new CoreCaptureClient(selected.scope, request, captureSignal), sessionId,
                  initialMetadata?.signal.aborted ? undefined : matchingMetadata);
              };
              await resources.audioPreflight?.close(); check();
              owned.recorder = await DesktopProviderRecorder.open({ enabled: true, uploadWhileRecording: true, prepareInBackground: resources.prepareInBackground === true, sessionId, audioMode, saveAudioMode, signal: linked,
                ...(resources.audioPreflight ? { audioInputs: resources.audioPreflight.inputs, autoReconnectMeeting: true,
                  meetingWindowChoices: () => resources.audioPreflight!.meetingWindowChoices,
                  selectedMeetingWindowId: () => resources.audioPreflight!.selectedMeetingWindowId } : {}),
                createBff: bff,
                authorizePreparation: async captureSignal => {
                  const retained = await Promise.allSettled([
                    flow.getActiveCaptureState(), flow.getPreparationState(), flow.getSessionKeyState(sessionId), coverage.load(),
                    owned.store!.namespace("flow").list(), owned.store!.namespace("coverage").list(),
                    owned.store!.namespace(`queue:${sessionId}`).list(),
                  ]);
                  const inventories = [retained[4], retained[5], retained[6]];
                  let empty: boolean;
                  try {
                    for (const result of retained) if (result.status === "rejected") throw result.reason;
                    check(); if (captureSignal.aborted) throw unavailable();
                    // Retained/crashed attempts keep their original read/replay path.
                    empty = retained.slice(0, 4).every(result => result.status === "fulfilled" && result.value === null)
                      && inventories.every(result => result.status === "fulfilled" && result.value.length === 0);
                  } finally {
                    for (const result of inventories) if (result.status === "fulfilled")
                      for (const record of result.value) record.data.fill(0);
                  }
                  const authorization = await bff(captureSignal).authorizePreparation(empty); check();
                  if (empty && authorization.status === "created" && !storedInput && selected.sendFreshInitialWindow
                    && initialMetadata?.complete && !initialMetadata.signal.aborted && !captureSignal.aborted
                    && initialMetadata.key === cleanAdmissionKey && initialMetadata.key === cleanSessionKey) {
                    freshWindow = new DesktopInitialWindowOwner(selected.scope, { key: initialMetadata.key,
                      nonce: initialMetadata.nonce, receipt: initialMetadata.receipt },
                    AbortSignal.any([linked, captureSignal, initialMetadata.signal]));
                  }
                  return authorization;
                },
                authorizeMount: (prepared, captureSignal) => selected.authorizeRecorder(prepared, captureSignal),
                ...(selected.readySourcePreparation ? { readySourcePreparation: selected.readySourcePreparation } : {}),
                authority: selected.authority, indicator: resources.indicator,
                retireSource: selected.retireSource,
                flowStore: flow, createSessionKey: flow.createSessionKey,
                storageCapacity: { availableBytes: async () => {
                  check(); const bytes = await owned.store!.availableBytes(); check(); return Math.floor(bytes / 2);
                } },
                queueStorage: new DurableDesktopQueueStorage(owned.store!.namespace(`queue:${sessionId}`), sessionId, async record => {
                  check(); const archive = owned.store!.namespace(`playback:${sessionId}`);
                  await flow.retainPlaybackKey(sessionId, owned.store!.namespace(`playback-key:${sessionId}`)); check();
                  await retainPassageAudio(archive, record); check();
                }),
                uploadTarget: selected.uploadTarget,
                coverage,
                native: { ...resources.native, getProcessFence: () => {
                  if (!selected.processFence) throw unavailable();
                  return selected.processFence();
                }, isSessionActive: () => !linked.aborted && resources.native.isSessionActive()
                  && (!resources.presentation || resources.presentation.isHealthy()) },
                selectWindow: resources.selectWindow,
                ...(resources.listMeetingWindows ? { listMeetingWindows: resources.listMeetingWindows } : {}),
                ...(resources.showWindowChooser ? { showWindowChooser: resources.showWindowChooser } : {}),
                // Journals still use the encounter store after recorder release.
                // closeMount owns its closure after every native stop is confirmed.
                release: () => Promise.resolve(),
              });
              if (resources.recordingWindow) {
                owned.removeWindow = owned.recorder.subscribe(snapshot => resources.recordingWindow!.update(snapshot));
              }
              check(); if (linked.aborted) throw unavailable(); return owned.recorder;
            } finally { owned.recorderOpening = false; }
          }),
        };
      });
      try { return await owned.opening; }
      catch (error) { await closeMount(owned); throw error; }
    }),
  } };
}

function track<T>(work: Set<Promise<unknown>>, run: () => Promise<T>): Promise<T> {
  const result = Promise.resolve().then(run); work.add(result);
  void result.finally(() => work.delete(result)).catch(() => undefined); return result;
}
function unavailable(): Error { return new Error("Desktop provider resources are unavailable."); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
