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

const microphoneSourceModules = import.meta.glob<BrowserMicrophoneModule>(
  "./audio/browser-microphone-source.ts",
);

/**
 * The microphone path is a test-only, compile-time opt-in. Merely adding the
 * adapter module to a build can never activate microphone access.
 */
export const MICROPHONE_TEST_CAPTURE_ENABLED =
  import.meta.env.VITE_CAPTURE_E2E_MICROPHONE_ENABLED === "true";

export async function createCaptureSource(
  options: CaptureSourceFactoryOptions = {},
): Promise<CaptureSource> {
  const enabled = options.microphoneTestEnabled ?? MICROPHONE_TEST_CAPTURE_ENABLED;
  if (!enabled) return new SilentSyntheticCaptureSource();

  const loadMicrophoneSource = options.microphoneModuleLoader === null
    ? undefined
    : options.microphoneModuleLoader ??
      microphoneSourceModules["./audio/browser-microphone-source.ts"];
  if (loadMicrophoneSource === undefined) {
    throw new Error("microphone_test_adapter_unavailable");
  }
  const module = await loadMicrophoneSource();
  return new module.BrowserMicrophoneCaptureSource();
}
