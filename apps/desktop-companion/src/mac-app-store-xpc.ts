import { lstat, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { requireElectronSingleInstance, type ElectronApplicationLockPort } from "./electron-security.js";

/** Explicit source-selected XPC store target. This macOS Team-ID group holds
 * only native fence files and is never a Keychain access group. */
export const STORE_XPC_APPLICATION_GROUP = "JVV65668U6.com.cosmaneura.scribe.beta.desktop.store";
export function requireMacAppStoreXpcRuntime(runtime: { readonly mas?: boolean; readonly electron?: string; readonly node: string }): void {
  if (runtime.mas !== true || runtime.electron !== "44.4.3" || !runtime.node.startsWith("24.")) {
    throw new Error("mac_app_store_xpc_distribution_unavailable");
  }
}

/** Only a freshly validated child of Electron's OS temp directory may redirect
 * Chromium's fixed sandbox socket directory. The durable userData lock stays
 * unchanged; the override exists only during the synchronous lock acquisition. */
const preparedSingletonTemps = new WeakSet<MacAppStoreSingletonTemp>();
function requireNoSingletonTempOverride(): void {
  if (process.env.MAC_CHROMIUM_TMPDIR !== undefined) throw unavailable();
}
export class MacAppStoreSingletonTemp {
  #directory: string;
  #used = false;
  private constructor(directory: string) { this.#directory = directory; Object.freeze(this); }

  static isPrepared(value: unknown): value is MacAppStoreSingletonTemp {
    return value instanceof MacAppStoreSingletonTemp && preparedSingletonTemps.has(value);
  }

  static requireNoInheritedOverride(): void {
    requireNoSingletonTempOverride();
  }

  static async prepare(osTempDirectory: string): Promise<MacAppStoreSingletonTemp> {
    requireNoSingletonTempOverride();
    if (!isAbsolute(osTempDirectory)) throw unavailable();
    const root = await realpath(osTempDirectory);
    const before = await lstat(root);
    if (!before.isDirectory() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o700) throw unavailable();
    const directory = await mkdtemp(join(root, "s"));
    const info = await lstat(directory);
    const after = await lstat(root);
    // Chromium152 macOS bind/connect accept253 bytes in their oversized
    // sockaddr, including the complete generated socket path, without a NUL.
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700
      || await realpath(directory) !== directory || before.dev !== after.dev || before.ino !== after.ino
      || after.uid !== before.uid || after.mode !== before.mode
      || Buffer.byteLength(join(directory, "S", "SingletonSocket"), "utf8") > 253) throw unavailable();
    requireNoSingletonTempOverride();
    // No old socket, cookie, lock or directory is removed. The OS owns cleanup
    // of this per-launch temporary parent; Chromium owns only its fresh S child.
    const temporary = new MacAppStoreSingletonTemp(directory);
    preparedSingletonTemps.add(temporary);
    return temporary;
  }

  static acquire(temporary: MacAppStoreSingletonTemp, application: ElectronApplicationLockPort): boolean {
    if (!preparedSingletonTemps.has(temporary) || temporary.#used) throw unavailable();
    requireNoSingletonTempOverride();
    temporary.#used = true;
    process.env.MAC_CHROMIUM_TMPDIR = temporary.#directory;
    try { return requireElectronSingleInstance(application); }
    finally { delete process.env.MAC_CHROMIUM_TMPDIR; }
  }
}
/** Resolve only the Store child of the OS-provided appData path. Existing
 * links, foreign ownership or broad modes fail without repair or migration. */
export async function prepareMacAppStoreUserData(appData: string): Promise<string> {
  if (!isAbsolute(appData) || await realpath(appData) !== appData) throw unavailable();
  const parent = await lstat(appData);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.()) throw unavailable();
  const directory = join(appData, "Cosmaneura Scribe Store");
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw unavailable(); }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0
    || await realpath(directory) !== directory) throw unavailable();
  return directory;
}
function unavailable(): Error { return new Error("mac_app_store_xpc_distribution_unavailable"); }
