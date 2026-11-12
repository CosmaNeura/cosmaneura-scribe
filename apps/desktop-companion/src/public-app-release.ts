import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { App, Menu } from "electron";

/** Direct-beta Finder/About/menu name. Kept for existing beta installs. */
export const PUBLIC_DIRECT_BETA_MAC_NAME = "Cosmaneura Scribe for Mac";
/** Mac App Store public display name (Guideline 5.2.5 — must not contain "Mac"). */
export const PUBLIC_STORE_MAC_NAME = "Cosmas Scribe";

export type PublicMacDisplayName = typeof PUBLIC_DIRECT_BETA_MAC_NAME | typeof PUBLIC_STORE_MAC_NAME;

export function publicMacDisplayName(
  distribution: PublicMacRelease["distribution"],
): PublicMacDisplayName {
  return distribution === "Apple distribution" ? PUBLIC_STORE_MAC_NAME : PUBLIC_DIRECT_BETA_MAC_NAME;
}

export interface PublicMacRelease {
  readonly displayName: PublicMacDisplayName;
  readonly marketingVersion: string;
  readonly build: string;
  readonly distribution: "Direct beta" | "Apple distribution";
  readonly environment: "Staging" | "Production";
  readonly environmentMarker: "S" | "P";
}

function publicMacEnvironment(coreOrigin: unknown): Pick<PublicMacRelease, "environment" | "environmentMarker"> | null {
  return coreOrigin === "https://staging-app.cosmaneura.com" ? { environment: "Staging", environmentMarker: "S" }
    : coreOrigin === "https://app.cosmaneura.com" ? { environment: "Production", environmentMarker: "P" } : null;
}

/** Public package metadata cannot select a backend, identity, or storage path. */
export function publicMacRelease(value: unknown, coreOrigin: unknown,
  distribution: PublicMacRelease["distribution"]): PublicMacRelease | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const displayName = publicMacDisplayName(distribution);
  if (Object.keys(data).sort().join(",") !== "build,displayName,distribution,marketingVersion,schema"
    || data.schema !== 1 || data.displayName !== displayName || data.distribution !== distribution
    || typeof data.marketingVersion !== "string" || !/^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/u.test(data.marketingVersion)
    || typeof data.build !== "string" || !/^[1-9][0-9]{0,9}$/u.test(data.build)) return null;
  const environment = publicMacEnvironment(coreOrigin);
  return environment ? Object.freeze({ displayName, marketingVersion: data.marketingVersion,
    build: data.build, distribution, ...environment }) : null;
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
  let environment: ReturnType<typeof publicMacEnvironment> = null;
  const applicationName = publicMacDisplayName(distribution);
  try {
    const profile = packageMetadata(app.getAppPath(), "provider-profile.json") as { coreOrigin?: unknown } | null;
    environment = publicMacEnvironment(profile?.coreOrigin);
    release = publicMacRelease(packageMetadata(app.getAppPath(), "release-metadata.json"), profile?.coreOrigin, distribution);
  } catch { /* Missing public metadata must not change capture or disclose errors. */ }
  const marker = environment ? ` · ${environment.environment} (${environment.environmentMarker})` : "";
  try {
    app.setAboutPanelOptions({ applicationName,
      ...(release ? { applicationVersion: release.marketingVersion } : {}),
      version: release ? `Build ${release.build} · ${release.distribution}${marker}` : `Release details unavailable${marker}` });
  } catch { /* Public presentation cannot prevent the existing guarded startup. */ }
  void app.whenReady().then(() => {
    menu.setApplicationMenu(menu.buildFromTemplate([
      { label: applicationName, submenu: [
        { label: `About ${applicationName}`, role: "about" },
        { type: "separator" }, { role: "services" }, { type: "separator" },
        { label: `Hide ${applicationName}`, role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" }, { label: `Quit ${applicationName}`, role: "quit" },
      ] }, { role: "editMenu" }, { role: "windowMenu" },
    ]));
  }).catch(() => { /* Presentation failure cannot bypass the existing close owner. */ });
}
