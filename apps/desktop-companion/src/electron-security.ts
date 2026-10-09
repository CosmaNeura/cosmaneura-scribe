import { isAbsolute } from "node:path";

export const RENDERER_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "media-src blob:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

export const PACKAGED_APP_SCHEME = Object.freeze({
  scheme: "app",
  privileges: Object.freeze({
    standard: true,
    secure: true,
    bypassCSP: false,
    allowServiceWorkers: false,
    supportFetch: false,
    corsEnabled: false,
    codeCache: true,
  }),
});

export interface SecureBrowserWindowOptions {
  readonly show: false;
  readonly webPreferences: {
    readonly preload: string;
    readonly contextIsolation: true;
    readonly nodeIntegration: false;
    readonly nodeIntegrationInWorker: false;
    readonly nodeIntegrationInSubFrames: false;
    readonly sandbox: true;
    readonly webSecurity: true;
    readonly allowRunningInsecureContent: false;
    readonly webviewTag: false;
    readonly devTools: false;
    readonly navigateOnDragDrop: false;
    readonly backgroundThrottling: false;
  };
}

export interface ElectronApplicationLockPort {
  requestSingleInstanceLock(): boolean;
  quit(): void;
}

/** Must run before creating windows or initializing any capture adapter. */
export function requireElectronSingleInstance(
  application: ElectronApplicationLockPort,
): boolean {
  const acquired = application.requestSingleInstanceLock();
  if (!acquired) {
    application.quit();
  }
  return acquired;
}

export function createSecureBrowserWindowOptions(
  preloadPath: string,
): SecureBrowserWindowOptions {
  if (!isAbsolute(preloadPath)) {
    throw new Error("Electron preload path must be absolute");
  }
  return Object.freeze({
    show: false,
    webPreferences: Object.freeze({
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
      navigateOnDragDrop: false,
      // Recording preparation and stop/recovery must keep updating when a
      // native picker or another application takes focus from the provider.
      backgroundThrottling: false,
    }),
  });
}

interface PreventableEvent {
  preventDefault(): void;
}

export interface ElectronSessionSecurityPort {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (allowed: boolean) => void,
      details: unknown,
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      webContents: unknown,
      permission: string,
      requestingOrigin: string,
      details: unknown,
    ) => boolean,
  ): void;
  on(
    event: "will-download",
    listener: (event: PreventableEvent) => void,
  ): void;
  readonly webRequest: {
    onHeadersReceived(
      listener: (
        details: {
          readonly responseHeaders?: Record<string, string | string[]>;
        },
        callback: (response: {
          readonly responseHeaders: Record<string, string | string[]>;
        }) => void,
      ) => void,
    ): void;
  };
}

export interface ElectronWebContentsSecurityPort {
  readonly session: ElectronSessionSecurityPort;
  on(
    event: "will-navigate" | "will-redirect" | "will-attach-webview",
    listener: (event: PreventableEvent, ...details: unknown[]) => void,
  ): void;
  setWindowOpenHandler(handler: () => { readonly action: "deny" }): void;
}

/** Apply immediately after BrowserWindow creation and before loading content. */
export function installElectronRendererSecurity(
  webContents: ElectronWebContentsSecurityPort,
  packagedEntryUrl: string,
): void {
  const entry = new URL(packagedEntryUrl);
  if (
    entry.protocol !== "app:" ||
    entry.hostname !== "cosmas" ||
    entry.port !== "" ||
    entry.username !== "" ||
    entry.password !== ""
  ) {
    throw new Error("Renderer entry URL must use the packaged app://cosmas origin");
  }

  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("will-attach-webview", (event) => event.preventDefault());
  for (const eventName of ["will-navigate", "will-redirect"] as const) {
    webContents.on(eventName, (event, destination) => {
      if (typeof destination !== "string" || destination !== entry.href) {
        event.preventDefault();
      }
    });
  }
  webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  webContents.session.setPermissionCheckHandler(() => false);
  webContents.session.on("will-download", (event) => event.preventDefault());
  webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [RENDERER_CONTENT_SECURITY_POLICY],
      },
    });
  });
}
