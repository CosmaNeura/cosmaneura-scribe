export const DESKTOP_COMPANION_FEATURE_FLAG =
  "COSMAS_RECALL_DESKTOP_COMPANION_ENABLED" as const;

export const ELECTRON_IPC_SCHEMA_VERSION = 1 as const;
export const ELECTRON_IPC_MAX_PAYLOAD_BYTES = 16 * 1024;
export const START_AUTHORITY_MAX_WINDOW_MS = 5 * 60 * 1000;
export const START_AUTHORITY_TIMEOUT_MS = 5 * 1000;
export const CAPTURE_OPERATION_TIMEOUT_MS = 15 * 1000;

export const RECALL_DESKTOP_SDK_CONFIG = Object.freeze({
  packageName: "@recallai/desktop-sdk",
  version: "2.0.28",
  apiUrl: "https://us-west-2.recall.ai",
  restartOnError: false,
  captureOutput: Object.freeze({
    video_mixed_mp4: null,
    audio_mixed_mp3: Object.freeze({}),
  }),
});

export interface CompanionFeatureConfig {
  readonly enabled: boolean;
}

export const DEFAULT_COMPANION_FEATURE_CONFIG: CompanionFeatureConfig = Object.freeze({
  enabled: false,
});

export interface DesktopReleaseManifest {
  readonly schemaVersion: 1;
  readonly packagingEnabled: boolean;
  readonly captureEnabled: boolean;
  readonly clinicalReleaseApproved: boolean;
  readonly platformAppOrigin: string;
  readonly platformApiOrigin: string;
}

/**
 * This checked-in manifest is the only release decision consumed by the
 * runnable Electron bootstrap. It intentionally points at non-routable
 * origins as another barrier against accidental network use in a source build.
 */
export const DESKTOP_RELEASE_MANIFEST: DesktopReleaseManifest = Object.freeze({
  schemaVersion: 1,
  packagingEnabled: false,
  captureEnabled: false,
  clinicalReleaseApproved: false,
  platformAppOrigin: "https://desktop-disabled.invalid",
  platformApiOrigin: "https://desktop-disabled.invalid",
});

export function isDesktopCaptureReleaseEnabled(
  manifest: DesktopReleaseManifest,
): boolean {
  return (
    manifest.packagingEnabled &&
    manifest.captureEnabled &&
    manifest.clinicalReleaseApproved
  );
}

export function hasRoutableDesktopPlatformOrigins(
  manifest: DesktopReleaseManifest,
): boolean {
  return (
    isRoutableHttpsOrigin(manifest.platformAppOrigin) &&
    isRoutableHttpsOrigin(manifest.platformApiOrigin)
  );
}

function isRoutableHttpsOrigin(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  return (
    parsed.protocol === "https:" &&
    parsed.origin === value &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    hostname.includes(".") &&
    hostname !== "127.0.0.1" &&
    hostname !== "localhost" &&
    hostname !== "[::1]" &&
    !hostname.endsWith(".invalid") &&
    !hostname.endsWith(".localhost") &&
    !hostname.endsWith(".test") &&
    !hostname.endsWith(".example")
  );
}

export function parseCompanionFeatureFlag(value: string | undefined): CompanionFeatureConfig {
  return Object.freeze({ enabled: value === "true" });
}
