/**
 * Mocked Electron Store entry smoke tests. These do not exercise a sandboxed
 * Release binary, Apple signing, or real entitlements — only the composed
 * MAS+XPC entry under vitest Electron mocks.
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
import { STORE_LAUNCH_FAILURE, STORE_LAUNCH_RETRY_LIMIT } from "./store-launch-recovery.js";

describe("mocked Electron Store entry smoke", () => {
  afterEach(() => {
    vi.doUnmock("electron");
    vi.doUnmock("./mac-app-store-xpc.js");
    vi.doUnmock("../standalone/provider-host.mjs");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function harness(options: {
    dialogResponses?: number[];
    openFailuresBeforeSuccess?: number;
    failMessageBox?: boolean;
  } = {}) {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-store-entry-smoke-")));
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
        send: vi.fn(),
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
      show() { events.push("show"); }
      focus() { events.push("focus"); }
      showInactive() {}
      isVisible() { return true; }
      isMinimized() { return false; }
      getMediaSourceId() { return "window:73:0"; }
      getMinimumSize(): [number, number] { return [520, 520]; }
      getBounds() { return { x: 0, y: 0, width: 1100, height: 800 }; }
      setBounds() {}
      setMinimumSize() {}
      setAlwaysOnTop() {}
      setVisibleOnAllWorkspaces() {}
      isDestroyed() { return this.destroyed; }
      destroy() {
        this.destroyed = true;
        events.push("destroy");
        this.webContents.emit("destroyed");
      }
    }

    const responses = options.dialogResponses ?? [1];
    let dialogIndex = 0;
    const showMessageBox = vi.fn(async () => {
      if (options.failMessageBox) throw new Error("Invented dialog failure");
      const response = responses[Math.min(dialogIndex, responses.length - 1)]!;
      dialogIndex += 1;
      events.push(`dialog${response}`);
      return { response };
    });
    const showErrorBox = vi.fn(() => { events.push("error_box"); });
    const quit = vi.fn(() => { events.push("quit"); });
    const runtime = {
      app: Object.assign(app, {
        isPackaged: true,
        getName: (): string => "Cosmaneura Scribe Store",
        getAppPath: () => directory,
        getPath: vi.fn((name?: string) =>
          name === "temp" ? directory : join(directory, "user-data"),
        ),
        setPath: vi.fn(),
        setAboutPanelOptions: vi.fn(),
        requestSingleInstanceLock: vi.fn(() => {
          events.push("lock");
          return true;
        }),
        whenReady: () => Promise.resolve(),
        quit,
      }),
      screen: {
        getDisplayMatching: () => ({ workArea: { x: 0, y: 24, width: 1440, height: 860 } }),
      },
      protocol: {
        registerSchemesAsPrivileged: vi.fn(() => { events.push("scheme_registration"); }),
      },
      session: { fromPartition: vi.fn(() => session) },
      BrowserWindow: MockWindow,
      ipcMain: {
        handle: (channel: string, callback: unknown) => { handlers.set(channel, callback); },
        removeHandler: (channel: string) => { handlers.delete(channel); },
      },
      dialog: { showMessageBox, showErrorBox },
      Menu: {
        buildFromTemplate: vi.fn((template: unknown) => template),
        setApplicationMenu: vi.fn(),
      },
    };

    const owner: DesktopProviderOwner = {
      dispose: vi.fn(async () => { events.push("stop"); }),
      host: {
        session: {
          getState: async () => ({ phase: "signedOut", revision: crypto.randomUUID() }),
          signIn: async () => { throw new Error("No real sign-in in this check"); },
          signOut: async () => ({ phase: "signedOut", revision: crypto.randomUUID() }),
          addListener: async () => ({ remove: async () => undefined }),
        },
        connect: async () => { throw new Error("No real backend in this check"); },
      },
    };
    let openAttempts = 0;
    const failures = options.openFailuresBeforeSuccess ?? 0;
    const open = vi.fn(async () => {
      openAttempts += 1;
      events.push("open");
      if (openAttempts <= failures) throw new Error("Invented native Store service unavailable");
      return owner;
    });

    const prepare = vi.fn(async () => {
      const userData = join(directory, "user-data");
      await mkdir(userData, { recursive: true, mode: 0o700 });
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
      versions: { value: { ...process.versions, electron: "44.9.1", node: "24.10.0" } },
      env: { value: { ...process.env } },
      stderr: {
        value: Object.assign(Object.create(process.stderr), { write: vi.fn(() => true) }),
      },
    });
    vi.stubGlobal("process", processPort);
    vi.doMock("electron", () => runtime);
    vi.doMock("./mac-app-store-xpc.js", () => ({
      ...actual,
      prepareMacAppStoreUserData: prepare,
    }));
    vi.doMock("../standalone/provider-host.mjs", () => ({ openProvider: open }));

    const entry = "../standalone/main-mas-xpc.mjs";
    await import(entry);
    return {
      events, windows, open, quit, showMessageBox, showErrorBox, handlers,
      cleanup: async () => {
        prepareTemp.mockRestore();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }

  it("reaches the first Store screen without a launch dialog on a clean open", async () => {
    const h = await harness();
    try {
      await vi.waitFor(() => {
        expect(h.windows[0]).toBeTruthy();
        expect(h.events).toContain("show");
      });
      expect(h.showMessageBox).not.toHaveBeenCalled();
      expect(h.open).toHaveBeenCalledOnce();
      expect(h.quit).not.toHaveBeenCalled();
      expect(STORE_LAUNCH_FAILURE.buttons).toEqual(["Try again", "Quit"]);
    } finally {
      await h.cleanup();
    }
  });

  it("retries once on Try again (response 0) without quitting, then shows a window", async () => {
    const h = await harness({ openFailuresBeforeSuccess: 1, dialogResponses: [0] });
    try {
      await vi.waitFor(() => {
        expect(h.windows[0]).toBeTruthy();
        expect(h.events).toContain("show");
      });
      expect(h.showMessageBox).toHaveBeenCalledOnce();
      expect(h.open).toHaveBeenCalledTimes(2);
      expect(h.quit).not.toHaveBeenCalled();
      expect(h.events).toEqual(expect.arrayContaining([
        "scheme_registration", "lock", "open", "dialog0", "lock", "open", "window", "show",
      ]));
      expect(h.events).not.toContain("quit");
    } finally {
      await h.cleanup();
    }
  });

  it("quits exactly once after failures when the user picks Quit", async () => {
    const h = await harness({ openFailuresBeforeSuccess: 3, dialogResponses: [0, 0, 1] });
    try {
      await vi.waitFor(() => expect(h.quit).toHaveBeenCalledOnce());
      expect(h.showMessageBox).toHaveBeenCalledTimes(3);
      expect(h.open).toHaveBeenCalledTimes(3);
      expect(h.windows[0]).toBeUndefined();
      expect(h.events.filter(event => event === "quit")).toEqual(["quit"]);
    } finally {
      await h.cleanup();
    }
  });

  it("caps Try again attempts then shows a final Quit-only dialog", async () => {
    const h = await harness({
      openFailuresBeforeSuccess: STORE_LAUNCH_RETRY_LIMIT + 2,
      dialogResponses: [0, 0, 0],
    });
    try {
      await vi.waitFor(() => expect(h.quit).toHaveBeenCalledOnce());
      // Two Try again responses, then the final Quit-only dialog (still response index 0 button).
      expect(h.showMessageBox).toHaveBeenCalledTimes(STORE_LAUNCH_RETRY_LIMIT + 1);
      expect(h.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
        buttons: ["Quit"],
      }));
      expect(h.open).toHaveBeenCalledTimes(STORE_LAUNCH_RETRY_LIMIT + 1);
    } finally {
      await h.cleanup();
    }
  });

  it("falls back to showErrorBox and quits when showMessageBox rejects", async () => {
    const h = await harness({ openFailuresBeforeSuccess: 1, failMessageBox: true });
    try {
      await vi.waitFor(() => expect(h.quit).toHaveBeenCalledOnce());
      expect(h.showErrorBox).toHaveBeenCalledOnce();
      expect(h.events).toContain("error_box");
      expect(h.windows[0]).toBeUndefined();
    } finally {
      await h.cleanup();
    }
  });
});
