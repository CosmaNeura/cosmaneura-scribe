import type { DesktopRecordingWindow } from "./recording-window.js";
import type { ProviderWorkspaceHost, AuthorizedProviderEncounter } from "../../capture/src/provider/workspace-contracts";
import { CoreCaptureBff, CoreCaptureClient, reference } from "../../capture/src/provider/core-client";
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

export interface AuthorizedDesktopProviderMount extends Omit<AuthorizedProviderEncounter,
  "journal" | "reviewJournal" | "recorder"> {
  readonly recoveryScope: string;
  readonly release?: () => Promise<void>;
  readonly uploadTarget: CiphertextUploadTarget;
  /** Backend-issued authority. A session/capabilities receipt is insufficient. */
  readonly retireSource: () => Promise<void>;
  readonly authorizeRecorder: (prepared: PreparedDesktopCapture, signal: AbortSignal) => ReturnType<DesktopProviderRecorderOptions["authorizeMount"]>;
  readonly authority: DesktopProviderRecorderOptions["authority"];
  readonly processFence?: DesktopProviderRecorderOptions["native"]["getProcessFence"];
}
export interface DesktopProviderBackend extends Pick<ProviderWorkspaceHost, "signal" | "listEncounters" | "createEncounter" | "encounterSetup" | "account"> {
  readonly openEncounter: (appointmentRef: string, signal: AbortSignal) => Promise<AuthorizedDesktopProviderMount>;
  dispose(): Promise<void>;
}
export interface DesktopProviderResources {
  readonly enabled?: boolean;
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
  readonly selectWindow: DesktopProviderRecorderOptions["selectWindow"];
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
        const guarded = <T>(run: () => Promise<T>): Promise<T> => track(owned.work, async () => {
          check(); const value = await run(); check(); return value;
        });
        const request: typeof selected.request = (path, body, key, operationSignal) => guarded(async () => {
          check();
          const linked = AbortSignal.any([mountSignal, operationSignal]);
          if (linked.aborted) throw unavailable();
          const value = await selected.request(path, body, key, linked);
          check(); if (linked.aborted) throw unavailable(); return value;
        });
        return {
          scope: selected.scope, encounter: selected.encounter, signal: mountSignal, request,
          ...(selected.noteOpeningSupported ? { noteOpeningSupported: true as const } : {}),
          ...(selected.openingReview ? { openingReview: selected.openingReview } : {}),
          openInCore: noteRef => guarded(() => selected.openInCore(noteRef)),
          journal: { load: () => guarded(() => journal.load()), save: (previous, progress) => guarded(() => journal.save(previous, progress)) },
          reviewJournal: sessionId => {
            check(); uuid(sessionId);
            const review = new NativeCreatorReviewJournal(records, selected.recoveryScope, sessionId);
            return { load: () => guarded(() => review.load()), save: value => guarded(() => review.save(value)),
              clear: key => guarded(() => review.clear(key)) };
          },
          recorder: (sessionId, recorderSignal) => guarded(async () => {
            uuid(sessionId);
            if (owned.recorderOpening || owned.recorder?.availableForView) throw unavailable();
            owned.recorderOpening = true;
            try {
              await owned.recorder?.deactivate();
              owned.removeWindow?.(); delete owned.removeWindow; resources.recordingWindow?.update(null); check();
              const saved = await journal.load(); check();
              if (saved.progress?.sessionId !== sessionId || recorderSignal.aborted) throw unavailable();
              const linked = AbortSignal.any([mountSignal, recorderSignal]);
              const flow = new DurableDesktopFlowStore(owned.store!.namespace("flow"));
              owned.recorder = await DesktopProviderRecorder.open({ enabled: true, uploadWhileRecording: true, sessionId, signal: linked,
                createBff: captureSignal => new CoreCaptureBff(new CoreCaptureClient(selected.scope, request, captureSignal), sessionId),
                authorizePreparation: async captureSignal => {
                  const client = new CoreCaptureClient(selected.scope, request, captureSignal);
                  const view = parseCreatorReview(await client.operation(sessionId, { kind: "creator_review" }), sessionId);
                  return { sessionId: view.session_id, status: view.status };
                },
                authorizeMount: (prepared, captureSignal) => selected.authorizeRecorder(prepared, captureSignal),
                authority: selected.authority, indicator: resources.indicator,
                retireSource: selected.retireSource,
                flowStore: flow, createSessionKey: flow.createSessionKey,
                storageCapacity: { availableBytes: async () => {
                  check(); const bytes = await owned.store!.availableBytes(); check(); return bytes;
                } },
                queueStorage: new DurableDesktopQueueStorage(owned.store!.namespace(`queue:${sessionId}`), sessionId),
                uploadTarget: selected.uploadTarget,
                coverage: new DurableDesktopCoverage(owned.store!.namespace("coverage"), sessionId),
                native: { ...resources.native, getProcessFence: () => {
                  if (!selected.processFence) throw unavailable();
                  return selected.processFence();
                }, isSessionActive: () => !linked.aborted && resources.native.isSessionActive()
                  && (!resources.presentation || resources.presentation.isHealthy()) },
                selectWindow: resources.selectWindow,
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
