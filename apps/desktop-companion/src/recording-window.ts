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
  setAlwaysOnTop(value: boolean, level?: "floating"): void;
  setVisibleOnAllWorkspaces(value: boolean, options?: { visibleOnFullScreen: boolean }): void;
  getMediaSourceId(): string;
  showInactive(): void;
}

/** Main-only window presentation. It never reads a renderer visibility claim,
 * dispatches recording, or grants authority. Native code verifies the OS ID. */
export class MainRecordingWindow implements DesktopRecordingWindow {
  private compact = false;
  private usable = true;
  private active = false;
  private previous: WindowBounds | null = null;
  private previousMinimum: [number, number] | null = null;
  private readonly responsiveness: RendererResponsiveness;
  constructor(private readonly current: () => RecordingWindowPort | null,
    private readonly workArea: (bounds: WindowBounds) => WindowBounds,
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
    const compact = this.active || snapshot?.state === "paused" && phase === "interrupted";
    const window = this.current();
    if (!window || window.isDestroyed() || compact === this.compact) return;
    // Repeated snapshots/timer ticks must not raise the window, switch Spaces,
    // or repeat Electron's process-type transformation.
    if (compact) {
      this.previous = window.getBounds(); this.previousMinimum = window.getMinimumSize();
      const area = this.workArea(this.previous), width = 480, height = 360;
      window.setMinimumSize(width, height);
      window.setBounds({ x: Math.max(area.x, area.x + area.width - width - 16),
        y: Math.max(area.y, area.y + 16), width, height });
      window.setAlwaysOnTop(true, "floating");
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      window.showInactive();
    } else {
      window.setAlwaysOnTop(false);
      window.setVisibleOnAllWorkspaces(false);
      if (this.previousMinimum) window.setMinimumSize(...this.previousMinimum);
      if (this.previous) window.setBounds(this.previous);
      this.previous = null; this.previousMinimum = null;
    }
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
