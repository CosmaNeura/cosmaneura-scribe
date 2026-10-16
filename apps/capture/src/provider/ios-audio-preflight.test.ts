import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openIOSAudioPreflight, parseIOSAudioPreflight, type IOSMicrophoneCheckPlugin } from "./ios-audio-preflight";

const ready = { version: 1, status: "ready", inputDevices: [
  { id: "synthetic-built-in", label: "Synthetic iPhone microphone", kind: "built_in", current: true },
  { id: "synthetic-headset", label: "Synthetic headset", kind: "bluetooth", current: false },
], selectedInputId: "synthetic-built-in", microphone: { level: .2, ageMs: 40 } };
beforeEach(() => { vi.stubGlobal("document", { visibilityState: "visible" }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function plugin() {
  let value = structuredClone(ready);
  const native: IOSMicrophoneCheckPlugin = {
    beginMicrophoneCheck: vi.fn(async () => value), readMicrophoneCheck: vi.fn(async () => value),
    endMicrophoneCheck: vi.fn(async () => ({})), selectMicrophoneDevice: vi.fn(async ({ id }) => {
      value = { ...value, selectedInputId: id, inputDevices: value.inputDevices.map(device => ({ ...device, current: device.id === id })) };
      return value;
    }),
  };
  return native;
}
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
describe("native microphone preparation metadata", () => {
  it("retains a newer acknowledged route when an older poll finishes later", async () => {
    vi.useFakeTimers();
    const native = plugin(), oldRead = deferred();
    native.readMicrophoneCheck = vi.fn(() => oldRead.promise);
    const view = await openIOSAudioPreflight(new AbortController().signal, native);
    try {
      await vi.advanceTimersByTimeAsync(250); expect(native.readMicrophoneCheck).toHaveBeenCalledOnce();
      await view.selectMicrophone("synthetic-headset");
      oldRead.resolve(ready); await vi.advanceTimersByTimeAsync(0);
      expect(view.getSnapshot().selectedInputId).toBe("synthetic-headset");
      expect(view.getSnapshot().inputDevices.find(device => device.current)?.id).toBe("synthetic-headset");
    } finally { oldRead.resolve(ready); await view.close(); }
  });
  it("suppresses polling during route selection and clears its getter before revoked native closure settles", async () => {
    vi.useFakeTimers();
    const native = plugin(), selected = deferred(), ending = deferred(), inherited = new AbortController();
    native.selectMicrophoneDevice = vi.fn(() => selected.promise);
    native.endMicrophoneCheck = vi.fn(() => ending.promise);
    const view = await openIOSAudioPreflight(new AbortController().signal, native, inherited.signal);
    const selecting = view.selectMicrophone("synthetic-headset"), rejected = expect(selecting).rejects.toThrow();
    try {
      await vi.advanceTimersByTimeAsync(1000); expect(native.readMicrophoneCheck).not.toHaveBeenCalled();
      inherited.abort(); expect(view.getSnapshot()).toMatchObject({ status: "unavailable", microphone: null });
      selected.resolve({ ...ready, selectedInputId: "synthetic-headset", inputDevices: ready.inputDevices.map(device => ({
        ...device, current: device.id === "synthetic-headset" })) });
      await rejected; expect(view.getSnapshot().microphone).toBeNull();
      ending.resolve({}); await view.close(); expect(native.endMicrophoneCheck).toHaveBeenCalledOnce();
    } finally { selected.resolve(ready); ending.resolve({}); await selecting.catch(() => undefined); await view.close(); }
  });
  it("offers real named routes and reports selection only after native route acknowledgement", async () => {
    const native = plugin(), abort = new AbortController();
    const view = await openIOSAudioPreflight(abort.signal, native);
    try {
      expect(view.getSnapshot().selectedInputId).toBe("synthetic-built-in");
      await view.selectMicrophone("synthetic-headset");
      expect(native.selectMicrophoneDevice).toHaveBeenCalledWith({ id: "synthetic-headset" });
      expect(view.getSnapshot().inputDevices.find(device => device.current)?.label).toBe("Synthetic headset");
      await expect(view.selectMicrophone("not-advertised")).rejects.toThrow();
    } finally { await view.close(); }
    expect(native.endMicrophoneCheck).toHaveBeenCalledTimes(1);
  });
  it("ends native preparation promptly when a permission response arrives after cancellation", async () => {
    const native = plugin(), abort = new AbortController();
    let finish!: (value: unknown) => void;
    native.beginMicrophoneCheck = () => new Promise(resolve => { finish = resolve; });
    const opening = openIOSAudioPreflight(abort.signal, native);
    const rejected = expect(opening).rejects.toThrow();
    abort.abort();
    expect(native.endMicrophoneCheck).toHaveBeenCalledTimes(1);
    finish(ready); await rejected;
    expect(native.readMicrophoneCheck).not.toHaveBeenCalled();
    expect(native.endMicrophoneCheck).toHaveBeenCalledTimes(1);
  });
  it("rejects stale-route attribution, duplicate device IDs and invalid meter numbers", () => {
    expect(() => parseIOSAudioPreflight({ ...ready, selectedInputId: "synthetic-headset" })).toThrow();
    expect(() => parseIOSAudioPreflight({ ...ready, inputDevices: [ready.inputDevices[0], ready.inputDevices[0]] })).toThrow();
    expect(() => parseIOSAudioPreflight({ ...ready, microphone: { level: Infinity, ageMs: 0 } })).toThrow();
  });
});
