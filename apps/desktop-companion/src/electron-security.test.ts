import { describe, expect, it } from "vitest";

import {
  createSecureBrowserWindowOptions,
  installElectronRendererSecurity,
  PACKAGED_APP_SCHEME,
  RENDERER_CONTENT_SECURITY_POLICY,
  requireElectronSingleInstance,
  type ElectronWebContentsSecurityPort, type ElectronSessionSecurityPort,
} from "./electron-security.js";

type HeadersHandler = Parameters<ElectronSessionSecurityPort["webRequest"]["onHeadersReceived"]>[0];

class FakeWebContents implements ElectronWebContentsSecurityPort {
  readonly listeners = new Map<
    string,
    (event: { preventDefault(): void }, ...details: unknown[]) => void
  >();
  windowOpenHandler: (() => { readonly action: "deny" }) | null = null;
  permissionHandler:
    | ((
        webContents: unknown,
        permission: string,
        callback: (allowed: boolean) => void,
        details: unknown,
      ) => void)
    | null = null;
  permissionCheckHandler:
    | ((
        webContents: unknown,
        permission: string,
        requestingOrigin: string,
        details: unknown,
      ) => boolean)
    | null = null;
  headersHandler: HeadersHandler | null = null;
  readonly session = {
    setPermissionRequestHandler: (
      handler: (
        webContents: unknown,
        permission: string,
        callback: (allowed: boolean) => void,
        details: unknown,
      ) => void,
    ): void => {
      this.permissionHandler = handler;
    },
    setPermissionCheckHandler: (
      handler: (
        webContents: unknown,
        permission: string,
        requestingOrigin: string,
        details: unknown,
      ) => boolean,
    ): void => {
      this.permissionCheckHandler = handler;
    },
    on: (
      event: "will-download",
      listener: (event: { preventDefault(): void }) => void,
    ): void => {
      this.listeners.set(event, listener);
    },
    webRequest: {
      onHeadersReceived: (listener: HeadersHandler): void => {
        this.headersHandler = listener;
      },
    },
  };

  on(
    event: "will-navigate" | "will-redirect" | "will-attach-webview",
    listener: (
      event: { preventDefault(): void },
      ...details: unknown[]
    ) => void,
  ): void {
    this.listeners.set(event, listener);
  }

  setWindowOpenHandler(handler: () => { readonly action: "deny" }): void {
    this.windowOpenHandler = handler;
  }
}

describe("Electron renderer security", () => {
  it("requires an OS-process single-instance lock before capture setup", () => {
    let quitCalled = false;
    expect(
      requireElectronSingleInstance({
        requestSingleInstanceLock: () => false,
        quit: () => {
          quitCalled = true;
        },
      }),
    ).toBe(false);
    expect(quitCalled).toBe(true);
  });

  it("defines a secure packaged scheme without CSP bypass", () => {
    expect(PACKAGED_APP_SCHEME).toEqual({
      scheme: "app",
      privileges: {
        standard: true,
        secure: true,
        bypassCSP: false,
        allowServiceWorkers: false,
        supportFetch: false,
        corsEnabled: false,
        codeCache: true,
      },
    });
  });

  it("requires an absolute preload and locks down BrowserWindow", () => {
    expect(() => createSecureBrowserWindowOptions("./preload.js")).toThrow();
    expect(createSecureBrowserWindowOptions("/synthetic/preload.js")).toEqual({
      show: false,
      webPreferences: {
        preload: "/synthetic/preload.js",
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
        backgroundThrottling: false,
      },
    });
    expect(RENDERER_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(RENDERER_CONTENT_SECURITY_POLICY).toContain("media-src blob:");
  });

  it("denies windows, renderer permissions, downloads, webviews, and navigation", () => {
    const contents = new FakeWebContents();
    installElectronRendererSecurity(contents, "app://cosmas/index.html");

    expect(contents.windowOpenHandler?.()).toEqual({ action: "deny" });
    let permissionAllowed: boolean | undefined;
    contents.permissionHandler?.(
      {},
      "media",
      (allowed) => {
        permissionAllowed = allowed;
      },
      {},
    );
    expect(permissionAllowed).toBe(false);
    expect(contents.permissionCheckHandler?.({}, "media", "app://cosmas", {})).toBe(
      false,
    );

    for (const eventName of [
      "will-download",
      "will-attach-webview",
      "will-redirect",
    ] as const) {
      let prevented = false;
      contents.listeners.get(eventName)?.({
        preventDefault: () => {
          prevented = true;
        },
      });
      expect(prevented).toBe(true);
    }

    let externalNavigationPrevented = false;
    contents.listeners.get("will-navigate")?.(
      {
        preventDefault: () => {
          externalNavigationPrevented = true;
        },
      },
      "https://example.invalid/",
    );
    expect(externalNavigationPrevented).toBe(true);

    let responseHeaders: Record<string, string | string[]> = {};
    contents.headersHandler?.(
      { responseHeaders: { Existing: ["value"] } },
      (response) => {
        responseHeaders = response.responseHeaders;
      },
    );
    expect(responseHeaders["Content-Security-Policy"]).toEqual([
      RENDERER_CONTENT_SECURITY_POLICY,
    ]);
  });
});
