import { describe, expect, it, vi } from "vitest";

import type { CaptureSource } from "./capture";
import {
  MICROPHONE_TEST_CAPTURE_ENABLED,
  createCaptureSource,
} from "./capture-source-factory";

describe("createCaptureSource", () => {
  it("keeps the microphone false by default even when its module is present", async () => {
    expect(MICROPHONE_TEST_CAPTURE_ENABLED).toBe(false);
    const microphoneModuleLoader = vi.fn(async () => ({
      BrowserMicrophoneCaptureSource: TestMicrophoneSource,
    }));

    await expect(createCaptureSource({ microphoneModuleLoader })).resolves.toMatchObject({
      kind: "synthetic",
    });
    expect(microphoneModuleLoader).not.toHaveBeenCalled();
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
