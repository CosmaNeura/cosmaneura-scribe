import { describe, expect, it, vi } from "vitest";
import { MainRecordingWindow, type RecordingWindowPort } from "./recording-window.js";
import type { ProviderRecorderSnapshot } from "../../capture/src/provider-binding";

function fixture() {
  let visible = true, minimized = false, destroyed = false, id = "window:73:0";
  const window = { isVisible: () => visible, isMinimized: () => minimized, isDestroyed: () => destroyed,
    getMinimumSize: (): [number, number] => [520, 520],
    getMediaSourceId: () => id, getBounds: () => ({ x: -1200, y: 40, width: 1100, height: 800 }),
    setBounds: vi.fn(), setMinimumSize: vi.fn(), setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(), showInactive: vi.fn(), show: vi.fn(), focus: vi.fn()
  } satisfies RecordingWindowPort & { showInactive(): void; show(): void; focus(): void };
  const controller = new MainRecordingWindow(() => window, () => ({ x: -1440, y: 24, width: 1440, height: 860 }), () => Promise.resolve(0));
  return { controller, window, hide: () => { visible = false; }, minimize: () => { minimized = true; },
    destroy: () => { destroyed = true; }, id: (value: string) => { id = value; } };
}
async function responsive() { for (let i = 0; i < 5; i++) await Promise.resolve(); }
function snapshot(phase: "ready" | "starting" | "recording" | "interrupted" | "stopped" | "stop_unconfirmed", state = "recording") {
  return { state, desktop: { phase } } as ProviderRecorderSnapshot;
}
describe("trusted main recording window", () => {
  it("preserves geometry and Space without pinning or activation across capture, pause, retry and completion", async () => {
    const f = fixture();
    expect(f.controller.primaryWindowId()).toBeNull();
    f.controller.update(snapshot("starting"));
    expect(f.window.setBounds).not.toHaveBeenCalled();
    expect(f.window.setMinimumSize).not.toHaveBeenCalled();
    expect(f.window.setAlwaysOnTop.mock.calls).toEqual([[false]]);
    expect(f.window.setVisibleOnAllWorkspaces.mock.calls).toEqual([[false]]);
    await responsive();
    expect(f.controller.primaryWindowId()).toBe(73);
    for (let i = 0; i < 20; i++) f.controller.update(snapshot("recording"));
    f.controller.update(snapshot("interrupted", "paused"));
    expect(f.window.showInactive).not.toHaveBeenCalled();
    expect(f.window.show).not.toHaveBeenCalled();
    expect(f.window.focus).not.toHaveBeenCalled();
    expect(f.window.setVisibleOnAllWorkspaces).toHaveBeenCalledTimes(1);
    expect(f.controller.primaryWindowId()).toBeNull(); // paused sources are already stopped
    await responsive();
    f.controller.update(snapshot("recording"));
    f.controller.primaryWindowId();
    await responsive();
    expect(f.controller.primaryWindowId()).toBe(73);
    f.controller.update(snapshot("stop_unconfirmed", "paused"));
    expect(f.window.setAlwaysOnTop.mock.calls).toEqual([[false]]);
    expect(f.controller.primaryWindowId()).toBeNull(); // retry never claims a confirmed active owner
    f.controller.update(snapshot("stopped", "processing"));
    expect(f.window.setAlwaysOnTop.mock.calls).toEqual([[false], [false]]);
    expect(f.window.setVisibleOnAllWorkspaces.mock.calls).toEqual([[false], [false]]);
    expect(f.window.setBounds).not.toHaveBeenCalled();
    expect(f.window.setMinimumSize).not.toHaveBeenCalled();
    expect(f.window.showInactive).not.toHaveBeenCalled();
    expect(f.window.show).not.toHaveBeenCalled();
    expect(f.window.focus).not.toHaveBeenCalled();
    expect(f.controller.primaryWindowId()).toBeNull();
    f.controller.update(null);
    expect(f.window.setAlwaysOnTop.mock.calls).toEqual([[false], [false]]);
    expect(f.window.setVisibleOnAllWorkspaces.mock.calls).toEqual([[false], [false]]);
  });
  it.each(["hide", "minimize", "destroy", "block"] as const)("withdraws window identity after %s without trusting a renderer claim", async action => {
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
