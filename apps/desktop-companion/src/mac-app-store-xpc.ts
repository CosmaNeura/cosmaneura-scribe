import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Explicit source-selected XPC store target. This macOS Team-ID group holds
 * only native fence files and is never a Keychain access group. */
export const STORE_XPC_APPLICATION_GROUP = "JVV65668U6.com.cosmaneura.scribe.beta.desktop.store";
export function requireMacAppStoreXpcRuntime(runtime: { readonly mas?: boolean; readonly electron?: string; readonly node: string }): void {
  if (runtime.mas !== true || runtime.electron !== "44.4.3" || !runtime.node.startsWith("24.")) {
    throw new Error("mac_app_store_xpc_distribution_unavailable");
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
