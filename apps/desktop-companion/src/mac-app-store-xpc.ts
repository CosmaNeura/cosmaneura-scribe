/** Explicit source-selected XPC store target. This macOS Team-ID group holds
 * only native fence files and is never a Keychain access group. */
export const STORE_XPC_APPLICATION_GROUP = "JVV65668U6.com.cosmaneura.scribe.beta.desktop";
export function requireMacAppStoreXpcRuntime(runtime: { readonly mas?: boolean; readonly electron?: string; readonly node: string }): void {
  if (runtime.mas !== true || runtime.electron !== "44.4.3" || !runtime.node.startsWith("24.")) {
    throw new Error("mac_app_store_xpc_distribution_unavailable");
  }
}
