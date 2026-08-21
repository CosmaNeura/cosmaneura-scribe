import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { DEFAULT_COMPANION_FEATURE_CONFIG } from "./config.js";
import { DesktopCaptureController } from "./controller.js";
import { resolvePackagedRendererAsset } from "./electron-app.js";
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
import { MockDesktopCaptureAdapter } from "./mock-capture-adapter.js";
import { InMemoryRecordingIndicator } from "./recording-indicator.js";

const ENTRY_URL = "app://cosmas/index.html";
const preloadPath = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const rendererRoot = fileURLToPath(new URL("./renderer/", import.meta.url));
const runtimeRequire = createRequire(
  new URL("../vendor-runtime/package.json", import.meta.url),
);
const { app, BrowserWindow, ipcMain, protocol } = runtimeRequire(
  "electron",
) as ElectronRuntime;

protocol.registerSchemesAsPrivileged([PACKAGED_APP_SCHEME]);

if (requireElectronSingleInstance(app)) {
  void app.whenReady().then(bootstrap).catch(() => app.exit(1));
}

async function bootstrap(): Promise<void> {
  // This slice deliberately has no backend authority or native indicator. Even an
  // environment variable cannot turn capture on in this build.
  const feature = DEFAULT_COMPANION_FEATURE_CONFIG;
  if (feature.enabled) {
    throw new Error("Desktop capture is not release-enabled");
  }

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
  installElectronRendererSecurity(
    window.webContents as ElectronWebContentsSecurityPort,
    ENTRY_URL,
  );

  const controller = new DesktopCaptureController(
    new MockDesktopCaptureAdapter(),
    new InMemoryRecordingIndicator(),
    { enabled: false },
  );
  const boundary = new ElectronMainIpcBoundary(
    asIpcMainPort(ipcMain),
    asRendererTarget(window.webContents),
    controller,
  );
  boundary.install();

  let shutdownStarted = false;
  app.on("before-quit", (event) => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    event.preventDefault();
    void boundary
      .shutdownFromMain("application-shutdown")
      .finally(() => {
        boundary.dispose();
        app.quit();
      });
  });
  window.on("closed", () => app.quit());
  window.once("ready-to-show", () => window.show());
  await window.loadURL(ENTRY_URL);
}

function asIpcMainPort(value: unknown): ElectronIpcMainPort {
  return value as ElectronIpcMainPort;
}

function asRendererTarget(value: unknown): ElectronRendererTarget {
  return value as ElectronRendererTarget;
}

interface ElectronRuntime {
  readonly app: {
    requestSingleInstanceLock(): boolean;
    quit(): void;
    exit(code?: number): void;
    whenReady(): Promise<void>;
    on(
      event: "before-quit",
      listener: (event: { preventDefault(): void }) => void,
    ): void;
  };
  readonly BrowserWindow: new (options: unknown) => {
    readonly webContents: unknown;
    loadURL(url: string): Promise<void>;
    on(event: "closed", listener: () => void): void;
    once(event: "ready-to-show", listener: () => void): void;
    show(): void;
  };
  readonly ipcMain: unknown;
  readonly protocol: {
    registerSchemesAsPrivileged(schemes: readonly unknown[]): void;
    handle(
      scheme: "app",
      handler: (request: { readonly url: string }) => Promise<Response>,
    ): void;
  };
}
