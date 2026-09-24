import type { DesktopProviderOwner } from "../src/electron-provider-host.js";
// Declaration only. Packaging requires the actual reviewed native/backend
// factory; no synthetic or unavailable-session fallback is shipped.
export function openProvider(options: { readonly userDataDirectory: string }): Promise<DesktopProviderOwner>;
