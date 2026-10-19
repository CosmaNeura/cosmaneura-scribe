import { RendererResponsiveness } from "./renderer-responsiveness.js";
import type { ProviderRecorderSnapshot } from "../../capture/src/provider-binding";

export interface DesktopRecordingWindow {
  update(snapshot: ProviderRecorderSnapshot | null): void;
  primaryWindowId(): number | null;
}
export interface WindowBounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface RecordingWindowPort {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  getBounds(): WindowBounds;
  getMinimumSize(): [number, number];
  setBounds(bounds: WindowBounds): void;
  setMinimumSize(width: number, height: number): void;
  setAlwaysOnTop(value: boolean, level?: "status"): void;
  setVisibleOnAllWorkspaces(value: boolean, options?: { visibleOnFullScreen: boolean }): void;
  getMediaSourceId(): string;
}

/** Main-only window presentation. It never reads a renderer visibility claim,
 * dispatches recording, or grants authority. Native code verifies the OS ID and
 * coverage; the normal-order main window cannot replace its status panel. */
export class MainRecordingWindow implements DesktopRecordingWindow {
  private compact = false;
  private usable = true;
  private active = false;
  private readonly responsiveness: RendererResponsiveness;
  constructor(private readonly current: () => RecordingWindowPort | null,
    _workArea: (bounds: WindowBounds) => WindowBounds,
    probe: () => Promise<unknown>, clock?: () => number) {
    this.responsiveness = new RendererResponsiveness(probe, clock);
  }

  block(): void {
    this.usable = false;
    this.responsiveness.invalidate();
  }

  update(snapshot: ProviderRecorderSnapshot | null): void {
    const phase = snapshot?.desktop?.phase;
    this.active = phase !== undefined && ["starting", "recording", "stopping"].includes(phase);
    if (!this.active) this.responsiveness.invalidate();
    const compact = this.active || phase === "stop_unconfirmed" || snapshot?.state === "paused" && phase === "interrupted";
    const window = this.current();
    if (!window || window.isDestroyed() || compact === this.compact) return;
    // Repeated snapshots/timer ticks must not raise the window, switch Spaces,
    // or repeat Electron's process-type transformation.
    // Keep the provider's size, position and Space. Zoom or the EMR may remain
    // frontmost while the independent native status panel/menu provide Stop.
    window.setAlwaysOnTop(false);
    window.setVisibleOnAllWorkspaces(false);
    this.compact = compact;
    if (this.active && this.usable) this.responsiveness.isResponsive();
  }

  primaryWindowId(): number | null {
    const window = this.current();
    if (!this.usable || !this.active || !this.compact || !window || window.isDestroyed()
      || !window.isVisible() || window.isMinimized() || !this.responsiveness.isResponsive()) return null;
    // getNativeWindowHandle is an NSView pointer on macOS. Only this documented
    // main-owned media ID contains the transferable CGWindowID.
    const match = /^window:([1-9][0-9]{0,9}):[0-9]+$/u.exec(window.getMediaSourceId());
    const id = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(id) && id > 0 && id <= 4_294_967_295 ? id : null;
  }
}
