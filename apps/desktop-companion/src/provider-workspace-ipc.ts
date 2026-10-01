import { DESKTOP_PROVIDER_CHANNELS, parseDesktopProviderRequest, parseDesktopProviderEvent, unavailable,
  type DesktopProviderPort } from "../../capture/src/provider/desktop-host-protocol";
import { DesktopProviderRecorderIpc, installDesktopProviderRecorderPreload } from "./provider-recorder-ipc.js";
import { DesktopProviderWorkspaceMain, type DesktopProviderMainHost } from "./provider-workspace-main.js";
import { installApplicationClosePreload, type ApplicationCloseContextPort, type ApplicationCloseRendererPort } from "./application-close-ipc.js";

interface Frame { readonly url: string }
interface Event { readonly sender: { readonly id: number; readonly mainFrame: Frame }; readonly senderFrame: Frame | null }
type MainPort = ConstructorParameters<typeof DesktopProviderRecorderIpc>[0] & {
  handle(channel: typeof DESKTOP_PROVIDER_CHANNELS.request, listener: (event: Event, value: unknown) => Promise<unknown>): void;
  removeHandler(channel: typeof DESKTOP_PROVIDER_CHANNELS.request): void;
};
type RendererTarget = ConstructorParameters<typeof DesktopProviderRecorderIpc>[1] & {
  send(channel: typeof DESKTOP_PROVIDER_CHANNELS.event, value: unknown): void;
};
type RendererPort = Parameters<typeof installDesktopProviderRecorderPreload>[1] & ApplicationCloseRendererPort & {
  invoke(channel: typeof DESKTOP_PROVIDER_CHANNELS.request, value: unknown): Promise<unknown>;
  on(channel: typeof DESKTOP_PROVIDER_CHANNELS.event, listener: (event: unknown, value: unknown) => void): void;
  removeListener(channel: typeof DESKTOP_PROVIDER_CHANNELS.event, listener: (event: unknown, value: unknown) => void): void;
};
type ContextPort = Parameters<typeof installDesktopProviderRecorderPreload>[0] & ApplicationCloseContextPort & {
  exposeInMainWorld(name: "scribeProvider", api: DesktopProviderPort): void;
};

/** Own one application's backend/session/journals and its current recorder. */
export class DesktopProviderWorkspaceIpc {
  private readonly main: DesktopProviderWorkspaceMain;
  private installed = false;
  private revoked = false;
  private unsubscribe: (() => void) | undefined;
  constructor(private readonly ipc: MainPort, private readonly renderer: RendererTarget, host: DesktopProviderMainHost) {
    this.main = new DesktopProviderWorkspaceMain(host, recorder => {
      const boundary = new DesktopProviderRecorderIpc(ipc, renderer, recorder); boundary.install(); return boundary;
    });
  }
  /** Install before loading the packaged page. Native initialization is awaited
   * by requests while the application's existing loading screen stays responsive. */
  install(): void {
    if (this.installed || this.revoked) throw unavailable(); this.installed = true;
    this.unsubscribe = this.main.subscribe(event => {
      if (!this.revoked && this.validRenderer()) this.renderer.send(DESKTOP_PROVIDER_CHANNELS.event, parseDesktopProviderEvent(event));
    });
    this.ipc.handle(DESKTOP_PROVIDER_CHANNELS.request, async (event, input) => {
      try {
        this.requireRenderer(event); const request = parseDesktopProviderRequest(input);
        await this.main.initialize(); this.requireRenderer(event);
        const response = await this.main.request(request); this.requireRenderer(event); return response;
      } catch { throw unavailable(); }
    });
    for (const event of exits) this.renderer.on(event, this.onExit);
  }
  async dispose(): Promise<void> {
    if (!this.revoked && this.validRenderer()) {
      try { this.renderer.send(DESKTOP_PROVIDER_CHANNELS.event, { kind: "session", state: { phase: "unavailable", revision: crypto.randomUUID() } }); }
      catch { /* A gone renderer cannot retain visible content; cleanup still runs. */ }
    }
    this.revoked = true; this.unsubscribe?.(); this.unsubscribe = undefined;
    if (this.installed) this.ipc.removeHandler(DESKTOP_PROVIDER_CHANNELS.request);
    this.installed = false;
    for (const event of exits) this.renderer.removeListener(event, this.onExit);
    await this.main.dispose();
  }
  private readonly onExit = (): void => { void this.dispose().catch(() => undefined); };
  private requireRenderer(event: Event): void {
    if (this.revoked || !this.installed || event.sender.id !== this.renderer.id || !event.senderFrame
      || event.senderFrame !== event.sender.mainFrame || !origin(event.senderFrame.url) || !this.validRenderer()) throw unavailable();
  }
  private validRenderer(): boolean { return !this.renderer.isDestroyed() && origin(this.renderer.mainFrame.url); }
}

/** The complete standalone preload, with no generic Electron/Node exposure. */
export function installDesktopProviderPreload(context: ContextPort, ipc: RendererPort): void {
  installApplicationClosePreload(context, ipc);
  installDesktopProviderRecorderPreload(context, ipc);
  context.exposeInMainWorld("scribeProvider", Object.freeze({
    request: (value: Parameters<DesktopProviderPort["request"]>[0]) =>
      ipc.invoke(DESKTOP_PROVIDER_CHANNELS.request, parseDesktopProviderRequest(value)),
    subscribe: (listener: (event: unknown) => void) => {
      const receive = (_event: unknown, value: unknown): void => { listener(parseDesktopProviderEvent(value)); };
      ipc.on(DESKTOP_PROVIDER_CHANNELS.event, receive);
      return () => ipc.removeListener(DESKTOP_PROVIDER_CHANNELS.event, receive);
    },
  }));
}
const exits = ["render-process-gone", "destroyed", "will-navigate"] as const;
function origin(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "app:" && url.hostname === "cosmas" && !url.port && !url.username && !url.password; }
  catch { return false; }
}
