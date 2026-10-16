import type { AudioPreflightSnapshot, ProviderAudioPreflight } from "../../capture/src/provider/audio-preflight";
import type { NativeMeetingWindow } from "./native-provider-presentation.js";
import type { NativeMicrophoneInputService } from "./native-microphone-inputs.js";

/** One main-owned input catalogue, shared by advisory preparation and the
 * authorized recorder. Window identities and microphone UIDs stay in main. */
export class DesktopAudioPreflight {
  private choices: { id: string; value: NativeMeetingWindow }[] = [];
  private selected: string | null = null;
  private mode: "microphone" | "meeting" = "microphone";
  private windowState: "ready" | "unavailable" = "unavailable";
  private active: ProviderAudioPreflight | null = null;
  constructor(readonly inputs: NativeMicrophoneInputService,
    private readonly listWindows?: (signal: AbortSignal) => Promise<readonly NativeMeetingWindow[]>) {}
  get meetingWindowChoices(): readonly { id: string; value: NativeMeetingWindow }[] { return this.choices; }
  get selectedMeetingWindowId(): string | null { return this.selected; }
  async open(signal: AbortSignal): Promise<ProviderAudioPreflight> {
    if (this.active || signal.aborted) throw unavailable();
    const listeners = new Set<(snapshot: AudioPreflightSnapshot) => void>();
    let closed = false, closing: Promise<void> | null = null, refreshing = false;
    const current = (): void => { if (closed || signal.aborted || this.active !== port) throw unavailable(); };
    const snapshot = (): AudioPreflightSnapshot => ({ ...this.inputs.getSnapshot(), desktopAudio: this.mode,
      meetingWindows: { state: this.windowState, selectedId: this.selected,
        windows: this.choices.map(row => ({ id: row.id, title: row.value.title })) } });
    const publish = (): void => { if (!closed) for (const listener of listeners) { try { listener(snapshot()); } catch { /* Advisory observation. */ } } };
    const unsubscribe = this.inputs.subscribe(publish);
    const close = (): Promise<void> => {
      closed = true; unsubscribe(); listeners.clear(); signal.removeEventListener("abort", aborted);
      return closing ??= this.inputs.close().then(() => { if (this.active === port) this.active = null; })
        .catch(error => { closing = null; throw error; });
    };
    const aborted = (): void => { void close().catch(() => undefined); };
    const refresh = async (): Promise<void> => {
      current(); if (refreshing || !this.listWindows) throw unavailable();
      refreshing = true;
      try {
        const values = await this.listWindows(signal); current();
        if (values.length > 64 || values.some(value => !value.title || value.title.length > 512 || [...value.title].some(c => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127))
          || new Set(values.map(value => `${value.application}:${value.processID}:${value.windowID}`)).size !== values.length) throw unavailable();
        this.choices = values.map(value => Object.freeze({ id: this.choices.find(row => sameWindow(row.value, value))?.id ?? crypto.randomUUID(), value: Object.freeze({ ...value }) }));
        if (!this.choices.some(row => row.id === this.selected)) this.selected = null;
        this.windowState = "ready";
      } catch (error) { if (!closed && !signal.aborted && this.active === port) { this.choices = []; this.selected = null; this.windowState = "unavailable"; } throw error; }
      finally { refreshing = false; publish(); }
    };
    const port: ProviderAudioPreflight = { getSnapshot: snapshot,
      subscribe: listener => { current(); listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
      selectMicrophone: async id => { current(); await this.inputs.selectMicrophone(id); current(); publish(); },
      selectDesktopAudio: async mode => { current(); if (mode !== "microphone" && mode !== "meeting") throw unavailable();
        this.mode = mode; publish(); if (mode === "meeting") await refresh(); },
      refreshMeetingWindows: refresh,
      selectMeetingWindow: id => { current(); if (this.mode !== "meeting" || !this.choices.some(row => row.id === id)) throw unavailable();
        this.selected = id; publish(); return Promise.resolve(); }, close };
    this.active = port; signal.addEventListener("abort", aborted, { once: true });
    try { await this.inputs.startCheck(signal); current(); return port; }
    catch (error) { await close(); throw error; }
  }
  async close(): Promise<void> { await this.active?.close(); await this.inputs.close(); }
}
function sameWindow(a: NativeMeetingWindow, b: NativeMeetingWindow): boolean {
  return a.processID === b.processID && a.application === b.application && a.windowID === b.windowID;
}
function unavailable(): Error { return new Error("Audio preparation is unavailable."); }
