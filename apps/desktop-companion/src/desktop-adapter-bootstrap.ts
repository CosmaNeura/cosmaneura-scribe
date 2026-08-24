import type { DesktopCaptureAdapter } from "./capture-adapter.js";
import {
  hasRoutableDesktopPlatformOrigins,
  isDesktopCaptureReleaseEnabled,
  type DesktopReleaseManifest,
} from "./config.js";
import { MockDesktopCaptureAdapter } from "./mock-capture-adapter.js";
import {
  RecallDesktopCaptureAdapter,
  type RecallSdkPort,
} from "./recall-sdk-adapter.js";
import { loadVerifiedRecallSdk } from "./recall-sdk-loader.js";

export type RecallSdkLoader = () => Promise<RecallSdkPort>;

export interface DesktopAdapterBootstrapOptions {
  readonly productEnabled: boolean;
  readonly releaseManifest: DesktopReleaseManifest;
  readonly loadRecallSdk?: RecallSdkLoader;
}

/**
 * Select the privileged adapter before constructing the trusted runtime.
 * Disabled builds return the metadata-only mock without invoking the loader.
 */
export async function createDesktopCaptureAdapter(
  options: DesktopAdapterBootstrapOptions,
): Promise<DesktopCaptureAdapter> {
  if (
    !options.productEnabled ||
    !isDesktopCaptureReleaseEnabled(options.releaseManifest)
  ) {
    return new MockDesktopCaptureAdapter();
  }
  if (!hasRoutableDesktopPlatformOrigins(options.releaseManifest)) {
    throw new Error("Desktop release platform origins are not approved");
  }
  const sdk = await (options.loadRecallSdk ?? loadVerifiedRecallSdk)();
  return new RecallDesktopCaptureAdapter(sdk);
}
