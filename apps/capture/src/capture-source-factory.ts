import {
  SilentSyntheticCaptureSource,
  type CaptureSource,
} from "./capture";
import { AudioCaptureError } from "./audio/errors";

interface BrowserMicrophoneModule {
  readonly BrowserMicrophoneCaptureSource: new () => CaptureSource;
}

interface IosNativeMicrophoneModule {
  readonly createCapacitorIosNativeMicrophoneCaptureSource: () => CaptureSource;
}

interface CapacitorPlatformModule {
  readonly Capacitor: {
    isNativePlatform(): boolean;
    getPlatform(): string;
  };
}

export type BrowserMicrophoneModuleLoader = () => Promise<BrowserMicrophoneModule>;
export type IosNativeMicrophoneModuleLoader = () => Promise<IosNativeMicrophoneModule>;
export type CapacitorPlatformModuleLoader = () => Promise<CapacitorPlatformModule>;

export interface CaptureSourceFactoryOptions {
  readonly iosNativePcmEnabled?: boolean;
  readonly iosNativePlatformEligible?: boolean;
  /** Null is an explicit unavailable-platform-probe test seam. */
  readonly iosNativePlatformModuleLoader?: CapacitorPlatformModuleLoader | null;
  /** Null is an explicit unavailable-adapter test seam. */
  readonly iosNativeModuleLoader?: IosNativeMicrophoneModuleLoader | null;
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

/** App linking alone cannot select native capture; this gate is false by default. */
export const IOS_NATIVE_PCM_CAPTURE_ENABLED =
  import.meta.env.VITE_CAPTURE_IOS_NATIVE_PCM_ENABLED === "true";

const bundledIosNativeModuleLoader: IosNativeMicrophoneModuleLoader | undefined =
  IOS_NATIVE_PCM_CAPTURE_ENABLED
    ? () => import("./native/capacitor-ios-native-pcm-bridge.ts")
    : undefined;

const bundledCapacitorPlatformModuleLoader: CapacitorPlatformModuleLoader | undefined =
  IOS_NATIVE_PCM_CAPTURE_ENABLED
    ? () => import("@capacitor/core")
    : undefined;

// A literal false build-time branch lets Rollup remove both the adapter and its
// AudioWorklet asset from dormant preview artifacts. Tests inject a loader.
const bundledMicrophoneModuleLoader: BrowserMicrophoneModuleLoader | undefined =
  MICROPHONE_TEST_CAPTURE_ENABLED
    ? () => import("./audio/browser-microphone-source.ts")
    : undefined;

export async function createCaptureSource(
  options: CaptureSourceFactoryOptions = {},
): Promise<CaptureSource> {
  const iosNativeEnabled = options.iosNativePcmEnabled ?? IOS_NATIVE_PCM_CAPTURE_ENABLED;
  if (iosNativeEnabled) {
    const iosNativeEligible = options.iosNativePlatformEligible ??
      await loadIosNativeEligibility(options.iosNativePlatformModuleLoader);
    if (iosNativeEligible) {
      const loadIosNativeSource = options.iosNativeModuleLoader === null
        ? undefined
        : options.iosNativeModuleLoader ?? bundledIosNativeModuleLoader;
      if (loadIosNativeSource === undefined) {
        throw new AudioCaptureError("audio_capture_unavailable");
      }
      try {
        const module = await loadIosNativeSource();
        return module.createCapacitorIosNativeMicrophoneCaptureSource();
      } catch {
        throw new AudioCaptureError("audio_capture_unavailable");
      }
    }
  }

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

async function loadIosNativeEligibility(
  injectedLoader: CapacitorPlatformModuleLoader | null | undefined,
): Promise<boolean> {
  const loadPlatform = injectedLoader === null
    ? undefined
    : injectedLoader ?? bundledCapacitorPlatformModuleLoader;
  if (loadPlatform === undefined) throw new AudioCaptureError("audio_capture_unavailable");
  try {
    const { Capacitor } = await loadPlatform();
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
  } catch {
    throw new AudioCaptureError("audio_capture_unavailable");
  }
}
