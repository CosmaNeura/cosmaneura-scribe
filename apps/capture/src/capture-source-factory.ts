import {
  SilentSyntheticCaptureSource,
  type CaptureSource,
} from "./capture";

interface BrowserMicrophoneModule {
  readonly BrowserMicrophoneCaptureSource: new () => CaptureSource;
}

export type BrowserMicrophoneModuleLoader = () => Promise<BrowserMicrophoneModule>;

export interface CaptureSourceFactoryOptions {
  readonly microphoneTestEnabled?: boolean;
  /** Null is an explicit unavailable-adapter test seam. */
  readonly microphoneModuleLoader?: BrowserMicrophoneModuleLoader | null;
}

/**
 * The microphone path is a test-only, compile-time opt-in. Merely adding the
 * adapter module to a build can never activate microphone access.
 */
export const MICROPHONE_TEST_CAPTURE_ENABLED =
  import.meta.env.VITE_CAPTURE_E2E_MICROPHONE_ENABLED === "true";

// A literal false build-time branch lets Rollup remove both the adapter and its
// AudioWorklet asset from dormant preview artifacts. Tests inject a loader.
const bundledMicrophoneModuleLoader: BrowserMicrophoneModuleLoader | undefined =
  MICROPHONE_TEST_CAPTURE_ENABLED
    ? () => import("./audio/browser-microphone-source.ts")
    : undefined;

export async function createCaptureSource(
  options: CaptureSourceFactoryOptions = {},
): Promise<CaptureSource> {
  const enabled = options.microphoneTestEnabled ?? MICROPHONE_TEST_CAPTURE_ENABLED;
  if (!enabled) return new SilentSyntheticCaptureSource();

  const loadMicrophoneSource = options.microphoneModuleLoader === null
    ? undefined
    : options.microphoneModuleLoader ??
      bundledMicrophoneModuleLoader;
  if (loadMicrophoneSource === undefined) {
    throw new Error("microphone_test_adapter_unavailable");
  }
  const module = await loadMicrophoneSource();
  return new module.BrowserMicrophoneCaptureSource();
}
