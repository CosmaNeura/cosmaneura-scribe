import { Capacitor } from "@capacitor/core";
import type { CaptureSource } from "../capture";
import { createCapacitorIosNativeMicrophoneCaptureSource } from "../native/capacitor-ios-native-pcm-bridge";

/** Construct only after the provider host authorizes the encounter and owns its recorder lock.
 * Construction does not request permission or start audio. The existing flow controller
 * starts this source only after consent/admission and the provider's explicit Record action.
 */
export function createProviderIOSCaptureSource(): CaptureSource {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios" ||
      !Capacitor.isPluginAvailable("IOSPCM")) {
    throw new Error("provider_ios_capture_unavailable");
  }
  return createCapacitorIosNativeMicrophoneCaptureSource();
}
