const CHANNEL = "scribe:application:close:v1" as const;
interface Frame { readonly url: string }
interface Event { readonly sender: { readonly id: number; readonly mainFrame: Frame }; readonly senderFrame: Frame | null }
interface Renderer { readonly id: number; readonly mainFrame: Frame; isDestroyed(): boolean }
export interface ApplicationCloseMainPort {
  handle(channel: typeof CHANNEL, listener: (event: Event, ...args: unknown[]) => null): void;
  removeHandler(channel: typeof CHANNEL): void;
}
export interface ApplicationCloseRendererPort { invoke(channel: typeof CHANNEL): Promise<unknown> }
export interface ApplicationCloseContextPort {
  exposeInMainWorld(name: "scribeApplication", api: { close(): Promise<void> }): void;
}

/** One fixed main-window action. No request values, paths or generic IPC enter. */
export function installApplicationClose(ipc: ApplicationCloseMainPort, renderer: Renderer, close: () => void): () => void {
  let installed = true;
  ipc.handle(CHANNEL, (event, ...args) => {
    if (!installed || args.length !== 0 || renderer.isDestroyed() || event.sender.id !== renderer.id
      || !event.senderFrame || event.senderFrame !== event.sender.mainFrame
      || event.senderFrame.url !== "app://cosmas/provider.html" || renderer.mainFrame.url !== "app://cosmas/provider.html") throw unavailable();
    close(); return null;
  });
  return () => { installed = false; ipc.removeHandler(CHANNEL); };
}

export function installApplicationClosePreload(context: ApplicationCloseContextPort, ipc: ApplicationCloseRendererPort): void {
  context.exposeInMainWorld("scribeApplication", Object.freeze({ close: async (...args: unknown[]) => {
    if (args.length !== 0 || await ipc.invoke(CHANNEL) !== null) throw unavailable();
  } }));
}
function unavailable(): Error { return new Error("Scribe could not close."); }
