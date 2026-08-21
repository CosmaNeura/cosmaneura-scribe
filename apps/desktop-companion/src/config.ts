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

export function parseCompanionFeatureFlag(value: string | undefined): CompanionFeatureConfig {
  return Object.freeze({ enabled: value === "true" });
}
