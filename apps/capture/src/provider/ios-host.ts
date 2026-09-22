import { Capacitor } from "@capacitor/core";
import { SecureQueue } from "@cosmaneura-scribe/capacitor-secure-queue";
import { NativeCreatorReviewJournal } from "../../../review-ui/src/native-review-journal";
import { acquireCaptureFlowLock } from "../flow/capture-lock";
import { EncryptedIndexedDbFlowStore } from "../flow/encrypted-store";
import type { CiphertextUploadTarget } from "../bff/contracts";
import { QueueInvariantError } from "../queue/errors";
import type { CaptureChunkRecord, CaptureQueueStorage } from "../queue/types";
import { NativePluginQueueStorage, type NativeQueueRecordPlugin } from "../storage/native-plugin";
import { createProviderIOSCaptureSource } from "./ios-capture-source";
import { NativeProviderWorkspaceJournal } from "./workspace-journal";
import type { AuthorizedProviderEncounter, ProviderRecorderResources, ProviderWorkspaceHost } from "./workspace";

/** Supplied by the existing authenticated Core/native connection, never by a form. */
export interface AuthorizedProviderIOSMount extends Omit<AuthorizedProviderEncounter, "journal" | "reviewJournal" | "recorder"> {
  /** Stable server-bound environment/creator UUID, retained across native restarts. */
  readonly recoveryScope: string;
  readonly uploadTarget: CiphertextUploadTarget;
  /** Rechecks the selected creator, encounter, admission and session on the server. */
  readonly reauthorizeRecorder: (sessionId: string, signal: AbortSignal) => Promise<void>;
}
export interface ProviderIOSBackend extends Pick<ProviderWorkspaceHost, "signal" | "listEncounters" | "createEncounter"> {
  readonly openEncounter: (appointmentRef: string, signal: AbortSignal) => Promise<AuthorizedProviderIOSMount>;
}

/** Compose the real native recorder and recovery stores with the existing Core host.
 * This neither creates an identity nor substitutes a transport for Core authority.
 */
export function createProviderIOSHost(backend: ProviderIOSBackend): ProviderWorkspaceHost {
  requireNative();
  return {
    signal: backend.signal,
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
        openInCore: noteRef => { current(); return mount.openInCore(noteRef); },
        journal,
        reviewJournal: sessionId => {
          current(); return new NativeCreatorReviewJournal(SecureQueue, mount.recoveryScope, sessionId);
        },
        recorder: (sessionId, recorderSignal) => openRecorder(mount, sessionId, recorderSignal, current),
      };
    },
  };
}

async function openRecorder(mount: AuthorizedProviderIOSMount, sessionId: string, signal: AbortSignal,
  currentEncounter: () => void): Promise<ProviderRecorderResources> {
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
    await mount.reauthorizeRecorder(sessionId, signal);
    current();
    const source = createProviderIOSCaptureSource(); // No permission request or recording.
    flow = await EncryptedIndexedDbFlowStore.open({
      databaseName: `scribe-provider-flow:v1:${mount.recoveryScope}:${mount.scope.workspaceId}`,
    });
    current();
    const active = await flow.getActiveCaptureState();
    const preparing = await flow.getPreparationState();
    current();
    if (active && (active.sessionId !== sessionId || active.reviewAfterUpload !== true)
      || preparing && (preparing.sessionId !== sessionId || preparing.mode !== "configured_core")) {
      throw new QueueInvariantError("provider_saved_session_changed");
    }
    const queueStorage = scopedQueue(SecureQueue, mount.recoveryScope, mount.scope.workspaceId, sessionId);
    await queueStorage.list(); // Verify native custody and retained records before returning a recorder.
    current();
    const ownedFlow = flow;
    let closed = false, closing: Promise<void> | null = null;
    const release = (): Promise<void> => {
      if (closed) return Promise.resolve();
      return closing ??= (async () => {
        try {
          // Even an early/mistaken release cannot drop ownership of an unconfirmed
          // native stop. Retain the same source and lock for the explicit retry.
          await source.stop();
          ownedFlow.close(); await unlock(); closed = true;
        } catch (error) { closing = null; throw error; }
      })();
    };
    return {
      source: { kind: source.kind, start: options => {
        current(); if (closed || closing) throw unavailable(); return source.start(options);
      }, stop: () => source.stop() },
      flowStore: ownedFlow, queueStorage, uploadTarget: mount.uploadTarget, release,
    };
  } catch (error) {
    // Setup cannot start the source. Preserve stored work while closing only the
    // failed acquisition's handles, including after cancellation during open().
    flow?.close(); await unlock(); throw error;
  }
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
  const checked = <T extends CaptureChunkRecord>(record: T): T => {
    if (record.reservation.sessionId !== sessionId) throw unavailable();
    return record;
  };
  return {
    create: record => storage.create(checked(record)),
    get: async objectId => { const record = await storage.get(objectId); return record && checked(record); },
    list: async () => (await storage.list()).map(checked),
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
