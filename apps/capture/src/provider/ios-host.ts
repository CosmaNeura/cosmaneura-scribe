import { NativeCreatorEditJournal } from "../../../review-ui/src/native-edit-journal";
import { Capacitor } from "@capacitor/core";
import { SecureQueue } from "@cosmaneura-scribe/capacitor-secure-queue";
import { NativeCreatorReviewJournal } from "../../../review-ui/src/native-review-journal";
import { acquireCaptureFlowLock } from "../flow/capture-lock";
import { parseAvailableStorageBytes } from "../flow/storage-capacity";
import { EncryptedIndexedDbFlowStore } from "../flow/encrypted-store";
import type { CiphertextUploadTarget } from "../bff/contracts";
import { QueueInvariantError } from "../queue/errors";
import { CaptureStopAcknowledgementPending } from "../capture/stop-confirmation";
import type { CaptureChunkMetadata, CaptureQueueStorage } from "../queue/types";
import { NativePluginQueueStorage, type NativeQueueRecordPlugin } from "../storage/native-plugin";
import { createProviderIOSCaptureSource } from "./ios-capture-source";
import { openIOSAudioPreflight } from "./ios-audio-preflight";
import type { PreparedProviderRecorder } from "../provider-binding";
import { connectNativeProviderRecorder, type NativeRecordingPort } from "./native-recorder";
import { CoreCaptureBff, CoreCaptureClient } from "./core-client";
import { NativeProviderWorkspaceJournal } from "./workspace-journal";
import type { AuthorizedProviderEncounter, ProviderRecorderResources, ProviderWorkspaceHost } from "./workspace";
import type { ConsentPreparationRelease } from "./consent-preparation";

/** Supplied by the existing authenticated Core/native connection, never by a form. */
export interface AuthorizedProviderIOSMount extends Omit<AuthorizedProviderEncounter, "journal" | "reviewJournal" | "recorder"> {
  /** Stable server-bound environment/creator UUID, retained across native restarts. */
  readonly recoveryScope: string;
  readonly uploadTarget: CiphertextUploadTarget;
  readonly nativeRecording?: NativeRecordingPort;
  /** Rechecks the selected creator, encounter, admission and session on the server. */
  readonly reauthorizeRecorder: (sessionId: string, signal: AbortSignal) => Promise<void>;
  readonly prepareNativeSource: (prepared: PreparedProviderIOSCapture, signal: AbortSignal) => Promise<void>;
  readonly releaseNativeSource: (sessionId: string) => Promise<void>;
}
export interface PreparedProviderIOSCapture {
  readonly sessionId: string;
  readonly leaseId: string;
  readonly leaseReceiptId: string;
  readonly leaseGeneration: number;
  readonly captureAuthorizedUntil: string;
  readonly firstSequenceNumber?: number;
}
export interface ProviderIOSBackend extends Pick<ProviderWorkspaceHost, "signal" | "listEncounters" | "createEncounter" | "encounterSetup" | "account" | "providerDisplayName" | "activeRecording"> {
  readonly openEncounter: (appointmentRef: string, signal: AbortSignal) => Promise<AuthorizedProviderIOSMount>;
}

/** Compose the real native recorder and recovery stores with the existing Core host.
 * This neither creates an identity nor substitutes a transport for Core authority.
 */
export function createProviderIOSHost(backend: ProviderIOSBackend, consentPreparation?: ConsentPreparationRelease): ProviderWorkspaceHost {
  requireNative();
  return {
    ...(consentPreparation ? { consentPreparation } : {}),
    get providerDisplayName() { return backend.signal.aborted ? undefined : backend.providerDisplayName; },
    get encounterSetup() { return backend.encounterSetup; },
    get account() { return backend.account; },
    signal: backend.signal,
    audioPreflight: signal => openIOSAudioPreflight(signal, undefined, backend.signal),
    ...(backend.activeRecording ? { activeRecording: signal => backend.activeRecording!(signal) } : {}),
    listEncounters: signal => backend.listEncounters(signal),
    createEncounter: signal => backend.createEncounter(signal),
    openEncounter: async (appointmentRef, signal) => {
      const opened = await backend.openEncounter(appointmentRef, signal);
      const current = (): void => {
        if (backend.signal.aborted || opened.signal.aborted || signal.aborted) throw unavailable();
      };
      current();
      uuid(opened.recoveryScope); uuid(opened.scope.workspaceId);
      if (opened.encounter.appointmentRef !== appointmentRef || opened.scope.appointmentRef !== appointmentRef) {
        throw unavailable();
      }
      // Copy the binding before any async store operation; later host object mutation
      // cannot silently select a different creator or workspace's retained data.
      const mount = { ...opened, scope: Object.freeze({ ...opened.scope }),
        encounter: Object.freeze({ ...opened.encounter }) };
      const journal = new NativeProviderWorkspaceJournal(SecureQueue, mount.recoveryScope, mount.scope);
      return {
        encounter: mount.encounter, scope: mount.scope, request: mount.request, signal: mount.signal,
        ...(mount.noteOpeningSupported ? { noteOpeningSupported: true as const } : {}),
        ...(mount.recorderRechecksReview === true ? { recorderRechecksReview: true as const } : {}),
        ...(mount.openingReview ? { openingReview: mount.openingReview } : {}),
        openInCore: noteRef => { current(); return mount.openInCore(noteRef); },
        journal,
        editJournal: sessionId => {
          current();
          const edit = new NativeCreatorEditJournal(SecureQueue, mount.recoveryScope, sessionId);
          const guarded = async <T>(run: () => Promise<T>): Promise<T> => { current(); const value = await run(); current(); return value; };
          return { load: () => guarded(() => edit.load()), save: value => guarded(() => edit.save(value)),
            clear: key => guarded(() => edit.clear(key)) };
        },
        reviewJournal: sessionId => {
          current(); return new NativeCreatorReviewJournal(SecureQueue, mount.recoveryScope, sessionId);
        },
        recorder: (sessionId, recorderSignal) => openRecorder(mount, sessionId, recorderSignal, current),
      };
    },
  };
}

async function openRecorder(mount: AuthorizedProviderIOSMount, sessionId: string, signal: AbortSignal,
  currentEncounter: () => void): Promise<ProviderRecorderResources | PreparedProviderRecorder> {
  uuid(sessionId); requireNative();
  const current = (): void => {
    currentEncounter();
    if (signal.aborted) throw unavailable();
  };
  current();
  const unlock = await acquireCaptureFlowLock();
  let flow: EncryptedIndexedDbFlowStore | undefined;
  try {
    current();
    // Opening a scoped encrypted store does not read recording custody or start
    // a source. Overlap only that setup with fresh authorization, and settle
    // both handles before cleanup so cancellation cannot leak a late store.
    const [authorization, opened] = await Promise.allSettled([
      mount.reauthorizeRecorder(sessionId, signal),
      EncryptedIndexedDbFlowStore.open({
        databaseName: `scribe-provider-flow:v1:${mount.recoveryScope}:${mount.scope.workspaceId}`,
      }),
    ]);
    if (opened.status === "fulfilled") flow = opened.value;
    readResult(authorization);
    flow = readResult(opened);
    current();
    // These independent read-only checks share the same exclusive flow lock and
    // fresh authorization. Join every read before releasing the store on failure;
    // preserve the original validation order when inspecting their results.
    const [activeRead, preparingRead, keyStateRead, legacyKeyRead] = await Promise.allSettled([
      flow.getActiveCaptureState(), flow.getPreparationState(),
      flow.getSessionKeyState(sessionId), flow.getSessionKey(sessionId),
    ]);
    const active = readResult(activeRead);
    const preparing = readResult(preparingRead);
    current();
    if (active && (active.sessionId !== sessionId || active.reviewAfterUpload !== true)
      || preparing && (preparing.sessionId !== sessionId || preparing.mode !== "configured_core")) {
      throw new QueueInvariantError("provider_saved_session_changed");
    }
    const nativeQueue = scopedQueue(SecureQueue, mount.recoveryScope, mount.scope.workspaceId, sessionId);
    // Native key custody is selected only for new recordings. Existing browser
    // keys/intents stay with their original flow; never replace or rebind them.
    const keyState = readResult(keyStateRead);
    const legacyKey = readResult(legacyKeyRead);
    current();
    if (mount.nativeRecording && !active && !preparing && !keyState && !legacyKey) {
      const ownedFlow = flow;
      const native = await connectNativeProviderRecorder({ sessionId, port: mount.nativeRecording,
        bff: new CoreCaptureBff(new CoreCaptureClient(mount.scope, mount.request, signal), sessionId),
        queueStorage: nativeQueue, uploadTarget: mount.uploadTarget, signal });
      let released = false, releasing: Promise<void> | null = null;
      // Always hand late acquisitions to workspace teardown. Retain this lock
      // until native source cessation confirms, including explicit retry.
      return { ...native, deactivate: () => {
        if (released) return Promise.resolve();
        return releasing ??= (async () => {
          try { await native.deactivate(); ownedFlow.close(); await unlock(); released = true; }
          catch (error) { releasing = null; throw error; }
        })();
      } };
    }
    const source = createProviderIOSCaptureSource(); // No permission request or recording.
    // Verify custody now, then hand that exact read to restore under the same
    // exclusive flow lock. A get/write consumes it; later lists always reread.
    const openingQueue = reuseOpeningRead(nativeQueue, await nativeQueue.listMetadata(), current);
    const queueStorage = openingQueue.storage;
    current();
    const ownedFlow = flow;
    let closed = false, closing: Promise<void> | null = null;
    let stopping: Promise<void> | null = null;
    const stopSource = (): Promise<void> => stopping ??= (async () => {
      await source.stop();
      try { await mount.releaseNativeSource(sessionId); }
      catch { throw new CaptureStopAcknowledgementPending(); }
    })().finally(() => { stopping = null; });
    const release = (): Promise<void> => {
      openingQueue.discard();
      if (closed) return Promise.resolve();
      return closing ??= (async () => {
        try {
          // Even an early/mistaken release cannot drop ownership of an unconfirmed
          // native stop. Retain the same source and lock for the explicit retry.
          await stopSource();
          ownedFlow.close(); await unlock(); closed = true;
        } catch (error) { closing = null; throw error; }
      })();
    };
    return {
      source: { kind: source.kind, start: async options => {
        current(); if (closed || closing || stopping || options.signal?.aborted) throw unavailable();
        const active = await ownedFlow.getActiveCaptureState(); current();
        if (!active || active.phase !== "recording" || active.sessionId !== sessionId
          // Version 2 flow records implicitly carry the microphone channel.
          || (active.channel ?? "microphone") !== "microphone" || active.reviewAfterUpload !== true
          || active.lease.session_id !== sessionId || active.captureAuthorizedUntil === null
          || !Number.isFinite(Date.parse(active.captureAuthorizedUntil))
          || Date.parse(active.captureAuthorizedUntil) <= Date.now()
          || Date.parse(active.captureAuthorizedUntil) > Date.parse(active.lease.expires_at)) throw unavailable();
        const prepared = Object.freeze({ sessionId, leaseId: uuid(active.lease.lease_id),
          leaseReceiptId: uuid(active.lease.receipt_id), leaseGeneration: active.lease.generation,
          captureAuthorizedUntil: active.captureAuthorizedUntil,
          ...(active.continuation?.firstSequenceNumber ? { firstSequenceNumber: active.continuation.firstSequenceNumber } : {}) });
        await mount.prepareNativeSource(prepared, signal); current();
        const checked = await ownedFlow.getActiveCaptureState(); current();
        if (closed || closing || options.signal?.aborted || !checked || checked.phase !== "recording"
          || checked.sessionId !== sessionId || (checked.channel ?? "microphone") !== "microphone"
          || checked.lease.lease_id !== prepared.leaseId
          || checked.lease.receipt_id !== prepared.leaseReceiptId
          || checked.lease.generation !== prepared.leaseGeneration
          || (checked.continuation?.firstSequenceNumber ?? 0) !== (prepared.firstSequenceNumber ?? 0)
          || checked.captureAuthorizedUntil !== prepared.captureAuthorizedUntil) throw unavailable();
        return source.start(options);
      }, stop: stopSource },
      flowStore: ownedFlow, queueStorage, uploadTarget: mount.uploadTarget, release,
      storageCapacity: { availableBytes: async () => {
        current(); const result = await SecureQueue.getStorageCapacity(); current();
        return parseAvailableStorageBytes(result.availableBytes);
      } },
    };
  } catch (error) {
    // Setup cannot start the source. Preserve stored work while closing only the
    // failed acquisition's handles, including after cancellation during open().
    flow?.close(); await unlock(); throw error;
  }
}

function readResult<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

function reuseOpeningRead(storage: CaptureQueueStorage, records: readonly CaptureChunkMetadata[],
  current: () => void): { storage: CaptureQueueStorage; discard: () => void } {
  let first: readonly CaptureChunkMetadata[] | null = records;
  const discard = (): void => { first = null; };
  return { discard, storage: {
    create: record => { discard(); current(); return storage.create(record); },
    get: objectId => { discard(); current(); return storage.get(objectId); },
    compareAndSwap: (objectId, revision, replacement) => {
      discard(); current(); return storage.compareAndSwap(objectId, revision, replacement);
    },
    list: () => { discard(); current(); return storage.list(); },
    listMetadata: async () => {
      current(); const verified = first; discard();
      return verified ?? storage.listMetadata();
    },
  } };
}

function scopedQueue(plugin: NativeQueueRecordPlugin, recoveryScope: string, workspaceId: string,
  sessionId: string): CaptureQueueStorage {
  const prefix = `scribe-provider-queue:v1:${uuid(recoveryScope)}:${uuid(workspaceId)}:${uuid(sessionId)}:`;
  const key = (objectId: string): string => prefix + uuid(objectId);
  const storage = new NativePluginQueueStorage({
    create: record => plugin.create({ ...record, key: key(record.key) }),
    compareAndSwap: record => plugin.compareAndSwap({ ...record, key: key(record.key) }),
    get: async record => {
      const expected = key(record.key), result = await plugin.get({ key: expected });
      if (result.key !== expected) throw unavailable();
      return { ...result, key: record.key };
    },
    list: async () => {
      const result = await plugin.list();
      if (!Array.isArray(result.keys) || result.keys.some(value => typeof value !== "string")) throw unavailable();
      // Never fetch or decode another creator/session's record or legacy namespace.
      const keys = result.keys.filter(value => value.startsWith(prefix)).map(value => uuid(value.slice(prefix.length)));
      if (new Set(keys).size !== keys.length) throw unavailable();
      return { keys };
    },
  });
  const checked = <T extends CaptureChunkMetadata>(record: T): T => {
    if (record.reservation.sessionId !== sessionId) throw unavailable();
    return record;
  };
  return {
    create: record => storage.create(checked(record)),
    get: async objectId => { const record = await storage.get(objectId); return record && checked(record); },
    list: async () => (await storage.list()).map(checked),
    listMetadata: async () => (await storage.listMetadata()).map(checked),
    compareAndSwap: (objectId, revision, replacement) => storage.compareAndSwap(objectId, revision, checked(replacement)),
  };
}

function requireNative(): void {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios"
    || !Capacitor.isPluginAvailable("IOSPCM") || !Capacitor.isPluginAvailable("SecureQueue")) {
    throw new QueueInvariantError("provider_native_host_unavailable");
  }
}
function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) throw unavailable();
  return value;
}
function unavailable(): QueueInvariantError { return new QueueInvariantError("provider_native_scope_unavailable"); }
