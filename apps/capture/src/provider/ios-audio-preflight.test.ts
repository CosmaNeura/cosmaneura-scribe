import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openIOSAudioPreflight, parseIOSAudioPreflight, type IOSMicrophoneCheckPlugin } from "./ios-audio-preflight";

const ready = { version: 1, status: "ready", inputDevices: [
  { id: "synthetic-built-in", label: "Synthetic iPhone microphone", kind: "built_in", current: true },
  { id: "synthetic-headset", label: "Synthetic headset", kind: "bluetooth", current: false },
], selectedInputId: "synthetic-built-in", microphone: null };
beforeEach(() => { vi.stubGlobal("document", { visibilityState: "visible" }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function plugin() {
  let value = structuredClone(ready);
  const native: IOSMicrophoneCheckPlugin = {
    beginMicrophoneCheck: vi.fn(async () => value), readMicrophoneCheck: vi.fn(async () => value),
    requestRecordingAccess: vi.fn(async () => value),
    endMicrophoneCheck: vi.fn(async () => ({})), selectMicrophoneDevice: vi.fn(async ({ id }) => {
      value = { ...value, selectedInputId: id };
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
  it("opens, polls and selects only metadata without requesting access or accepting a meter", async () => {
    vi.useFakeTimers();
    const native = plugin(), view = await openIOSAudioPreflight(new AbortController().signal, native);
    try {
      await vi.advanceTimersByTimeAsync(250);
      await view.selectMicrophone("synthetic-headset");
      expect(native.requestRecordingAccess).not.toHaveBeenCalled();
      expect(view.getSnapshot().microphone).toBeNull();
      expect(view.getSnapshot().selectedInputId).toBe("synthetic-headset");
      expect(view.getSnapshot().inputDevices.find(device => device.current)?.id).toBe("synthetic-built-in");
      expect(() => parseIOSAudioPreflight({ ...ready, microphone: { level: .2, ageMs: 40 } })).toThrow();
    } finally { await view.close(); }
  });
  it("requests access only explicitly and fences a late result after the visit closes", async () => {
    vi.useFakeTimers();
    const native = plugin(), permission = deferred(), inherited = new AbortController();
    native.requestRecordingAccess = vi.fn(() => permission.promise);
    const view = await openIOSAudioPreflight(new AbortController().signal, native, inherited.signal);
    expect(native.requestRecordingAccess).not.toHaveBeenCalled();
    const asking = view.requestRecordingAccess!(), rejected = expect(asking).rejects.toThrow();
    try {
      expect(view.getSnapshot().status).toBe("checking");
      await expect(view.requestRecordingAccess!()).rejects.toThrow();
      await view.selectMicrophone("synthetic-headset").catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1000);
      expect(native.readMicrophoneCheck).not.toHaveBeenCalled();
      expect(native.selectMicrophoneDevice).not.toHaveBeenCalled();
      inherited.abort(); permission.resolve(ready); await rejected;
      expect(native.requestRecordingAccess).toHaveBeenCalledOnce();
      expect(view.getSnapshot()).toMatchObject({ status: "unavailable", microphone: null });
    } finally { permission.resolve(ready); await asking.catch(() => undefined); await view.close(); }
  });
  it("keeps permission denial truthful after an explicit access request", async () => {
    const native = plugin();
    native.requestRecordingAccess = vi.fn(async () => ({ version: 1, status: "permission_required",
      inputDevices: [], selectedInputId: null, microphone: null }));
    const view = await openIOSAudioPreflight(new AbortController().signal, native);
    try {
      await view.requestRecordingAccess!();
      expect(view.getSnapshot()).toMatchObject({ status: "permission_required", microphone: null, selectedInputId: null });
    } finally { await view.close(); }
  });
  it("reports failed access setup as unavailable instead of leaving a false ready state", async () => {
    const native = plugin();
    native.requestRecordingAccess = vi.fn(async () => { throw new Error("synthetic setup failure"); });
    const view = await openIOSAudioPreflight(new AbortController().signal, native);
    try {
      await expect(view.requestRecordingAccess!()).rejects.toThrow();
      expect(view.getSnapshot()).toMatchObject({ status: "unavailable", microphone: null });
    } finally { await view.close(); }
  });
  it("accepts granted access with an inactive empty catalogue and defers default microphone validation", async () => {
    const native = plugin(), empty = { ...ready, inputDevices: [], selectedInputId: null };
    native.beginMicrophoneCheck = vi.fn(async () => empty);
    const view = await openIOSAudioPreflight(new AbortController().signal, native);
    try {
      expect(view.getSnapshot()).toMatchObject({ status: "ready", inputDevices: [], selectedInputId: null, microphone: null });
      await expect(view.selectMicrophone("synthetic-built-in")).rejects.toThrow();
      expect(native.selectMicrophoneDevice).not.toHaveBeenCalled();
      expect(native.requestRecordingAccess).not.toHaveBeenCalled();
    } finally { await view.close(); }
  });
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
      expect(view.getSnapshot().inputDevices.find(device => device.current)?.id).toBe("synthetic-built-in");
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
  it("offers named inputs and acknowledges the next-start preference without claiming a route switch", async () => {
    const native = plugin(), abort = new AbortController();
    const view = await openIOSAudioPreflight(abort.signal, native);
    try {
      expect(view.getSnapshot().selectedInputId).toBe("synthetic-built-in");
      await view.selectMicrophone("synthetic-headset");
      expect(native.selectMicrophoneDevice).toHaveBeenCalledWith({ id: "synthetic-headset" });
      expect(view.getSnapshot().inputDevices.find(device => device.id === view.getSnapshot().selectedInputId)?.label).toBe("Synthetic headset");
      expect(view.getSnapshot().inputDevices.find(device => device.current)?.label).toBe("Synthetic iPhone microphone");
      await expect(view.selectMicrophone("not-advertised")).rejects.toThrow();
    } finally { await view.close(); }
    expect(native.endMicrophoneCheck).toHaveBeenCalledTimes(1);
  });
  it("ends native preparation promptly when its catalogue response arrives after cancellation", async () => {
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
  it("rejects absent selections, duplicate device IDs and all preparation meter values", () => {
    expect(() => parseIOSAudioPreflight({ ...ready, selectedInputId: "missing-input" })).toThrow();
    expect(() => parseIOSAudioPreflight({ ...ready, inputDevices: [ready.inputDevices[0], ready.inputDevices[0]] })).toThrow();
    expect(() => parseIOSAudioPreflight({ ...ready, microphone: { level: Infinity, ageMs: 0 } })).toThrow();
  });
});
