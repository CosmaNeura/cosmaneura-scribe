/** Compiled store distribution only. Apple App Group/profile identity has not
 * been supplied; no renderer, environment or bundle setting can activate it. */
export const APPROVED_STORE_APPLICATION_GROUP: string | null = null;

export function requireMacAppStoreRuntime(runtime: { readonly mas?: boolean; readonly electron?: string; readonly node: string }): void {
  if (runtime.mas !== true || runtime.electron !== "44.4.3" || !runtime.node.startsWith("24.")
    || APPROVED_STORE_APPLICATION_GROUP === null) throw new Error("mac_app_store_distribution_unavailable");
}
