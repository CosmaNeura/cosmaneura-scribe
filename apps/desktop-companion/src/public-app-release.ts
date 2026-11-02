import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { App, Menu } from "electron";

export const PUBLIC_MAC_NAME = "Cosmaneura Scribe for Mac";
export interface PublicMacRelease {
  readonly displayName: typeof PUBLIC_MAC_NAME;
  readonly marketingVersion: string;
  readonly build: string;
  readonly distribution: "Direct beta" | "Apple distribution";
  readonly environment: "Staging" | "Production";
}

/** Public package metadata cannot select a backend, identity, or storage path. */
export function publicMacRelease(value: unknown, coreOrigin: unknown,
  distribution: PublicMacRelease["distribution"]): PublicMacRelease | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(",") !== "build,displayName,distribution,marketingVersion,schema"
    || data.schema !== 1 || data.displayName !== PUBLIC_MAC_NAME || data.distribution !== distribution
    || typeof data.marketingVersion !== "string" || !/^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/u.test(data.marketingVersion)
    || typeof data.build !== "string" || !/^[1-9][0-9]{0,9}$/u.test(data.build)) return null;
  const environment = coreOrigin === "https://staging-app.cosmaneura.com" ? "Staging"
    : coreOrigin === "https://app.cosmaneura.com" ? "Production" : null;
  return environment ? Object.freeze({ displayName: PUBLIC_MAC_NAME, marketingVersion: data.marketingVersion,
    build: data.build, distribution, environment }) : null;
}

type PublicAppPort = Pick<App, "getAppPath" | "setAboutPanelOptions" | "whenReady">;
type PublicMenuPort = Pick<typeof Menu, "buildFromTemplate" | "setApplicationMenu">;
function packageMetadata(root: string, file: "release-metadata.json" | "provider-profile.json"): unknown {
  const path = join(root, file), info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error("Public package metadata unavailable");
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Visible presentation only. Internal getName, userData and auth names stay fixed. */
export function installPublicMacPresentation(app: PublicAppPort, menu: PublicMenuPort,
  distribution: PublicMacRelease["distribution"]): void {
  let release: PublicMacRelease | null = null;
  try {
    const profile = packageMetadata(app.getAppPath(), "provider-profile.json") as { coreOrigin?: unknown } | null;
    release = publicMacRelease(packageMetadata(app.getAppPath(), "release-metadata.json"), profile?.coreOrigin, distribution);
  } catch { /* Missing public metadata must not change capture or disclose errors. */ }
  try {
    app.setAboutPanelOptions({ applicationName: PUBLIC_MAC_NAME,
      ...(release ? { applicationVersion: release.marketingVersion } : {}),
      version: release ? `Build ${release.build} · ${release.distribution} · ${release.environment}` : "Release details unavailable" });
  } catch { /* Public presentation cannot prevent the existing guarded startup. */ }
  void app.whenReady().then(() => {
    menu.setApplicationMenu(menu.buildFromTemplate([
      { label: PUBLIC_MAC_NAME, submenu: [
        { label: `About ${PUBLIC_MAC_NAME}`, role: "about" },
        { type: "separator" }, { role: "services" }, { type: "separator" },
        { label: `Hide ${PUBLIC_MAC_NAME}`, role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" }, { label: `Quit ${PUBLIC_MAC_NAME}`, role: "quit" },
      ] }, { role: "editMenu" }, { role: "windowMenu" },
    ]));
  }).catch(() => { /* Presentation failure cannot bypass the existing close owner. */ });
}
