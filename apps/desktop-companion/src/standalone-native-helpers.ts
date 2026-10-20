import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { exact, object } from "../../capture/src/provider/desktop-host-protocol";
import { requireMacAppStoreXpcRuntime } from "./mac-app-store-xpc.js";

export const STORE_BRIDGE_BUNDLE_PATH = "Contents/MacOS/ScribeStorePipeBridge";
interface NativeHelper { readonly helperPath: string; readonly helperSha256: string }
interface HelperRoles { readonly auth: unknown; readonly audio: unknown; readonly presentation: unknown }

/** The Store bridge is code in the running app's fixed MacOS location. Profile
 * paths remain declarations, never arbitrary traversal or renderer authority. */
export async function resolveStandaloneNativeHelpers(root: string, profile: HelperRoles): Promise<readonly [NativeHelper, NativeHelper, NativeHelper]> {
  if ("mas" in process && process.mas === true) {
    requireMacAppStoreXpcRuntime({ mas: process.mas, electron: process.versions.electron ?? "", node: process.versions.node });
    const app = dirname(dirname(dirname(root)));
    const executable = join(app, "Contents", "MacOS", "Cosmaneura Scribe Store");
    if (!isAbsolute(root) || !basename(app).endsWith(".app")
      || root !== join(app, "Contents", "Resources", "app") || await realpath(root) !== root
      || process.execPath !== executable || await realpath(executable) !== executable) throw unavailable();
    const values = [profile.auth, profile.audio, profile.presentation].map(input => exact(object(input), ["path", "sha256"]));
    const hash = values[0]?.sha256;
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/u.test(hash)
      || values.some(value => value.path !== STORE_BRIDGE_BUNDLE_PATH || value.sha256 !== hash)) throw unavailable();
    const path = join(app, STORE_BRIDGE_BUNDLE_PATH), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) throw unavailable();
    const helper = Object.freeze({ helperPath: path, helperSha256: hash });
    return [helper, helper, helper];
  }
  // Keep the direct distribution's existing relative-path containment gate.
  const helper = async (input: unknown): Promise<{ helperPath: string; helperSha256: string }> => {
    const value = exact(object(input), ["path", "sha256"]);
    if (typeof value.path !== "string" || isAbsolute(value.path) || value.path.includes("\\")
      || value.path.split("/").some(part => !part || part === "." || part === "..")
      || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256)) throw unavailable();
    const path = join(root, value.path);
    if (await realpath(path) !== path || relative(root, path).startsWith("..")) throw unavailable();
    return { helperPath: path, helperSha256: value.sha256 };
  };
  return Promise.all([helper(profile.auth), helper(profile.audio), helper(profile.presentation)]);
}
function unavailable(): Error { return new Error("The standalone provider is unavailable."); }
