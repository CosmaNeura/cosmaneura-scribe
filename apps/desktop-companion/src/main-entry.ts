import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_COMPANION_FEATURE_CONFIG,
  DESKTOP_RELEASE_MANIFEST,
  isDesktopCaptureReleaseEnabled,
} from "./config.js";
import { createDesktopCaptureAdapter } from "./desktop-adapter-bootstrap.js";
import { resolvePackagedRendererAsset } from "./electron-app.js";
import {
  DesktopDeepLinkIngress,
  DesktopDeepLinkRouter,
  registerDesktopProtocolClient,
} from "./electron-deep-link.js";
import { enforceNoPhiDiagnosticPolicy } from "./electron-diagnostics.js";
import {
  ElectronMainIpcBoundary,
  type ElectronIpcMainPort,
  type ElectronRendererTarget,
} from "./electron-ipc.js";
import {
  createSecureBrowserWindowOptions,
  installElectronRendererSecurity,
  PACKAGED_APP_SCHEME,
  RENDERER_CONTENT_SECURITY_POLICY,
  requireElectronSingleInstance,
  type ElectronWebContentsSecurityPort,
} from "./electron-security.js";
import {
  ElectronTrayRecordingIndicator,
  installCaptureWindowGuard,
  type ElectronMenuFactoryPort,
  type ElectronNativeImageFactoryPort,
  type ElectronNativeImagePort,
  type ElectronTrayPort,
} from "./electron-recording-indicator.js";
import { ElectronShutdownCoordinator } from "./electron-shutdown.js";
import type { ElectronSafeStoragePort } from "./secure-state-store.js";
import { createTrustedDesktopRuntime } from "./trusted-runtime.js";

const ENTRY_URL = "app://cosmas/index.html";
const preloadPath = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const rendererRoot = fileURLToPath(new URL("./renderer/", import.meta.url));
const mainEntryPath = fileURLToPath(import.meta.url);
const runtimeRequire = createRequire(
  new URL("../vendor-runtime/package.json", import.meta.url),
);
const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  safeStorage,
  shell,
  Tray,
} = runtimeRequire("electron") as ElectronRuntime;
const deepLinkIngress = new DesktopDeepLinkIngress();
let mainWindow: ElectronBrowserWindow | null = null;
let protocolClientRegistered = false;

enforceNoPhiDiagnosticPolicy(app.commandLine, process.argv, process.execArgv);
protocol.registerSchemesAsPrivileged([PACKAGED_APP_SCHEME]);

if (requireElectronSingleInstance(app)) {
  protocolClientRegistered = registerDesktopProtocolClient(app, {
    isPackaged: app.isPackaged,
    isDefaultApp:
      (process as NodeJS.Process & { readonly defaultApp?: boolean })
        .defaultApp === true,
    executablePath: process.execPath,
    entryScriptPath: mainEntryPath,
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    deepLinkIngress.acceptUrl(url);
  });
  app.on("second-instance", (_event, commandLine) => {
    deepLinkIngress.acceptCommandLine(commandLine);
    activateMainWindow();
  });
  deepLinkIngress.acceptCommandLine(process.argv);
  void app.whenReady().then(bootstrap).catch(() => app.exit(1));
}

async function bootstrap(): Promise<void> {
  const feature = DEFAULT_COMPANION_FEATURE_CONFIG;
  const releaseApproved = isDesktopCaptureReleaseEnabled(
    DESKTOP_RELEASE_MANIFEST,
  );
  const captureEnabled = feature.enabled && releaseApproved;
  if (captureEnabled && !protocolClientRegistered) {
    throw new Error("The desktop protocol client is unavailable");
  }
  const adapter = await createDesktopCaptureAdapter({
    productEnabled: feature.enabled,
    releaseManifest: DESKTOP_RELEASE_MANIFEST,
  });

  protocol.handle("app", async (request) => {
    const asset = resolvePackagedRendererAsset(request.url, rendererRoot);
    if (asset === null) {
      return new Response(null, { status: 404 });
    }
    return new Response(await readFile(asset.path), {
      headers: {
        "Content-Security-Policy": RENDERER_CONTENT_SECURITY_POLICY,
        "Content-Type": asset.contentType,
        "X-Content-Type-Options": "nosniff",
      },
      status: 200,
    });
  });

  const window = new BrowserWindow({
    ...createSecureBrowserWindowOptions(preloadPath),
    autoHideMenuBar: true,
    height: 600,
    title: "Cosmas Desktop Companion",
    width: 760,
  });
  mainWindow = window;
  installElectronRendererSecurity(
    window.webContents as ElectronWebContentsSecurityPort,
    ENTRY_URL,
  );

  let shutdownCoordinator: ElectronShutdownCoordinator | null = null;
  const indicator = new ElectronTrayRecordingIndicator({
    trayFactory: { create: (image) => new Tray(image) },
    imageFactory: nativeImage,
    menuFactory: Menu,
    activateWindow: activateMainWindow,
    emergencyStopAndQuit: () => {
      if (shutdownCoordinator === null) {
        app.exit(1);
        return;
      }
      shutdownCoordinator.requestEmergencyStopAndQuit();
    },
  });
  const runtime = createTrustedDesktopRuntime({
    platformAppOrigin: DESKTOP_RELEASE_MANIFEST.platformAppOrigin,
    platformApiOrigin: DESKTOP_RELEASE_MANIFEST.platformApiOrigin,
    adapter,
    indicator,
    safeStorage,
    protectedStateDirectory: join(
      app.getPath("userData"),
      "protected-desktop-state",
    ),
    browser: {
      openExternal: async (url) => {
        await shell.openExternal(url);
      },
    },
    enabled: captureEnabled,
  });
  deepLinkIngress.connect(
    new DesktopDeepLinkRouter({
      session: runtime.session,
      enabled: captureEnabled,
      activateWindow: activateMainWindow,
    }),
  );

  const boundary = new ElectronMainIpcBoundary(
    asIpcMainPort(ipcMain),
    asRendererTarget(window.webContents),
    runtime.controller,
  );
  boundary.install();

  shutdownCoordinator = new ElectronShutdownCoordinator({
    boundary,
    application: app,
  });
  installCaptureWindowGuard(window, indicator, () =>
    shutdownCoordinator?.isShutdownStarted() ?? true,
  );
  app.on("before-quit", (event) => {
    shutdownCoordinator?.handleBeforeQuit(event);
  });
  window.on("closed", () => {
    mainWindow = null;
    app.quit();
  });
  window.once("ready-to-show", activateMainWindow);
  await window.loadURL(ENTRY_URL);
}

function activateMainWindow(): void {
  if (mainWindow === null) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function asIpcMainPort(value: unknown): ElectronIpcMainPort {
  return value as ElectronIpcMainPort;
}

function asRendererTarget(value: unknown): ElectronRendererTarget {
  return value as ElectronRendererTarget;
}

interface ElectronRuntime {
  readonly app: {
    readonly commandLine: {
      hasSwitch(name: string): boolean;
    };
    readonly isPackaged: boolean;
    requestSingleInstanceLock(): boolean;
    setAsDefaultProtocolClient(
      protocol: string,
      executablePath?: string,
      args?: string[],
    ): boolean;
    getPath(name: "userData"): string;
    quit(): void;
    exit(code?: number): void;
    whenReady(): Promise<void>;
    on(
      event: "before-quit",
      listener: (event: { preventDefault(): void }) => void,
    ): void;
    on(
      event: "open-url",
      listener: (event: { preventDefault(): void }, url: string) => void,
    ): void;
    on(
      event: "second-instance",
      listener: (event: unknown, commandLine: readonly string[]) => void,
    ): void;
  };
  readonly BrowserWindow: new (options: unknown) => ElectronBrowserWindow;
  readonly ipcMain: unknown;
  readonly Menu: ElectronMenuFactoryPort;
  readonly nativeImage: ElectronNativeImageFactoryPort;
  readonly protocol: {
    registerSchemesAsPrivileged(schemes: readonly unknown[]): void;
    handle(
      scheme: "app",
      handler: (request: { readonly url: string }) => Promise<Response>,
    ): void;
  };
  readonly safeStorage: ElectronSafeStoragePort;
  readonly shell: {
    openExternal(url: string): Promise<void>;
  };
  readonly Tray: new (image: ElectronNativeImagePort) => ElectronTrayPort;
}

interface ElectronBrowserWindow {
  readonly webContents: unknown;
  focus(): void;
  isMinimized(): boolean;
  loadURL(url: string): Promise<void>;
  on(event: "closed", listener: () => void): void;
  on(
    event: "close" | "minimize",
    listener: (event: { preventDefault(): void }) => void,
  ): void;
  once(event: "ready-to-show", listener: () => void): void;
  restore(): void;
  show(): void;
}
