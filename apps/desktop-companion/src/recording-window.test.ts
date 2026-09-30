import { describe, expect, it, vi } from "vitest";
import { MainRecordingWindow, type RecordingWindowPort } from "./recording-window.js";
import type { ProviderRecorderSnapshot } from "../../capture/src/provider-binding";

function fixture() {
  let visible = true, minimized = false, destroyed = false, id = "window:73:0";
  const window = { isVisible: () => visible, isMinimized: () => minimized, isDestroyed: () => destroyed,
    getMinimumSize: (): [number, number] => [520, 520],
    getMediaSourceId: () => id, getBounds: () => ({ x: -1200, y: 40, width: 1100, height: 800 }),
    setBounds: vi.fn(), setMinimumSize: vi.fn(), setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(), showInactive: vi.fn() } satisfies RecordingWindowPort;
  const controller = new MainRecordingWindow(() => window, () => ({ x: -1440, y: 24, width: 1440, height: 860 }), () => Promise.resolve(0));
  return { controller, window, hide: () => { visible = false; }, minimize: () => { minimized = true; },
    destroy: () => { destroyed = true; }, id: (value: string) => { id = value; } };
}
async function responsive() { for (let i = 0; i < 5; i++) await Promise.resolve(); }
function snapshot(phase: "ready" | "starting" | "recording" | "interrupted" | "stopped", state = "recording") {
  return { state, desktop: { phase } } as ProviderRecorderSnapshot;
}
describe("trusted main recording window", () => {
  it("compacts once, keeps paused controls above Zoom, and restores after confirmed recording completion", async () => {
    const f = fixture();
    expect(f.controller.primaryWindowId()).toBeNull();
    f.controller.update(snapshot("starting"));
    expect(f.window.setBounds).toHaveBeenCalledWith({ x: -496, y: 40, width: 480, height: 360 });
    expect(f.window.setAlwaysOnTop).toHaveBeenCalledWith(true, "floating");
    expect(f.window.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true });
    await responsive();
    expect(f.controller.primaryWindowId()).toBe(73);
    for (let i = 0; i < 20; i++) f.controller.update(snapshot("recording"));
    f.controller.update(snapshot("interrupted", "paused"));
    expect(f.window.showInactive).toHaveBeenCalledTimes(1);
    expect(f.window.setVisibleOnAllWorkspaces).toHaveBeenCalledTimes(1);
    expect(f.controller.primaryWindowId()).toBeNull(); // paused sources are already stopped
    await responsive();
    f.controller.update(snapshot("recording"));
    f.controller.primaryWindowId();
    await responsive();
    expect(f.controller.primaryWindowId()).toBe(73);
    f.controller.update(snapshot("stopped", "processing"));
    expect(f.window.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(f.window.setBounds).toHaveBeenLastCalledWith({ x: -1200, y: 40, width: 1100, height: 800 });
    expect(f.controller.primaryWindowId()).toBeNull();
  });
  it.each(["hide", "minimize", "destroy", "block"] as const)("withdraws coverage after %s without trusting a renderer claim", async action => {
    const f = fixture(); f.controller.update(snapshot("recording"));
    await responsive();
    expect(f.controller.primaryWindowId()).toBe(73);
    if (action === "block") f.controller.block(); else f[action]();
    expect(f.controller.primaryWindowId()).toBeNull();
  });
  it.each(["screen:73:0", "window:0:0", "window:4294967296:0", "window:73", "window:73:0:1"])("rejects malformed native identity %s", async id => {
    const f = fixture(); f.controller.update(snapshot("recording"));
    await responsive();
    expect(f.controller.primaryWindowId()).toBe(73); f.id(id);
    expect(f.controller.primaryWindowId()).toBeNull();
  });
});
