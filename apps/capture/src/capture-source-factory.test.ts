import { describe, expect, it, vi } from "vitest";

import type { CaptureSource } from "./capture";
import {
  IOS_NATIVE_PCM_CAPTURE_ENABLED,
  MICROPHONE_TEST_CAPTURE_ENABLED,
  createCaptureSource,
} from "./capture-source-factory";

describe("createCaptureSource", () => {
  it("keeps the microphone false by default even when its module is present", async () => {
    expect(MICROPHONE_TEST_CAPTURE_ENABLED).toBe(false);
    expect(IOS_NATIVE_PCM_CAPTURE_ENABLED).toBe(false);
    const microphoneModuleLoader = vi.fn(async () => ({
      BrowserMicrophoneCaptureSource: TestMicrophoneSource,
    }));

    await expect(createCaptureSource({ microphoneModuleLoader })).resolves.toMatchObject({
      kind: "synthetic",
    });
    expect(microphoneModuleLoader).not.toHaveBeenCalled();
  });

  it("does not inspect native eligibility while the native gate is false", async () => {
    await expect(createCaptureSource({
      iosNativePcmEnabled: false,
      get iosNativePlatformEligible(): boolean {
        throw new Error("native platform probe must remain dormant");
      },
    })).resolves.toMatchObject({ kind: "synthetic" });
  });

  it("selects the linked iOS adapter only with both explicit gates", async () => {
    const iosSource = new TestMicrophoneSource();
    const iosNativeModuleLoader = vi.fn(async () => ({
      createCapacitorIosNativeMicrophoneCaptureSource: () => iosSource,
    }));

    await expect(createCaptureSource({
      iosNativePcmEnabled: true,
      iosNativePlatformEligible: true,
      iosNativeModuleLoader,
    })).resolves.toBe(iosSource);
    expect(iosNativeModuleLoader).toHaveBeenCalledOnce();
  });

  it("loads the platform probe only after opt-in and selects native iOS", async () => {
    const iosSource = new TestMicrophoneSource();
    const iosNativePlatformModuleLoader = vi.fn(async () => ({
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => "ios",
      },
    }));

    await expect(createCaptureSource({
      iosNativePcmEnabled: true,
      iosNativePlatformModuleLoader,
      iosNativeModuleLoader: async () => ({
        createCapacitorIosNativeMicrophoneCaptureSource: () => iosSource,
      }),
    })).resolves.toBe(iosSource);
    expect(iosNativePlatformModuleLoader).toHaveBeenCalledOnce();
  });

  it("falls back when the gated dynamic platform probe reports web", async () => {
    const iosNativeModuleLoader = vi.fn(async () => ({
      createCapacitorIosNativeMicrophoneCaptureSource: () => new TestMicrophoneSource(),
    }));

    await expect(createCaptureSource({
      iosNativePcmEnabled: true,
      iosNativePlatformModuleLoader: async () => ({
        Capacitor: {
          isNativePlatform: () => false,
          getPlatform: () => "web",
        },
      }),
      iosNativeModuleLoader,
    })).resolves.toMatchObject({ kind: "synthetic" });
    expect(iosNativeModuleLoader).not.toHaveBeenCalled();
  });

  it("preserves the ordinary source path on unsupported platforms", async () => {
    const iosNativeModuleLoader = vi.fn(async () => ({
      createCapacitorIosNativeMicrophoneCaptureSource: () => new TestMicrophoneSource(),
    }));

    await expect(createCaptureSource({
      iosNativePcmEnabled: true,
      iosNativePlatformEligible: false,
      iosNativeModuleLoader,
    })).resolves.toMatchObject({ kind: "synthetic" });
    expect(iosNativeModuleLoader).not.toHaveBeenCalled();
  });

  it("fails with a bounded code when an eligible native adapter is unavailable", async () => {
    await expect(createCaptureSource({
      iosNativePcmEnabled: true,
      iosNativePlatformEligible: true,
      iosNativeModuleLoader: null,
    })).rejects.toMatchObject({
      code: "audio_capture_unavailable",
      message: "audio_capture_unavailable",
    });
  });

  it("loads the adapter only with the exact explicit test gate", async () => {
    const microphoneModuleLoader = vi.fn(async () => ({
      BrowserMicrophoneCaptureSource: TestMicrophoneSource,
    }));

    await expect(createCaptureSource({
      microphoneTestEnabled: true,
      microphoneModuleLoader,
    })).resolves.toBeInstanceOf(TestMicrophoneSource);
    expect(microphoneModuleLoader).toHaveBeenCalledOnce();
  });

  it("fails closed when the gate is enabled without an adapter", async () => {
    await expect(createCaptureSource({
      microphoneTestEnabled: true,
      microphoneModuleLoader: null,
    })).rejects.toThrow("microphone_test_adapter_unavailable");
  });
});

class TestMicrophoneSource implements CaptureSource {
  public readonly kind = "microphone" as const;

  public start(): Promise<void> {
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    return Promise.resolve();
  }
}
