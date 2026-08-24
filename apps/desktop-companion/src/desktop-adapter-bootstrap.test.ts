import { describe, expect, it, vi } from "vitest";

import type { DesktopReleaseManifest } from "./config.js";
import { createDesktopCaptureAdapter } from "./desktop-adapter-bootstrap.js";
import { MockDesktopCaptureAdapter } from "./mock-capture-adapter.js";
import {
  RecallDesktopCaptureAdapter,
  type RecallSdkPort,
} from "./recall-sdk-adapter.js";

function manifest(
  packagingEnabled: boolean,
  captureEnabled: boolean,
  clinicalReleaseApproved: boolean,
): DesktopReleaseManifest {
  return {
    schemaVersion: 1,
    packagingEnabled,
    captureEnabled,
    clinicalReleaseApproved,
    platformAppOrigin: "https://app.cosmaneura.com",
    platformApiOrigin: "https://api.cosmaneura.com",
  };
}

const sdk: RecallSdkPort = {
  init: vi.fn(() => Promise.resolve()),
  shutdown: vi.fn(() => Promise.resolve()),
  startRecording: vi.fn(() => Promise.resolve()),
  stopRecording: vi.fn(() => Promise.resolve()),
  requestPermission: vi.fn(() => Promise.resolve()),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

describe("desktop adapter bootstrap", () => {
  it("never loads Recall when any release lock is false", async () => {
    for (const productEnabled of [false, true]) {
      for (const packagingEnabled of [false, true]) {
        for (const captureEnabled of [false, true]) {
          for (const clinicalReleaseApproved of [false, true]) {
            if (
              productEnabled &&
              packagingEnabled &&
              captureEnabled &&
              clinicalReleaseApproved
            ) {
              continue;
            }
            const loader = vi.fn(() => Promise.resolve(sdk));
            const adapter = await createDesktopCaptureAdapter({
              productEnabled,
              releaseManifest: manifest(
                packagingEnabled,
                captureEnabled,
                clinicalReleaseApproved,
              ),
              loadRecallSdk: loader,
            });
            expect(adapter).toBeInstanceOf(MockDesktopCaptureAdapter);
            expect(loader).not.toHaveBeenCalled();
          }
        }
      }
    }
  });

  it("loads the verified provider only after all four release locks pass", async () => {
    const loader = vi.fn(() => Promise.resolve(sdk));
    const adapter = await createDesktopCaptureAdapter({
      productEnabled: true,
      releaseManifest: manifest(true, true, true),
      loadRecallSdk: loader,
    });
    expect(adapter).toBeInstanceOf(RecallDesktopCaptureAdapter);
    expect(loader).toHaveBeenCalledOnce();
  });

  it("fails closed when the verified provider loader rejects", async () => {
    const loader = vi.fn(() =>
      Promise.reject(new Error("synthetic loader rejection")),
    );
    await expect(
      createDesktopCaptureAdapter({
        productEnabled: true,
        releaseManifest: manifest(true, true, true),
        loadRecallSdk: loader,
      }),
    ).rejects.toThrow("synthetic loader rejection");
  });

  it("rejects placeholder origins before loading the provider", async () => {
    const loader = vi.fn(() => Promise.resolve(sdk));
    await expect(
      createDesktopCaptureAdapter({
        productEnabled: true,
        releaseManifest: {
          ...manifest(true, true, true),
          platformAppOrigin: "https://desktop-disabled.invalid",
        },
        loadRecallSdk: loader,
      }),
    ).rejects.toThrow("Desktop release platform origins are not approved");
    expect(loader).not.toHaveBeenCalled();
  });
});
