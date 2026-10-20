import { expect, it } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMacAppStoreUserData, requireMacAppStoreXpcRuntime } from "./mac-app-store-xpc.js";

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
