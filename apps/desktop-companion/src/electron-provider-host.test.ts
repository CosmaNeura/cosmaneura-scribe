import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startElectronProvider, type DesktopElectronRuntime, type DesktopProviderOwner } from "./electron-provider-host.js";
import { loadPackagedProvider, PROVIDER_ASSETS, PROVIDER_ENTRY } from "./packaged-provider.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "scribe-host-test-"))), rendererDirectory = join(directory, "renderer");
  await mkdir(rendererDirectory);
  const files: Record<string, string> = {};
  for (const name of Object.keys(PROVIDER_ASSETS)) {
    const data = name.endsWith("html") ? "<!doctype html><title>Invented Scribe fixture</title>" : "/* Invented Scribe fixture */";
    await writeFile(join(rendererDirectory, name), data); files[name] = createHash("sha256").update(data).digest("hex");
  }
  await writeFile(join(rendererDirectory, "renderer-manifest.json"), JSON.stringify({ schema: 1, files }));
  const events: string[] = [], sent: unknown[] = [], handlers = new Map(), app = new EventEmitter();
  const windows: MockWindow[] = [];
  let refuseClose = false, ready: Promise<void> = Promise.resolve();
  const session = {
    protocol: { handle: vi.fn(), unhandle: vi.fn() }, webRequest: { onHeadersReceived: vi.fn(), onBeforeRequest: vi.fn() },
    setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), on: vi.fn(),
  };
  class MockWindow extends EventEmitter {
    readonly webContents = Object.assign(new EventEmitter(), { id: 77, mainFrame: { url: "about:blank" }, session,
      isDestroyed: () => this.destroyed, send: (_channel: string, value: unknown) => { sent.push(value); },
      setWindowOpenHandler: vi.fn(), executeJavaScript: vi.fn(() => Promise.resolve(0)) });
    destroyed = false;
    constructor(readonly options: ConstructorParameters<DesktopElectronRuntime["BrowserWindow"]>[0]) { super(); windows.push(this); events.push("window"); }
    async loadURL(url: string) {
      expect(this.webContents.setWindowOpenHandler).toHaveBeenCalledOnce();
      expect(session.setPermissionRequestHandler).toHaveBeenCalledOnce();
      expect(handlers.has("scribe:provider:workspace:v1")).toBe(true);
      this.webContents.mainFrame.url = url; events.push("load");
    }
    show() { events.push("show"); } focus() { events.push("focus"); }
    showInactive() { events.push("showInactive"); }
    isVisible() { return true; } isMinimized() { return false; }
    getMediaSourceId() { return "window:73:0"; }
    getMinimumSize(): [number, number] { return [520, 520]; }
    getBounds() { return { x: 0, y: 0, width: 1100, height: 800 }; }
    setBounds() {} setMinimumSize() {} setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; events.push("destroy"); this.webContents.emit("destroyed"); }
  }
  const runtime = {
    app: Object.assign(app, { isPackaged: true, getName: (): string => "Cosmaneura Scribe Beta", getAppPath: () => directory,
      getPath: () => join(directory, "user-data"), requestSingleInstanceLock: vi.fn(() => true),
      whenReady: () => ready, quit: vi.fn(() => { events.push("quit"); }) }),
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 24, width: 1440, height: 860 } }) },
    protocol: { registerSchemesAsPrivileged: vi.fn() }, session: { fromPartition: vi.fn(() => session) }, BrowserWindow: MockWindow,
    ipcMain: { handle: (channel: string, callback: unknown) => { handlers.set(channel, callback); }, removeHandler: (channel: string) => { handlers.delete(channel); } },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
  } satisfies DesktopElectronRuntime;
  const dispose = vi.fn(async () => { events.push("stop"); if (refuseClose) throw new Error("Invented unconfirmed stop"); });
  const owner: DesktopProviderOwner = { dispose, host: {
    session: { getState: async () => ({ phase: "signedOut", revision: crypto.randomUUID() }),
      signIn: async () => { throw new Error("No real sign-in in this check"); },
      signOut: async () => ({ phase: "signedOut", revision: crypto.randomUUID() }),
      addListener: async () => ({ remove: async () => undefined }) },
    connect: async () => { throw new Error("No real backend in this check"); },
  } };
  const factory = { open: vi.fn(async () => owner) };
  return { directory, rendererDirectory, runtime, factory, owner, events, sent, handlers, dispose,
    get window() { return windows[0] ?? null; }, refuseClose: (value: boolean) => { refuseClose = value; },
    waitReady: (value: Promise<void>) => { ready = value; }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

describe("packaged desktop provider host", () => {
  it("serves only verified renderer assets without request-derived file access", async () => {
    const f = await fixture();
    try {
      const assets = await loadPackagedProvider(f.rendererDirectory), response = assets.respond({ url: PROVIDER_ENTRY, method: "GET" });
      expect(response.status).toBe(200); expect(response.headers.get("content-security-policy")).toContain("media-src blob:");
      for (const url of ["https://example.invalid/", "app://cosmas/../preload.cjs", "app://cosmas/%70rovider.html", PROVIDER_ENTRY + "?path=preload.cjs", "app://cosmas/renderer-manifest.json"]) {
        expect(assets.respond({ url, method: "GET" }).status).toBe(404);
      }
      expect(assets.respond({ url: PROVIDER_ENTRY, method: "POST" }).status).toBe(404);
      await writeFile(join(f.rendererDirectory, "provider-capture.js"), "changed");
      await expect(loadPackagedProvider(f.rendererDirectory)).rejects.toThrow("verified");
    } finally { await f.cleanup(); }
  });
  it("requires the intended packaged application and single-instance lock before opening a host", async () => {
    const f = await fixture();
    try {
      f.runtime.app.isPackaged = false;
      await expect(startElectronProvider(f.runtime, f.factory)).rejects.toThrow("unavailable");
      f.runtime.app.isPackaged = true; f.runtime.app.requestSingleInstanceLock.mockReturnValue(false);
      expect(await startElectronProvider(f.runtime, f.factory)).toBeNull();
      expect(f.factory.open).not.toHaveBeenCalled(); expect(f.window).toBeNull(); expect(f.runtime.app.quit).toHaveBeenCalledOnce();
    } finally { await f.cleanup(); }
  });
  it("opens the Store name only when its compiled entry selects that name", async () => {
    const f = await fixture();
    try {
      f.runtime.app.getName = () => "Cosmaneura Scribe Store";
      await expect(startElectronProvider(f.runtime, f.factory)).rejects.toThrow("unavailable");
      expect(f.factory.open).not.toHaveBeenCalled();
      const application = await startElectronProvider(f.runtime, f.factory, "Cosmaneura Scribe Store");
      expect(application).not.toBeNull();
      await application!.close();
      expect(f.dispose).toHaveBeenCalledOnce();
    } finally { await f.cleanup(); }
  });
  it("installs restricted content and IPC before showing the provider and awaits native disposal before quit", async () => {
    const f = await fixture();
    try {
      const application = await startElectronProvider(f.runtime, f.factory); expect(application).not.toBeNull();
      expect(f.window!.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false });
      expect(f.events).toEqual(["window", "load", "show"]);
      await application!.close();
      expect(f.events.slice(-3)).toEqual(["stop", "destroy", "quit"]);
      expect(f.sent).toContainEqual(expect.objectContaining({ kind: "session", state: expect.objectContaining({ phase: "unavailable" }) }));
      expect(f.handlers.size).toBe(0); await application!.close(); expect(f.dispose).toHaveBeenCalledOnce();
    } finally { await f.cleanup(); }
  });
  it("retains a failed-close owner and window until the same cleanup succeeds", async () => {
    const f = await fixture();
    try {
      const application = await startElectronProvider(f.runtime, f.factory); f.refuseClose(true);
      await expect(application!.close()).rejects.toThrow("unavailable");
      expect(f.window!.destroyed).toBe(false); expect(f.runtime.app.quit).not.toHaveBeenCalled();
      f.refuseClose(false); await application!.close(); expect(f.dispose).toHaveBeenCalledTimes(2);
      expect(f.factory.open).toHaveBeenCalledOnce(); expect(f.window!.destroyed).toBe(true);
    } finally { f.refuseClose(false); await f.cleanup(); }
  });
  it("defers a window close event until the existing owner confirms shutdown", async () => {
    const f = await fixture(), gate = deferred();
    try {
      await startElectronProvider(f.runtime, f.factory);
      f.dispose.mockImplementationOnce(async () => { await gate.promise; });
      const preventDefault = vi.fn(); f.window!.emit("close", { preventDefault });
      await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
      expect(preventDefault).toHaveBeenCalledOnce(); expect(f.window!.destroyed).toBe(false);
      expect(f.runtime.app.quit).not.toHaveBeenCalled();
      gate.resolve(); await vi.waitFor(() => expect(f.runtime.app.quit).toHaveBeenCalledOnce());
      expect(f.window!.destroyed).toBe(true);
    } finally { gate.resolve(); await f.cleanup(); }
  });
  it("keeps an unconfirmed-stop window close retryable without replacing its owner", async () => {
    const f = await fixture();
    try {
      await startElectronProvider(f.runtime, f.factory); f.refuseClose(true);
      const preventDefault = vi.fn(); f.window!.emit("close", { preventDefault });
      await vi.waitFor(() => expect(f.runtime.dialog.showMessageBox).toHaveBeenCalledOnce());
      expect(preventDefault).toHaveBeenCalledOnce(); expect(f.window!.destroyed).toBe(false);
      expect(f.runtime.app.quit).not.toHaveBeenCalled(); expect(f.factory.open).toHaveBeenCalledOnce();
      f.refuseClose(false); f.window!.emit("close", { preventDefault });
      await vi.waitFor(() => expect(f.runtime.app.quit).toHaveBeenCalledOnce());
      expect(f.dispose).toHaveBeenCalledTimes(2); expect(f.factory.open).toHaveBeenCalledOnce();
    } finally { f.refuseClose(false); await f.cleanup(); }
  });
  it("stops an unresponsive renderer before allowing its window to disappear", async () => {
    const f = await fixture();
    try {
      const application = await startElectronProvider(f.runtime, f.factory);
      f.refuseClose(true); f.window!.emit("unresponsive");
      await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(f.runtime.dialog.showMessageBox).toHaveBeenCalledOnce());
      expect(f.window!.destroyed).toBe(false); expect(f.runtime.app.quit).not.toHaveBeenCalled();
      f.refuseClose(false); await application!.close();
      expect(f.events.indexOf("stop")).toBeLessThan(f.events.indexOf("destroy"));
      expect(f.dispose).toHaveBeenCalledTimes(2);
    } finally { f.refuseClose(false); await f.cleanup(); }
  });
  it("owns a late native host when quit arrives during startup", async () => {
    const f = await fixture(), gate = deferred(); f.factory.open.mockImplementation(async () => { await gate.promise; return f.owner; });
    try {
      const starting = startElectronProvider(f.runtime, f.factory); const rejected = expect(starting).rejects.toThrow("unavailable");
      await vi.waitFor(() => expect(f.factory.open).toHaveBeenCalledOnce());
      const preventDefault = vi.fn(); f.runtime.app.emit("before-quit", { preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce(); expect(f.runtime.app.quit).not.toHaveBeenCalled();
      gate.resolve(); await rejected; await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce());
      expect(f.window).toBeNull(); expect(f.events).toEqual(["stop", "quit"]);
    } finally { gate.resolve(); await f.cleanup(); }
  });
  it("does not construct a late host after quit while waiting for Electron readiness", async () => {
    const f = await fixture(), gate = deferred(); f.waitReady(gate.promise);
    try {
      const starting = startElectronProvider(f.runtime, f.factory), rejected = expect(starting).rejects.toThrow("unavailable");
      f.runtime.app.emit("before-quit", { preventDefault: vi.fn() }); gate.resolve(); await rejected;
      expect(f.factory.open).not.toHaveBeenCalled(); expect(f.window).toBeNull();
    } finally { gate.resolve(); await f.cleanup(); }
  });
});
