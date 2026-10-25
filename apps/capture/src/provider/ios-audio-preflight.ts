import { IOSPCM } from "../native/capacitor-pcm";
import { QueueInvariantError } from "../queue/errors";
import type { AudioInputDevice, AudioPreflightSnapshot, ProviderAudioPreflight } from "./audio-preflight";

export interface IOSMicrophoneCheckPlugin {
  beginMicrophoneCheck(this: void): Promise<unknown>;
  requestRecordingAccess(this: void): Promise<unknown>;
  readMicrophoneCheck(this: void): Promise<unknown>;
  selectMicrophoneDevice(this: void, request: { id: string }): Promise<unknown>;
  endMicrophoneCheck(this: void): Promise<unknown>;
}
const nativeCheck = IOSPCM as unknown as IOSMicrophoneCheckPlugin;

/** Native catalogue and permission metadata only. No automatic permission
 * request or audio sampling; a deliberate access action is fenced at both ends. */
export async function openIOSAudioPreflight(signal: AbortSignal,
  plugin: IOSMicrophoneCheckPlugin = nativeCheck, inheritedSignal?: AbortSignal): Promise<ProviderAudioPreflight> {
  let closed = false, closing: Promise<void> | null = null, timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(snapshot: AudioPreflightSnapshot) => void>();
  let generation = 0, selecting = false, requesting = false, recovering = false, recoveryAttempted = false;
  let wasVisible = document.visibilityState === "visible", cancelAccessRecovery: (() => void) | undefined;
  let operations: Promise<void> = Promise.resolve();
  let snapshot: AudioPreflightSnapshot = { status: "checking", inputDevices: [], selectedInputId: null, microphone: null };
  const active = (): boolean => !closed && !signal.aborted && !inheritedSignal?.aborted;
  const current = (): void => { if (!active()) throw unavailable(); };
  const visibleCurrent = (): void => { current(); if (document.visibilityState !== "visible") throw unavailable(); };
  const accepted = (observed: number): boolean => active() && observed === generation && document.visibilityState === "visible";
  const notify = (): void => {
    for (const listener of listeners) { try { listener(snapshot); } catch { /* Observer isolation. */ } }
  };
  const unavailableSnapshot = (): void => { snapshot = { ...snapshot, status: "unavailable", microphone: null }; notify(); };
  const publish = (value: unknown, observed: number): void => {
    visibleCurrent(); if (observed !== generation) throw unavailable();
    snapshot = parseIOSAudioPreflight(value);
    if (snapshot.status === "ready" || snapshot.status === "permission_required") recoveryAttempted = false;
    notify();
  };
  // Serialize native metadata work, including reads. Invalid queued work never
  // dispatches, and close joins every dispatched begin before the final end.
  const operate = (operation: () => Promise<unknown>, observed: number): Promise<unknown> => {
    const result = operations.then(() => {
      visibleCurrent(); if (observed !== generation) throw unavailable();
      return operation();
    });
    operations = result.then(() => undefined, () => undefined);
    return result;
  };
  const visibilityChanged = (): void => {
    const visible = document.visibilityState === "visible";
    if (visible === wasVisible || !active()) return;
    wasVisible = visible; generation++; cancelAccessRecovery?.();
    if (visible) recoveryAttempted = false;
    unavailableSnapshot();
  };
  const close = (): Promise<void> => {
    closed = true; generation++; cancelAccessRecovery?.(); snapshot = { ...snapshot, status: "unavailable", microphone: null };
    clearTimeout(timer); listeners.clear(); signal.removeEventListener("abort", aborted);
    inheritedSignal?.removeEventListener("abort", aborted);
    document.removeEventListener("visibilitychange", visibilityChanged);
    return closing ??= operations.then(() => plugin.endMicrophoneCheck()).then(() => undefined)
      .catch(error => { closing = null; throw error; });
  };
  const aborted = (): void => { void close().catch(() => undefined); };
  signal.addEventListener("abort", aborted, { once: true });
  inheritedSignal?.addEventListener("abort", aborted, { once: true });
  document.addEventListener("visibilitychange", visibilityChanged);
  const recover = async (): Promise<void> => {
    visibleCurrent();
    if (selecting || requesting || recovering || recoveryAttempted || snapshot.status !== "unavailable") return;
    recovering = true; recoveryAttempted = true; const restarted = ++generation;
    snapshot = { ...snapshot, status: "checking", microphone: null }; notify();
    try { publish(await operate(() => plugin.beginMicrophoneCheck(), restarted), restarted); }
    catch { if (accepted(restarted)) unavailableSnapshot(); }
    finally { recovering = false; }
  };
  // UIKit can end the metadata owner for the permission sheet while the web
  // document remains visible. Finish only this deliberate action with a fresh
  // advisory recheck; never replay the OS permission request or end an owner.
  const afterPermissionFailure = async (observed: number): Promise<boolean> => {
    const deadline = performance.now() + 5000;
    recoveryAttempted = true;
    const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
      let cancel!: () => void, timeout: ReturnType<typeof setTimeout> | undefined;
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => reject(unavailable()); cancelAccessRecovery = cancel;
        timeout = setTimeout(cancel, Math.max(0, deadline - performance.now()));
      });
      try { return await Promise.race([operation(), cancelled]); }
      finally { clearTimeout(timeout); if (cancelAccessRecovery === cancel) cancelAccessRecovery = undefined; }
    };
    const fresh = (): void => { if (!accepted(observed) || performance.now() >= deadline) throw unavailable(); };
    const read = (operation: () => Promise<unknown>): Promise<unknown> => bounded(() => operate(() => {
      fresh(); return operation();
    }, observed));
    for (let attempt = 0; attempt < 20 && accepted(observed); attempt++) {
      let delay: ReturnType<typeof setTimeout> | undefined;
      try {
        await bounded(() => new Promise<void>(resolve => { delay = setTimeout(resolve, 250); }));
        fresh();
        let value = await read(() => plugin.readMicrophoneCheck()); fresh();
        if (parseIOSAudioPreflight(value).status === "unavailable") {
          value = await read(() => plugin.beginMicrophoneCheck()); fresh();
        }
        const status = parseIOSAudioPreflight(value).status;
        if (status === "ready" || status === "permission_required") { publish(value, observed); return true; }
      } catch (error) {
        if (!nativePreparationFailed(error)) return false;
      } finally { clearTimeout(delay); }
    }
    return false;
  };
  try {
    current(); const opened = generation; publish(await operate(() => plugin.beginMicrophoneCheck(), opened), opened);
    const poll = async (): Promise<void> => {
      visibilityChanged(); const observed = generation;
      try {
        current();
        if (!selecting && !requesting && !recovering && document.visibilityState === "visible") {
          const value = await operate(() => plugin.readMicrophoneCheck(), observed);
          if (!selecting && !requesting && !recovering && accepted(observed)) publish(value, observed);
        }
      } catch {
        if (!selecting && !requesting && !recovering && accepted(observed)) unavailableSnapshot();
      }
      if (active() && document.visibilityState === "visible" && !selecting && !requesting && !recovering) await recover();
      if (active()) timer = setTimeout(() => { void poll(); }, 250);
    };
    timer = setTimeout(() => { void poll(); }, 250);
    return { getSnapshot: () => snapshot, subscribe: listener => {
      current(); listeners.add(listener); listener(snapshot); return () => listeners.delete(listener);
    }, requestRecordingAccess: async () => {
      visibleCurrent(); if (selecting || requesting || recovering) throw unavailable();
      requesting = true; const requested = ++generation;
      snapshot = { ...snapshot, status: "checking", microphone: null }; notify();
      try { publish(await operate(() => plugin.requestRecordingAccess(), requested), requested); }
      catch (error) {
        if (accepted(requested) && nativePreparationFailed(error) && await afterPermissionFailure(requested)) return;
        if (accepted(requested)) unavailableSnapshot(); throw error;
      }
      finally { requesting = false; }
    }, selectMicrophone: async id => {
      visibleCurrent(); if (selecting || requesting || recovering || !snapshot.inputDevices.some(device => device.id === id)) throw unavailable();
      selecting = true; const selected = ++generation;
      try {
        publish(await operate(() => plugin.selectMicrophoneDevice({ id }), selected), selected);
        if (snapshot.selectedInputId !== id) throw unavailable();
      } finally { selecting = false; }
    }, close };
  } catch (error) { await close(); throw error; }
}

export function parseAudioInputDevices(value: unknown): readonly AudioInputDevice[] {
  if (!Array.isArray(value) || value.length > 32) throw unavailable();
  const seen = new Set<string>();
  const devices = value.map(raw => {
    const data = exact(raw, ["id", "label", "kind", "current"]);
    if (typeof data.id !== "string" || !data.id || data.id.length > 512 || seen.has(data.id)
      || typeof data.label !== "string" || !data.label || data.label.length > 512
      || !["built_in", "bluetooth", "external", "unknown"].includes(String(data.kind))
      || typeof data.current !== "boolean") throw unavailable();
    seen.add(data.id); return Object.freeze({ ...data }) as unknown as AudioInputDevice;
  });
  if (devices.filter(device => device.current).length > 1) throw unavailable();
  return Object.freeze(devices);
}
export function parseIOSAudioPreflight(value: unknown): AudioPreflightSnapshot {
  const data = exact(value, ["version", "status", "inputDevices", "selectedInputId", "microphone"]);
  if (data.version !== 1 || !["checking", "ready", "permission_required", "unavailable"].includes(String(data.status))) throw unavailable();
  const inputDevices = parseAudioInputDevices(data.inputDevices);
  // Preparation selects a next-start UID without activating the input. The
  // `current` flags still describe the actual route; capture validates it later.
  if (data.selectedInputId !== null && (typeof data.selectedInputId !== "string"
    || !inputDevices.some(device => device.id === data.selectedInputId))) throw unavailable();
  if (data.selectedInputId === null && inputDevices.some(device => device.current)) throw unavailable();
  if (data.microphone !== null) throw unavailable();
  return Object.freeze({ status: data.status as AudioPreflightSnapshot["status"], inputDevices,
    selectedInputId: data.selectedInputId, microphone: null });
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw unavailable();
  return value as Record<string, unknown>;
}
function unavailable(): QueueInvariantError { return new QueueInvariantError("provider_microphone_check_unavailable"); }

function nativePreparationFailed(value: unknown): boolean {
  return !!value && typeof value === "object" && "code" in value && value.code === "ios_capture_failed";
}
