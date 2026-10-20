import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MacAppStoreSingletonTemp, prepareMacAppStoreUserData, requireMacAppStoreXpcRuntime } from "./mac-app-store-xpc.js";
import type * as FsPromisesModule from "node:fs/promises";


const faults = vi.hoisted(() => ({ kind: "none", root: "", rootReads: 0, child: "" }));
vi.mock("node:fs/promises", async () => {
  const fs = await vi.importActual<typeof FsPromisesModule>("node:fs/promises");
  return { ...fs,
    mkdtemp: async (prefix: string) => {
      const directory = await fs.mkdtemp(prefix); faults.child = directory;
      if (faults.kind === "broad-child") await fs.chmod(directory, 0o755);
      if (faults.kind === "file-child") { await fs.rmdir(directory); await fs.writeFile(directory, "invented non-directory", { mode: 0o600 }); }
      if (faults.kind === "linked-child") {
        const target = directory + "-target"; await fs.mkdir(target, { mode: 0o700 });
        await fs.rmdir(directory); await fs.symlink(target, directory);
      }
      return directory;
    },
    lstat: async (path: Parameters<typeof fs.lstat>[0]) => {
      const info = await fs.lstat(path);
      if (String(path) === faults.root) {
        faults.rootReads++;
        if (faults.kind === "foreign-root") return Object.assign(Object.create(info) as typeof info, { uid: info.uid + 1 });
        if (faults.kind === "raced-root" && faults.rootReads === 2) return Object.assign(Object.create(info) as typeof info, { ino: info.ino + 1 });
      }
      if (faults.kind === "foreign-child" && String(path) === faults.child) return Object.assign(Object.create(info) as typeof info, { uid: info.uid + 1 });
      return info;
    },
  };
});
beforeEach(() => { vi.stubEnv("MAC_CHROMIUM_TMPDIR", undefined); });
afterEach(() => { faults.kind = "none"; faults.root = ""; faults.rootReads = 0; faults.child = ""; vi.unstubAllEnvs(); });

it("rejects direct Electron and mismatched vendor runtimes", () => {
  for (const runtime of [
    { electron: "44.4.3", node: "24.19.0" },
    { mas: false, electron: "44.4.3", node: "24.19.0" },
    { mas: true, electron: "44.4.2", node: "24.19.0" },
    { mas: true, electron: "44.4.3", node: "25.0.0" },
  ]) expect(() => requireMacAppStoreXpcRuntime(runtime)).toThrow("mac_app_store_xpc_distribution_unavailable");
});
it("reaches the separately validated native boundary with the official MAS runtime", () => {
  expect(() => requireMacAppStoreXpcRuntime({ mas: true, electron: "44.4.3", node: "24.19.0" })).not.toThrow();
});
it("creates and reopens only a private Store userData child", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scribe-store-data-check-")));
  try {
    const directory = await prepareMacAppStoreUserData(root);
    expect(directory).toBe(join(root, "Cosmaneura Scribe Store"));
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect(await prepareMacAppStoreUserData(root)).toBe(directory);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("rejects a Store link into old data without opening or changing the old data", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scribe-store-data-check-")));
  try {
    const old = join(root, "old-direct-fixture"); await mkdir(old, { mode: 0o700 });
    await writeFile(join(old, "retained"), "invented old custody");
    await symlink(old, join(root, "Cosmaneura Scribe Store"));
    await expect(prepareMacAppStoreUserData(root)).rejects.toThrow("unavailable");
    expect(await readFile(join(old, "retained"), "utf8")).toBe("invented old custody");
    expect((await lstat(join(root, "Cosmaneura Scribe Store"))).isSymbolicLink()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("rejects broad existing modes without chmod or migration", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scribe-store-data-check-")));
  try {
    const directory = join(root, "Cosmaneura Scribe Store"); await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
    await expect(prepareMacAppStoreUserData(root)).rejects.toThrow("unavailable");
    expect((await lstat(directory)).mode & 0o777).toBe(0o755);
  } finally { await rm(root, { recursive: true, force: true }); }
});


it.each([true, false, "throw"] as const)("scopes the fresh Chromium override to the actual lock call (%s) and consumes its capability", async result => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scribe-store-temp-check-")));
  try {
    const temporary = await MacAppStoreSingletonTemp.prepare(root); let observed: string | undefined;
    const app = { requestSingleInstanceLock: vi.fn(() => {
      observed = process.env.MAC_CHROMIUM_TMPDIR;
      expect(observed?.startsWith(root + "/s")).toBe(true);
      if (result === "throw") throw new Error("invented lock error");
      return result;
    }), quit: vi.fn() };
    if (result === "throw") expect(() => MacAppStoreSingletonTemp.acquire(temporary, app)).toThrow("invented lock error");
    else expect(MacAppStoreSingletonTemp.acquire(temporary, app)).toBe(result);
    expect(process.env.MAC_CHROMIUM_TMPDIR).toBeUndefined();
    expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledTimes(result === false ? 1 : 0);
    expect((await lstat(observed!)).mode & 0o777).toBe(0o700); expect(Object.isFrozen(temporary)).toBe(true);
    expect(() => MacAppStoreSingletonTemp.acquire(temporary, app)).toThrow("unavailable");
    expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("creates distinct canonical temporary children while retaining the same Store userData", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scribe-store-temp-check-")));
  try {
    const userData = await prepareMacAppStoreUserData(root);
    const paths: string[] = [];
    for (let index = 0; index < 2; index++) {
      const temporary = await MacAppStoreSingletonTemp.prepare(root);
      MacAppStoreSingletonTemp.acquire(temporary, { requestSingleInstanceLock: () => { paths.push(process.env.MAC_CHROMIUM_TMPDIR!); return true; }, quit: vi.fn() });
    }
    expect(paths[0]).not.toBe(paths[1]);
    for (const path of paths) expect(await realpath(path)).toBe(path);
    expect(await prepareMacAppStoreUserData(root)).toBe(userData);
    expect(userData).toBe(join(root, "Cosmaneura Scribe Store")); expect(process.env.MAC_CHROMIUM_TMPDIR).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("rejects inherited overrides before path I/O and rejects an override added before acquisition", async () => {
  vi.stubEnv("MAC_CHROMIUM_TMPDIR", "/invented/caller-selected-temp");
  expect(() => MacAppStoreSingletonTemp.requireNoInheritedOverride()).toThrow("unavailable");
  await expect(MacAppStoreSingletonTemp.prepare("/invented/nonexistent-temp")).rejects.toThrow("unavailable");
  expect(process.env.MAC_CHROMIUM_TMPDIR).toBe("/invented/caller-selected-temp");
  vi.stubEnv("MAC_CHROMIUM_TMPDIR", undefined);
  const root = await realpath(await mkdtemp(join(tmpdir(), "scribe-store-temp-check-")));
  try {
    const temporary = await MacAppStoreSingletonTemp.prepare(root), app = { requestSingleInstanceLock: vi.fn(() => true), quit: vi.fn() };
    vi.stubEnv("MAC_CHROMIUM_TMPDIR", "/invented/later-override");
    expect(() => MacAppStoreSingletonTemp.acquire(temporary, app)).toThrow("unavailable");
    expect(app.requestSingleInstanceLock).not.toHaveBeenCalled(); expect(process.env.MAC_CHROMIUM_TMPDIR).toBe("/invented/later-override");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("refuses a forged capability before calling the lock", () => {
  const app = { requestSingleInstanceLock: vi.fn(() => true), quit: vi.fn() };
  for (const forged of [Object.create(MacAppStoreSingletonTemp.prototype), Reflect.construct(MacAppStoreSingletonTemp, ["/invented/constructor-path"])]) {
    expect(MacAppStoreSingletonTemp.isPrepared(forged)).toBe(false);
    expect(() => MacAppStoreSingletonTemp.acquire(forged, app)).toThrow();
    expect(() => MacAppStoreSingletonTemp.acquire.call({ isPrepared: () => true, requireNoInheritedOverride: () => undefined }, forged, app)).toThrow();
  }
  expect(app.requestSingleInstanceLock).not.toHaveBeenCalled(); expect(process.env.MAC_CHROMIUM_TMPDIR).toBeUndefined();
});
it.each(["broad-child", "file-child", "linked-child", "foreign-child", "foreign-root", "raced-root"])("fails closed for %s without repairing the fixture", async kind => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scribe-store-temp-check-")));
  try {
    faults.root = root; faults.kind = kind; faults.rootReads = 0;
    await expect(MacAppStoreSingletonTemp.prepare(root)).rejects.toThrow("unavailable");
    faults.kind = "none";
    if (kind === "broad-child") expect((await lstat(faults.child)).mode & 0o777).toBe(0o755);
    if (kind === "linked-child") expect((await lstat(faults.child)).isSymbolicLink()).toBe(true);
    if (kind === "file-child") expect((await lstat(faults.child)).isFile()).toBe(true);
    expect((await lstat(root)).mode & 0o777).toBe(0o700); expect(process.env.MAC_CHROMIUM_TMPDIR).toBeUndefined();
  } finally { faults.kind = "none"; await rm(root, { recursive: true, force: true }); }
});
it("canonicalizes an OS root alias but rejects broad, relative and non-directory roots", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "scribe-store-temp-check-")));
  try {
    const canonical = join(root, "canonical"), alias = join(root, "alias"); await mkdir(canonical, { mode: 0o700 }); await symlink(canonical, alias);
    const temporary = await MacAppStoreSingletonTemp.prepare(alias); let child: string | undefined;
    MacAppStoreSingletonTemp.acquire(temporary, { requestSingleInstanceLock: () => { child = process.env.MAC_CHROMIUM_TMPDIR; return true; }, quit: vi.fn() });
    expect(child!.startsWith(canonical + "/s")).toBe(true); expect(await realpath(child!)).toBe(child);
    await chmod(canonical, 0o755); await expect(MacAppStoreSingletonTemp.prepare(canonical)).rejects.toThrow("unavailable");
    expect((await lstat(canonical)).mode & 0o777).toBe(0o755);
    const file = join(root, "file"); await writeFile(file, "invented regular file");
    await expect(MacAppStoreSingletonTemp.prepare(file)).rejects.toThrow("unavailable");
    await expect(MacAppStoreSingletonTemp.prepare("relative")).rejects.toThrow("unavailable");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.each([253, 254])("checks the complete generated socket path by UTF-8 bytes (%i)", async targetBytes => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "scribe-store-temp-check-")));
  try {
    const suffix = "/sXXXXXX/S/SingletonSocket", available = targetBytes - Buffer.byteLength(base + "/" + suffix, "utf8");
    expect(available).toBeGreaterThan(0);
    const root = join(base, "界".repeat(Math.floor(available / 3)) + "x".repeat(available % 3)); await mkdir(root, { mode: 0o700 });
    if (targetBytes === 254) await expect(MacAppStoreSingletonTemp.prepare(root)).rejects.toThrow("unavailable");
    else {
      const temporary = await MacAppStoreSingletonTemp.prepare(root); let child: string | undefined;
      MacAppStoreSingletonTemp.acquire(temporary, { requestSingleInstanceLock: () => { child = process.env.MAC_CHROMIUM_TMPDIR; return true; }, quit: vi.fn() });
      expect(Buffer.byteLength(join(child!, "S", "SingletonSocket"), "utf8")).toBe(253);
    }
    expect(process.env.MAC_CHROMIUM_TMPDIR).toBeUndefined();
  } finally { await rm(base, { recursive: true, force: true }); }
});
