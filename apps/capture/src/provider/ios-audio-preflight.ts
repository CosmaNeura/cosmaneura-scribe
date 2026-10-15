import { IOSPCM } from "../native/capacitor-pcm";
import { QueueInvariantError } from "../queue/errors";
import type { AudioInputDevice, AudioPreflightSnapshot, ProviderAudioPreflight } from "./audio-preflight";

export interface IOSMicrophoneCheckPlugin {
  beginMicrophoneCheck(this: void): Promise<unknown>;
  readMicrophoneCheck(this: void): Promise<unknown>;
  selectMicrophoneDevice(this: void, request: { id: string }): Promise<unknown>;
  endMicrophoneCheck(this: void): Promise<unknown>;
}
const nativeCheck = IOSPCM as unknown as IOSMicrophoneCheckPlugin;

/** Native RMS metadata only; this path cannot create a capture session, grant,
 * key, audio packet or queue row. A late permission result is fenced natively. */
export async function openIOSAudioPreflight(signal: AbortSignal,
  plugin: IOSMicrophoneCheckPlugin = nativeCheck, inheritedSignal?: AbortSignal): Promise<ProviderAudioPreflight> {
  let closed = false, closing: Promise<void> | null = null, timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(snapshot: AudioPreflightSnapshot) => void>();
  let generation = 0, selecting = false;
  let snapshot: AudioPreflightSnapshot = { status: "checking", inputDevices: [], selectedInputId: null, microphone: null };
  const current = (): void => { if (closed || signal.aborted || inheritedSignal?.aborted) throw unavailable(); };
  const publish = (value: unknown): void => {
    current(); snapshot = parseIOSAudioPreflight(value);
    for (const listener of listeners) { try { listener(snapshot); } catch { /* Observer isolation. */ } }
  };
  const close = (): Promise<void> => {
    closed = true; generation++; snapshot = { ...snapshot, status: "unavailable", microphone: null };
    clearTimeout(timer); listeners.clear(); signal.removeEventListener("abort", aborted);
    inheritedSignal?.removeEventListener("abort", aborted);
    return closing ??= plugin.endMicrophoneCheck().then(() => undefined).catch(error => { closing = null; throw error; });
  };
  const aborted = (): void => { void close().catch(() => undefined); };
  signal.addEventListener("abort", aborted, { once: true });
  inheritedSignal?.addEventListener("abort", aborted, { once: true });
  try {
    current(); publish(await plugin.beginMicrophoneCheck());
    const poll = async (): Promise<void> => {
      const observed = generation;
      try {
        current();
        if (!selecting && document.visibilityState === "visible") {
          const value = await plugin.readMicrophoneCheck();
          if (!selecting && observed === generation && !closed && !signal.aborted && !inheritedSignal?.aborted) publish(value);
        }
      } catch { if (!closed && !signal.aborted && !inheritedSignal?.aborted && !selecting && observed === generation) {
        snapshot = { ...snapshot, status: "unavailable", microphone: null };
        for (const listener of listeners) { try { listener(snapshot); } catch { /* Observer isolation. */ } }
      } }
      if (!closed && !signal.aborted) timer = setTimeout(() => { void poll(); }, 250);
    };
    timer = setTimeout(() => { void poll(); }, 250);
    return { getSnapshot: () => snapshot, subscribe: listener => {
      current(); listeners.add(listener); listener(snapshot); return () => listeners.delete(listener);
    }, selectMicrophone: async id => {
      current(); if (selecting || !snapshot.inputDevices.some(device => device.id === id)) throw unavailable();
      selecting = true; const selected = ++generation;
      try {
        const value = await plugin.selectMicrophoneDevice({ id }); current();
        if (selected === generation) publish(value);
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
  if (data.selectedInputId !== null && (typeof data.selectedInputId !== "string"
    || !inputDevices.some(device => device.id === data.selectedInputId && device.current))) throw unavailable();
  if (data.selectedInputId === null && inputDevices.some(device => device.current)) throw unavailable();
  let microphone: AudioPreflightSnapshot["microphone"] = null;
  if (data.microphone !== null) {
    const meter = exact(data.microphone, ["level", "ageMs"]);
    if (typeof meter.level !== "number" || !Number.isFinite(meter.level) || meter.level < 0 || meter.level > 1
      || typeof meter.ageMs !== "number" || !Number.isFinite(meter.ageMs) || meter.ageMs < 0) throw unavailable();
    microphone = Object.freeze({ level: meter.level, ageMs: meter.ageMs });
  }
  return Object.freeze({ status: data.status as AudioPreflightSnapshot["status"], inputDevices,
    selectedInputId: data.selectedInputId, microphone });
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw unavailable();
  return value as Record<string, unknown>;
}
function unavailable(): QueueInvariantError { return new QueueInvariantError("provider_microphone_check_unavailable"); }
