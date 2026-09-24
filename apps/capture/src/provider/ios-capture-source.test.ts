import { Capacitor } from "@capacitor/core";
import { describe, expect, it, vi } from "vitest";
import { createProviderIOSCaptureSource } from "./ios-capture-source";

describe("provider native iOS source selection", () => {
  it("requires the native iOS plugin and never substitutes synthetic recording", async () => {
    const native = vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(false);
    const platform = vi.spyOn(Capacitor, "getPlatform").mockReturnValue("web");
    const plugin = vi.spyOn(Capacitor, "isPluginAvailable").mockReturnValue(false);
    expect(createProviderIOSCaptureSource).toThrow("provider_ios_capture_unavailable");
    native.mockReturnValue(true); platform.mockReturnValue("android"); plugin.mockReturnValue(true);
    expect(createProviderIOSCaptureSource).toThrow("provider_ios_capture_unavailable");
    platform.mockReturnValue("ios"); plugin.mockReturnValue(false);
    expect(createProviderIOSCaptureSource).toThrow("provider_ios_capture_unavailable");
    plugin.mockReturnValue(true);
    const source = createProviderIOSCaptureSource();
    expect(source.kind).toBe("microphone");
    // No plugin methods (including microphone permission) run during construction.
    await expect(source.stop()).resolves.toBeUndefined();
  });
});
