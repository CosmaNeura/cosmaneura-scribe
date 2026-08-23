import { describe, expect, it, vi } from "vitest";

import {
  ElectronTrayRecordingIndicator,
  installCaptureWindowGuard,
  type ElectronMenuTemplateItem,
  type ElectronNativeImagePort,
  type ElectronTrayPort,
} from "./electron-recording-indicator.js";
import type { RecordingIndicatorSnapshot } from "./recording-indicator.js";

const active = (
  phase: "recording" | "failed",
): RecordingIndicatorSnapshot => ({
  visibility: "persistent",
  visible: true,
  phase,
  captureSessionId: "capture-synthetic-native-indicator",
});

describe("native Electron recording indicator", () => {
  it("uses a persistent PHI-safe tray signal and keeps failure visible", async () => {
    const images: string[] = [];
    const tooltips: string[] = [];
    const menus: Array<readonly ElectronMenuTemplateItem[]> = [];
    const clicks: Array<() => void> = [];
    const destroy = vi.fn();
    const setImage = vi.fn();
    const tray: ElectronTrayPort = {
      destroy,
      on: (_event, listener) => clicks.push(listener),
      setContextMenu: vi.fn(),
      setImage,
      setToolTip: (tooltip) => tooltips.push(tooltip),
    };
    const activateWindow = vi.fn();
    const emergencyStopAndQuit = vi.fn();
    const indicator = new ElectronTrayRecordingIndicator({
      activateWindow,
      emergencyStopAndQuit,
      imageFactory: {
        createFromDataURL: (dataUrl): ElectronNativeImagePort => {
          images.push(dataUrl);
          return { isEmpty: () => false };
        },
      },
      trayFactory: { create: () => tray },
      menuFactory: {
        buildFromTemplate: (template) => {
          menus.push(template);
          return template;
        },
      },
    });

    await indicator.publish(active("recording"));
    expect(indicator.isSafetySignalVisible()).toBe(true);
    expect(tooltips.at(-1)).toBe("Cosmas — Recording is active");
    expect(JSON.stringify(menus.at(-1))).not.toContain(
      "capture-synthetic-native-indicator",
    );
    clicks[0]?.();
    expect(activateWindow).toHaveBeenCalledOnce();
    const emergencyMenuItem = menus
      .at(-1)
      ?.find((item) => "label" in item && item.label === "Stop capture and quit");
    if (emergencyMenuItem === undefined || !("click" in emergencyMenuItem)) {
      throw new Error("Missing synthetic emergency menu item");
    }
    emergencyMenuItem.click();
    expect(emergencyStopAndQuit).toHaveBeenCalledOnce();

    await indicator.publish(active("failed"));
    expect(indicator.isSafetySignalVisible()).toBe(true);
    expect(tooltips.at(-1)).toBe("Cosmas — Capture status is uncertain");
    expect(setImage).toHaveBeenCalledOnce();
    expect(images).toHaveLength(2);

    await indicator.publish({
      visibility: "persistent",
      visible: false,
      phase: "inactive",
      captureSessionId: null,
    });
    expect(indicator.isSafetySignalVisible()).toBe(false);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("fails closed when Electron cannot decode the indicator image", async () => {
    const indicator = new ElectronTrayRecordingIndicator({
      activateWindow: vi.fn(),
      emergencyStopAndQuit: vi.fn(),
      imageFactory: { createFromDataURL: () => ({ isEmpty: () => true }) },
      trayFactory: {
        create: () => {
          throw new Error("must not create an empty tray image");
        },
      },
      menuFactory: { buildFromTemplate: () => ({}) },
    });
    await expect(indicator.publish(active("recording"))).rejects.toThrow(
      "Native recording indicator is unavailable",
    );
    expect(indicator.isSafetySignalVisible()).toBe(false);
  });

  it("prevents close and minimize from hiding an active or uncertain signal", () => {
    const listeners = new Map<
      string,
      (event: { preventDefault(): void }) => void
    >();
    const window = {
      focus: vi.fn(),
      show: vi.fn(),
      on: (
        event: "close" | "minimize",
        listener: (event: { preventDefault(): void }) => void,
      ) => listeners.set(event, listener),
    };
    let visible = true;
    let shutdown = false;
    installCaptureWindowGuard(
      window,
      { isSafetySignalVisible: () => visible },
      () => shutdown,
    );

    const preventDefault = vi.fn();
    listeners.get("close")?.({ preventDefault });
    listeners.get("minimize")?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(window.show).toHaveBeenCalledTimes(2);
    expect(window.focus).toHaveBeenCalledTimes(2);

    visible = false;
    listeners.get("close")?.({ preventDefault });
    shutdown = true;
    visible = true;
    listeners.get("close")?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });
});
