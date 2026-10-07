import { DESKTOP_RECORDER_CHANNELS, parseDesktopRecorderRequest, parseDesktopRecorderState,
  type DesktopRecorderPort, type DesktopRecorderState } from "../../capture/src/provider/desktop-recorder-view";
import type { DesktopProviderRecorder } from "./provider-recorder.js";

interface Frame { readonly url: string }
interface InvokeEvent { readonly sender: { readonly id: number; readonly mainFrame: Frame }; readonly senderFrame: Frame | null }
interface MainPort {
  handle(channel: typeof DESKTOP_RECORDER_CHANNELS.request, listener: (event: InvokeEvent, value: unknown) => Promise<unknown>): void;
  removeHandler(channel: typeof DESKTOP_RECORDER_CHANNELS.request): void;
}
type ExitEvent = "render-process-gone" | "destroyed" | "will-navigate";
interface RendererTarget {
  readonly id: number;
  readonly mainFrame: Frame;
  isDestroyed(): boolean;
  send(channel: typeof DESKTOP_RECORDER_CHANNELS.state, value: unknown): void;
  on(event: ExitEvent, listener: () => void): void;
  removeListener(event: ExitEvent, listener: () => void): void;
}
interface RendererPort {
  invoke(channel: typeof DESKTOP_RECORDER_CHANNELS.request, value: unknown): Promise<unknown>;
  on(channel: typeof DESKTOP_RECORDER_CHANNELS.state, listener: (event: unknown, value: unknown) => void): void;
  removeListener(channel: typeof DESKTOP_RECORDER_CHANNELS.state, listener: (event: unknown, value: unknown) => void): void;
}

/** Main-only, one backend-selected recorder. Install after authorization, before
 * exposing the view. Retain this owner on failed shutdown so native Stop can retry. */
export class DesktopProviderRecorderIpc {
  private readonly recorderId = crypto.randomUUID();
  private revision = 0;
  private installed = false;
  private revoked = false;
  private unsubscribe: (() => void) | undefined;
  constructor(private readonly ipc: MainPort, private readonly renderer: RendererTarget,
    private readonly recorder: DesktopProviderRecorder) {}
  install(): void {
    if (this.installed || this.revoked || !this.validRenderer()) throw failure();
    this.installed = true;
    this.ipc.handle(DESKTOP_RECORDER_CHANNELS.request, async (event, value) => {
      if (this.revoked || event.sender.id !== this.renderer.id || !event.senderFrame
        || event.senderFrame !== event.sender.mainFrame || !origin(event.senderFrame.url) || !this.validRenderer()) throw failure();
      const request = parseDesktopRecorderRequest(value);
      if (request.recorderId !== this.recorderId && !(request.kind === "read" && request.recorderId === null)) throw failure();
      if (!this.recorder.availableForView && request.kind !== "deactivate") throw failure();
      let ok = true;
      try {
        switch (request.kind) {
          case "audio_microphone": await this.recorder.selectDesktopAudio("microphone"); break;
          case "audio_meeting": await this.recorder.selectDesktopAudio("meeting"); break;
          case "start": await this.recorder.startRecording(); break;
          case "stop": await this.recorder.stopRecording(); break;
          case "pause": await this.recorder.pauseRecording(); break;
          case "continue": await this.recorder.resumeRecording(); break;
          case "permissions": await this.recorder.refreshPermissions(); break;
          case "show_chooser": await this.recorder.showWindowChooser(); break;
          case "resume": await this.recorder.resumePendingWork(); break;
          case "release": await this.recorder.releaseUploadedCapture(); break;
          case "deactivate": await this.recorder.deactivate(); break;
          case "read": break;
        }
      } catch { ok = false; }
      if (request.kind !== "deactivate" && !this.recorder.availableForView) throw failure();
      return { requestId: request.requestId, ok, state: request.kind === "deactivate" ? null : this.state() };
    });
    this.unsubscribe = this.recorder.subscribe(() => {
      this.revision++;
      if (!this.revoked && this.recorder.availableForView && this.validRenderer()) this.renderer.send(DESKTOP_RECORDER_CHANNELS.state, this.state());
    });
    for (const event of exits) this.renderer.on(event, this.onExit);
  }
  async dispose(): Promise<void> {
    this.revoked = true;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    if (this.installed) this.ipc.removeHandler(DESKTOP_RECORDER_CHANNELS.request);
    this.installed = false;
    for (const event of exits) this.renderer.removeListener(event, this.onExit);
    await this.recorder.deactivate();
  }
  private readonly onExit = (): void => { void this.dispose().catch(() => undefined); };
  private state(): DesktopRecorderState {
    return parseDesktopRecorderState({ recorderId: this.recorderId, revision: this.revision, snapshot: this.recorder.snapshot });
  }
  private validRenderer(): boolean { return !this.renderer.isDestroyed() && origin(this.renderer.mainFrame.url); }
}
/** Call in the sandboxed preload; the renderer constructs its view from this API. */
export function installDesktopProviderRecorderPreload(context: { exposeInMainWorld(name: "scribeRecorder", api: DesktopRecorderPort): void },
  ipc: RendererPort): void {
  context.exposeInMainWorld("scribeRecorder", Object.freeze({
    request: (value: Parameters<DesktopRecorderPort["request"]>[0]) =>
      ipc.invoke(DESKTOP_RECORDER_CHANNELS.request, parseDesktopRecorderRequest(value)),
    subscribe: (listener: (value: unknown) => void) => {
      const receive = (_event: unknown, value: unknown): void => { listener(parseDesktopRecorderState(value)); };
      ipc.on(DESKTOP_RECORDER_CHANNELS.state, receive);
      return () => ipc.removeListener(DESKTOP_RECORDER_CHANNELS.state, receive);
    },
  }));
}
const exits: readonly ExitEvent[] = ["render-process-gone", "destroyed", "will-navigate"];
function origin(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "app:" && url.hostname === "cosmas" && url.port === "" && !url.username && !url.password; }
  catch { return false; }
}
function failure(): Error { return new Error("Desktop recording command is unavailable."); }
