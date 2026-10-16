import type { AudioPreflightSnapshot, ProviderAudioPreflight } from "./audio-preflight";
import { parseAudioInputDevices } from "./ios-audio-preflight";
import { exact, uuid, unavailable } from "./desktop-host-protocol";

/** Renderer sees bounded advisory metadata through fixed, encounter-scoped IPC. */
export async function openDesktopAudioPreflight(signal: AbortSignal,
  request: (payload: Readonly<Record<string, unknown>>, signal?: AbortSignal) => Promise<unknown>): Promise<ProviderAudioPreflight> {
  let closed = false, closing: Promise<void> | null = null, timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(value: AudioPreflightSnapshot) => void>();
  let generation = 0, changing = false;
  let snapshot: AudioPreflightSnapshot;
  try { snapshot = parse(await request({ action: "open" }, signal)); }
  catch (error) { await request({ action: "close" }); throw error; }
  const current = (): void => { if (closed || signal.aborted) throw unavailable(); };
  const publish = (value: unknown): void => { current(); snapshot = parse(value); for (const listener of listeners) listener(snapshot); };
  const close = (): Promise<void> => {
    closed = true; generation++; snapshot = { ...snapshot, status: "unavailable", microphone: null };
    clearTimeout(timer); listeners.clear(); signal.removeEventListener("abort", aborted);
    return closing ??= request({ action: "close" }).then(() => undefined).catch(error => { closing = null; throw error; });
  };
  const aborted = (): void => { void close().catch(() => undefined); };
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) { await close(); throw unavailable(); }
  const poll = async (): Promise<void> => {
    const observed = generation;
    try { current(); if (!changing && document.visibilityState === "visible") {
      const value = await request({ action: "read" }, signal);
      if (!changing && observed === generation && !closed && !signal.aborted) publish(value);
    } }
    catch { if (!closed && !signal.aborted && !changing && observed === generation) {
      snapshot = { ...snapshot, status: "unavailable", microphone: null };
      for (const listener of listeners) listener(snapshot);
    } }
    if (!closed && !signal.aborted) timer = setTimeout(() => { void poll(); }, 250);
  };
  const operation = async (payload: Readonly<Record<string, unknown>>): Promise<void> => {
    current(); if (changing) throw unavailable();
    changing = true; const selected = ++generation;
    try { const value = await request(payload, signal); current(); if (selected === generation) publish(value); }
    catch (error) {
      // A validated native denial may update status while the action itself
      // fails. Read its closed snapshot rather than hiding it as a generic error.
      if (!closed && !signal.aborted && selected === generation) {
        snapshot = { ...snapshot, status: "unavailable", microphone: null };
        const value = await request({ action: "read" }, signal); current();
        if (selected === generation) publish(value);
      }
      throw error;
    } finally { changing = false; }
  };
  timer = setTimeout(() => { void poll(); }, 250);
  return { getSnapshot: () => snapshot, subscribe: listener => { current(); listeners.add(listener); listener(snapshot); return () => listeners.delete(listener); },
    selectMicrophone: id => { if (!snapshot.inputDevices.some(row => row.id === id)) return Promise.reject(unavailable()); return operation({ action: "input", id }); },
    requestRecordingAccess: () => operation({ action: "access" }),
    selectDesktopAudio: mode => operation({ action: "mode", mode }), refreshMeetingWindows: () => operation({ action: "windows" }),
    selectMeetingWindow: id => operation({ action: "window", id }), close };
}
function parse(value: unknown): AudioPreflightSnapshot {
  const data = exact(value, ["status", "inputDevices", "selectedInputId", "microphone", "desktopAudio", "meetingWindows"]);
  if (!["checking", "ready", "permission_required", "unavailable"].includes(String(data.status))
    || data.desktopAudio !== "microphone" && data.desktopAudio !== "meeting") throw unavailable();
  const inputDevices = parseAudioInputDevices(data.inputDevices);
  inputDevices.forEach(row => uuid(row.id));
  if (data.selectedInputId !== null && !inputDevices.some(row => row.id === data.selectedInputId && row.current)
    || data.selectedInputId === null && inputDevices.some(row => row.current)) throw unavailable();
  // Preparation cannot transport levels from an obsolete pre-consent helper.
  if (data.microphone !== null) throw unavailable();
  const choices = exact(data.meetingWindows, ["state", "windows", "selectedId"]);
  if (choices.state !== "ready" && choices.state !== "permission_required" && choices.state !== "unavailable" || !Array.isArray(choices.windows) || choices.windows.length > 64) throw unavailable();
  const windows = choices.windows.map(value => { const row = exact(value, ["id", "title"]);
    if (typeof row.title !== "string" || !row.title || row.title.length > 512 || [...row.title].some(c => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127)) throw unavailable();
    return { id: uuid(row.id), title: row.title }; });
  if (new Set(windows.map(row => row.id)).size !== windows.length
    || choices.selectedId !== null && !windows.some(row => row.id === choices.selectedId)) throw unavailable();
  return { status: data.status as AudioPreflightSnapshot["status"], inputDevices, selectedInputId: data.selectedInputId as string | null,
    microphone: null, desktopAudio: data.desktopAudio, meetingWindows: { state: choices.state, windows, selectedId: choices.selectedId as string | null } };
}
