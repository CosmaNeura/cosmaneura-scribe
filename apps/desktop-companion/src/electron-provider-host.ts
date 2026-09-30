import { join } from "node:path";
import { createSecureBrowserWindowOptions, installElectronRendererSecurity, requireElectronSingleInstance, PACKAGED_APP_SCHEME,
  type ElectronSessionSecurityPort, type ElectronWebContentsSecurityPort } from "./electron-security.js";
import { DesktopProviderWorkspaceIpc } from "./provider-workspace-ipc.js";
import type { DesktopProviderMainHost } from "./provider-workspace-main.js";
import { loadPackagedProvider, PROVIDER_ENTRY, type PackagedProvider } from "./packaged-provider.js";
import { runtimeDiagnostics, type RuntimeDiagnostic } from "./runtime-diagnostics.js";

interface Event { preventDefault(): void }
type Renderer = ConstructorParameters<typeof DesktopProviderWorkspaceIpc>[1] & ElectronWebContentsSecurityPort;
interface Window {
  readonly webContents: Renderer;
  loadURL(url: string): Promise<void>;
  show(): void; focus(): void; destroy(): void; isDestroyed(): boolean;
  on(event: "close", listener: (event: Event) => void): void;
  removeListener(event: "close", listener: (event: Event) => void): void;
}
interface Session extends ElectronSessionSecurityPort {
  readonly protocol: { handle(scheme: string, handler: (request: { url: string; method: string }) => Response): void; unhandle(scheme: string): void };
  readonly webRequest: ElectronSessionSecurityPort["webRequest"] & {
    onBeforeRequest(listener: ((details: { url: string }, callback: (result: { cancel: boolean }) => void) => void) | null): void;
  };
}
export interface DesktopElectronRuntime<S extends Session = Session> {
  readonly app: {
    readonly isPackaged: boolean;
    getAppPath(): string; getName(): string; getPath(name: "userData"): string;
    requestSingleInstanceLock(): boolean; whenReady(): Promise<void>; quit(): void;
    on(event: "before-quit", listener: (event: Event) => void): void;
    on(event: "second-instance", listener: () => void): void;
    removeListener(event: "before-quit", listener: (event: Event) => void): void;
    removeListener(event: "second-instance", listener: () => void): void;
  };
  readonly protocol: { registerSchemesAsPrivileged(schemes: Array<typeof PACKAGED_APP_SCHEME>): void };
  readonly session: { fromPartition(partition: string, options: { cache: false }): S };
  readonly ipcMain: ConstructorParameters<typeof DesktopProviderWorkspaceIpc>[0];
  readonly BrowserWindow: new (options: ReturnType<typeof createSecureBrowserWindowOptions> & {
    title: string; width: number; height: number; minWidth: number; minHeight: number;
    webPreferences: ReturnType<typeof createSecureBrowserWindowOptions>["webPreferences"] & { session: S };
  }) => Window;
  readonly dialog: { showMessageBox(options: { type: "error"; message: string; detail: string; buttons: string[];
    defaultId: number; cancelId: number; noLink: true }): Promise<{ response: number }> };
}
export interface DesktopProviderOwner {
  readonly host: DesktopProviderMainHost;
  /** Idempotent, retryable disposal of native session/storage ownership. It must
   * not claim success while any native source can still capture. */
  dispose(): Promise<void>;
}
export interface DesktopProviderFactory {
  /** Construct the reviewed native/backend host, without starting a source.
   * There is no default credential, key, environment or fixture implementation. */
  open(options: { readonly userDataDirectory: string; readonly diagnostics?: RuntimeDiagnostic }): Promise<DesktopProviderOwner>;
}

/** Executable shell composition. Call once from the packaged Electron main entry,
 * with the reviewed native/backend factory bundled beside it. */
export async function startElectronProvider<S extends Session>(runtime: DesktopElectronRuntime<S>, factory: DesktopProviderFactory): Promise<{
  close(): Promise<void>;
} | null> {
  if (typeof process === "undefined" || !process.versions.node || typeof window !== "undefined"
    || "type" in process && process.type === "renderer" || !runtime.app.isPackaged || runtime.app.getName() !== "Cosmaneura Scribe Beta") throw unavailable();
  if (!requireElectronSingleInstance(runtime.app)) return null;
  runtime.protocol.registerSchemesAsPrivileged([PACKAGED_APP_SCHEME]);
  let startupStopped = false;
  const stopStartup = (): void => { startupStopped = true; };
  runtime.app.on("before-quit", stopStartup);
  const root = runtime.app.getAppPath(); let assets: PackagedProvider;
  try {
    await runtime.app.whenReady(); if (startupStopped) throw unavailable();
    assets = await loadPackagedProvider(join(root, "renderer")); if (startupStopped) throw unavailable();
  } catch {
    runtime.app.removeListener("before-quit", stopStartup); throw unavailable();
  }
  const session = runtime.session.fromPartition(`scribe-provider-${crypto.randomUUID()}`, { cache: false });
  const diagnostics = runtimeDiagnostics(runtime.app.getPath("userData")); diagnostics("host_open");
  session.protocol.handle("app", request => assets.respond(request));
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !assets.allows(details.url) }));
  let owner: DesktopProviderOwner | null = null, boundary: DesktopProviderWorkspaceIpc | null = null, appWindow: Window | null = null;
  let opening: Promise<void> | null = null;
  let ended = false, closing: Promise<void> | null = null, askingToRetry = false;
  const focus = (): void => { if (appWindow && !appWindow.isDestroyed()) { appWindow.show(); appWindow.focus(); } };
  const beforeQuit = (event: Event): void => { if (!ended) { diagnostics("before_quit"); event.preventDefault(); requestClose(); } };
  const windowClose = (event: Event): void => { diagnostics("window_close"); event.preventDefault(); requestClose(); };
  const close = (): Promise<void> => {
    if (ended) return Promise.resolve();
    return closing ??= (async () => {
      diagnostics("close_begin");
      await opening?.catch(() => undefined);
      await boundary?.dispose(); diagnostics("boundary_closed");
      await owner?.dispose(); diagnostics("owner_closed");
      ended = true;
      runtime.app.removeListener("before-quit", beforeQuit); runtime.app.removeListener("second-instance", focus);
      appWindow?.removeListener("close", windowClose);
      if (appWindow && !appWindow.isDestroyed()) appWindow.destroy();
      session.protocol.unhandle("app"); session.webRequest.onBeforeRequest(null);
      diagnostics("quit_ready"); runtime.app.quit();
    })().catch(() => { diagnostics("close_failed"); closing = null; throw unavailable(); });
  };
  function requestClose(): void {
    if (askingToRetry) return;
    void close().catch(async () => {
      if (askingToRetry) return;
      askingToRetry = true; focus();
      let retry = false;
      try {
        const result = await runtime.dialog.showMessageBox({ type: "error", message: "Scribe could not confirm recording has stopped.",
          detail: "Keep Scribe open and retry stopping. The current recording remains unavailable until cleanup is confirmed.",
          buttons: ["Retry stopping", "Keep Scribe open"], defaultId: 0, cancelId: 1, noLink: true });
        retry = result.response === 0;
      } catch { /* Keep the owner and application available for an explicit retry. */ }
      finally { askingToRetry = false; }
      if (retry) requestClose();
    });
  }
  runtime.app.on("before-quit", beforeQuit); runtime.app.on("second-instance", focus);
  runtime.app.removeListener("before-quit", stopStartup);
  try {
    opening = Promise.resolve().then(async () => { owner = await factory.open({ userDataDirectory: runtime.app.getPath("userData"), diagnostics }); });
    await opening;
    if (closing || ended) throw unavailable();
    const secure = createSecureBrowserWindowOptions(join(root, "preload.cjs"));
    appWindow = new runtime.BrowserWindow({ ...secure, title: "Cosmaneura Scribe Beta", width: 780, height: 760, minWidth: 520, minHeight: 520,
      webPreferences: { ...secure.webPreferences, session } });
    installElectronRendererSecurity(appWindow.webContents, PROVIDER_ENTRY);
    if (!owner) throw unavailable();
    boundary = new DesktopProviderWorkspaceIpc(runtime.ipcMain, appWindow.webContents, (owner as DesktopProviderOwner).host); boundary.install();
    appWindow.on("close", windowClose);
    appWindow.webContents.on("render-process-gone", () => { diagnostics("renderer_gone"); requestClose(); });
    appWindow.webContents.on("will-navigate", () => { diagnostics("renderer_navigation"); requestClose(); });
    await appWindow.loadURL(PROVIDER_ENTRY);
    if (closing || ended) throw unavailable();
    appWindow.show(); diagnostics("window_ready"); return { close };
  } catch {
    // The factory's contract requires cleanup of a rejected acquisition. A
    // returned owner is always retained here, including a late startup result.
    requestClose(); throw unavailable();
  }
}
function unavailable(): Error { return new Error("The Scribe desktop application is unavailable."); }
