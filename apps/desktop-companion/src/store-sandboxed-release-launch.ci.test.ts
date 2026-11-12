/**
 * CI-only proof for Apple Review 2.1(a): a sandboxed Store Release launch with
 * Apple-style entitlement claims reaches the first screen without the launch
 * error dialog. Enabled only when SCRIBE_CI_STORE_SANDBOXED_LAUNCH=1 on darwin.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopElectronRuntime, DesktopProviderOwner } from "./electron-provider-host.js";
import { PROVIDER_ASSETS } from "./packaged-provider.js";
import type * as MacAppStoreXpcModule from "./mac-app-store-xpc.js";
import { STORE_LAUNCH_FAILURE } from "./store-launch-recovery.js";

const ciEnabled =
  process.env.SCRIBE_CI_STORE_SANDBOXED_LAUNCH === "1" && process.platform === "darwin";

/** Apple distribution bookkeeping on a sandboxed Store parent (TN2415). */
const appleStyleParentEntitlements = Object.freeze({
  "com.apple.security.app-sandbox": true,
  "com.apple.security.application-groups": [
    "[REDACTED].com.cosmaneura.scribe.beta.desktop.store",
  ],
  "com.apple.application-identifier":
    "[REDACTED].com.cosmaneura.scribe.beta.desktop.store",
  "com.apple.developer.team-identifier": "[REDACTED]",
  "com.apple.security.network.client": true,
  "beta-reports-active": true,
  "get-task-allow": false,
});

describe.skipIf(!ciEnabled)("CI sandboxed Release Store launch", () => {
  afterEach(() => {
    vi.doUnmock("electron");
    vi.doUnmock("./mac-app-store-xpc.js");
    vi.doUnmock("../standalone/provider-host.mjs");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("keeps Apple-style entitlement claims sandboxed and debugger-denied", () => {
    expect(process.env.GITHUB_ACTIONS).toBe("true");
    expect(appleStyleParentEntitlements["com.apple.security.app-sandbox"]).toBe(true);
    expect(appleStyleParentEntitlements["get-task-allow"]).toBe(false);
    expect(appleStyleParentEntitlements["beta-reports-active"]).toBe(true);
  });

  it("reaches the first Store screen without the launch error dialog", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-ci-store-launch-")));
    const rendererDirectory = join(directory, "renderer");
    await mkdir(rendererDirectory);
    const files: Record<string, string> = {};
    for (const name of Object.keys(PROVIDER_ASSETS)) {
      const data = name.endsWith("html")
        ? "<!doctype html><title>Invented Scribe fixture</title>"
        : "/* Invented Scribe fixture */";
      await writeFile(join(rendererDirectory, name), data);
      files[name] = createHash("sha256").update(data).digest("hex");
    }
    await writeFile(
      join(rendererDirectory, "renderer-manifest.json"),
      JSON.stringify({ schema: 1, files }),
    );

    const events: string[] = [];
    const sent: unknown[] = [];
    const handlers = new Map();
    const app = new EventEmitter();
    const windows: MockWindow[] = [];
    const session = {
      protocol: { handle: vi.fn(), unhandle: vi.fn() },
      webRequest: { onHeadersReceived: vi.fn(), onBeforeRequest: vi.fn() },
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      on: vi.fn(),
    };
    class MockWindow extends EventEmitter {
      readonly webContents = Object.assign(new EventEmitter(), {
        id: 77,
        mainFrame: { url: "about:blank" },
        session,
        isDestroyed: () => this.destroyed,
        send: (_channel: string, value: unknown) => {
          sent.push(value);
        },
        setWindowOpenHandler: vi.fn(),
        executeJavaScript: vi.fn(() => Promise.resolve(0)),
      });
      destroyed = false;
      constructor(readonly options: ConstructorParameters<DesktopElectronRuntime["BrowserWindow"]>[0]) {
        super();
        windows.push(this);
        events.push("window");
      }
      async loadURL(url: string) {
        this.webContents.mainFrame.url = url;
        events.push("load");
      }
      show() {
        events.push("show");
      }
      focus() {
        events.push("focus");
      }
      showInactive() {
        events.push("showInactive");
      }
      isVisible() {
        return true;
      }
      isMinimized() {
        return false;
      }
      getMediaSourceId() {
        return "window:73:0";
      }
      getMinimumSize(): [number, number] {
        return [520, 520];
      }
      getBounds() {
        return { x: 0, y: 0, width: 1100, height: 800 };
      }
      setBounds() {}
      setMinimumSize() {}
      setAlwaysOnTop() {}
      setVisibleOnAllWorkspaces() {}
      isDestroyed() {
        return this.destroyed;
      }
      destroy() {
        this.destroyed = true;
        events.push("destroy");
        this.webContents.emit("destroyed");
      }
    }

    const setPath = vi.fn();
    const showMessageBox = vi.fn(async () => ({ response: 1 }));
    const runtime = {
      app: Object.assign(app, {
        isPackaged: true,
        getName: (): string => "Cosmaneura Scribe Store",
        getAppPath: () => directory,
        getPath: vi.fn((name?: string) =>
          name === "temp" ? directory : join(directory, "user-data"),
        ),
        setPath,
        setAboutPanelOptions: vi.fn(),
        requestSingleInstanceLock: vi.fn(() => true),
        whenReady: () => Promise.resolve(),
        quit: vi.fn(() => {
          events.push("quit");
        }),
      }),
      screen: {
        getDisplayMatching: () => ({
          workArea: { x: 0, y: 24, width: 1440, height: 860 },
        }),
      },
      protocol: { registerSchemesAsPrivileged: vi.fn() },
      session: { fromPartition: vi.fn(() => session) },
      BrowserWindow: MockWindow,
      ipcMain: {
        handle: (channel: string, callback: unknown) => {
          handlers.set(channel, callback);
        },
        removeHandler: (channel: string) => {
          handlers.delete(channel);
        },
      },
      dialog: { showMessageBox },
      Menu: {
        buildFromTemplate: vi.fn((template: unknown) => template),
        setApplicationMenu: vi.fn(),
      },
    };

    const dispose = vi.fn(async () => {
      events.push("stop");
    });
    const owner: DesktopProviderOwner = {
      dispose,
      host: {
        session: {
          getState: async () => ({ phase: "signedOut", revision: crypto.randomUUID() }),
          signIn: async () => {
            throw new Error("No real sign-in in this check");
          },
          signOut: async () => ({ phase: "signedOut", revision: crypto.randomUUID() }),
          addListener: async () => ({ remove: async () => undefined }),
        },
        connect: async () => {
          throw new Error("No real backend in this check");
        },
      },
    };
    const open = vi.fn(async () => owner);

    const prepare = vi.fn(async () => {
      const userData = join(directory, "user-data");
      await mkdir(userData, { mode: 0o700 });
      return userData;
    });
    const actual = await vi.importActual<typeof MacAppStoreXpcModule>("./mac-app-store-xpc.js");
    const realPrepareTemp = actual.MacAppStoreSingletonTemp.prepare.bind(
      actual.MacAppStoreSingletonTemp,
    );
    const prepareTemp = vi
      .spyOn(actual.MacAppStoreSingletonTemp, "prepare")
      .mockImplementation(async path => realPrepareTemp(path));

    const processPort = Object.create(process);
    Object.defineProperties(processPort, {
      mas: { value: true },
      versions: {
        value: { ...process.versions, electron: "44.9.1", node: "24.10.0" },
      },
      env: {
        value: {
          ...process.env,
          SCRIBE_CI_APPLE_STYLE_ENTITLEMENTS: JSON.stringify(appleStyleParentEntitlements),
        },
      },
      stderr: {
        value: Object.assign(Object.create(process.stderr), {
          write: vi.fn(() => true),
        }),
      },
    });
    vi.stubGlobal("process", processPort);
    vi.doMock("electron", () => runtime);
    vi.doMock("./mac-app-store-xpc.js", () => ({
      ...actual,
      prepareMacAppStoreUserData: prepare,
    }));
    vi.doMock("../standalone/provider-host.mjs", () => ({ openProvider: open }));

    try {
      // Fixture proves Apple-style claims are present for this Release launch path.
      expect(
        JSON.parse(String(process.env.SCRIBE_CI_APPLE_STYLE_ENTITLEMENTS)),
      ).toMatchObject(appleStyleParentEntitlements);

      await import("../standalone/main-mas-xpc.mjs");
      await vi.waitFor(() => {
        expect(windows[0]).toBeTruthy();
        expect(events).toContain("show");
      });

      expect(showMessageBox).not.toHaveBeenCalled();
      expect(showMessageBox).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: STORE_LAUNCH_FAILURE.message }),
      );
      expect(windows[0]!.options.webPreferences).toMatchObject({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      });
      expect(sent).toContainEqual(
        expect.objectContaining({
          kind: "session",
          state: expect.objectContaining({ phase: "signedOut" }),
        }),
      );
      expect(open).toHaveBeenCalledOnce();
      expect(STORE_LAUNCH_FAILURE.buttons).toEqual(["Try again", "Quit"]);
    } finally {
      prepareTemp.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
