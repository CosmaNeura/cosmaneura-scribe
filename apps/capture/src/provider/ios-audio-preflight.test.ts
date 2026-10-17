import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openIOSAudioPreflight, parseIOSAudioPreflight, type IOSMicrophoneCheckPlugin } from "./ios-audio-preflight";

const ready = { version: 1, status: "ready", inputDevices: [
  { id: "synthetic-built-in", label: "Synthetic iPhone microphone", kind: "built_in", current: true },
  { id: "synthetic-headset", label: "Synthetic headset", kind: "bluetooth", current: false },
], selectedInputId: "synthetic-built-in", microphone: null };
function visibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}
beforeEach(() => {
  const document = new EventTarget(); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("document", document);
});
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
    let selecting: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(250); expect(native.readMicrophoneCheck).toHaveBeenCalledOnce();
      selecting = view.selectMicrophone("synthetic-headset");
      expect(native.selectMicrophoneDevice).not.toHaveBeenCalled();
      oldRead.resolve(ready); await selecting; await vi.advanceTimersByTimeAsync(0);
      expect(view.getSnapshot().selectedInputId).toBe("synthetic-headset");
      expect(view.getSnapshot().inputDevices.find(device => device.current)?.id).toBe("synthetic-built-in");
    } finally { oldRead.resolve(ready); await selecting?.catch(() => undefined); await view.close(); }
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
  it("joins native preparation when its catalogue response arrives after cancellation", async () => {
    const native = plugin(), abort = new AbortController();
    let finish!: (value: unknown) => void;
    native.beginMicrophoneCheck = () => new Promise(resolve => { finish = resolve; });
    const opening = openIOSAudioPreflight(abort.signal, native);
    const rejected = expect(opening).rejects.toThrow();
    try {
      await Promise.resolve(); // The native begin has dispatched.
      abort.abort();
      expect(native.endMicrophoneCheck).not.toHaveBeenCalled();
      finish(ready); await rejected;
      expect(native.readMicrophoneCheck).not.toHaveBeenCalled();
      expect(native.endMicrophoneCheck).toHaveBeenCalledTimes(1);
    } finally { abort.abort(); finish(ready); await rejected; }
  });
  it("rejects absent selections, duplicate device IDs and all preparation meter values", () => {
    expect(() => parseIOSAudioPreflight({ ...ready, selectedInputId: "missing-input" })).toThrow();
    expect(() => parseIOSAudioPreflight({ ...ready, inputDevices: [ready.inputDevices[0], ready.inputDevices[0]] })).toThrow();
    expect(() => parseIOSAudioPreflight({ ...ready, microphone: { level: Infinity, ageMs: 0 } })).toThrow();
  });
  it("reopens one ended foreground metadata owner without permission, selection or audio", async () => {
    vi.useFakeTimers();
    const native = plugin(), empty = { ...ready, inputDevices: [], selectedInputId: null };
    let alive = true;
    native.beginMicrophoneCheck = vi.fn(async () => { alive = true; return empty; });
    native.readMicrophoneCheck = vi.fn(async () => alive ? empty : { ...empty, status: "unavailable" });
    const view = await openIOSAudioPreflight(new AbortController().signal, native);
    try {
      visibility("hidden"); alive = false;
      expect(view.getSnapshot().status).toBe("unavailable");
      await vi.advanceTimersByTimeAsync(500);
      expect(native.beginMicrophoneCheck).toHaveBeenCalledOnce();
      visibility("visible"); await vi.advanceTimersByTimeAsync(1500);
      expect(native.beginMicrophoneCheck).toHaveBeenCalledTimes(2);
      expect(view.getSnapshot()).toMatchObject({ status: "ready", inputDevices: [], selectedInputId: null, microphone: null });
      expect(native.requestRecordingAccess).not.toHaveBeenCalled();
      expect(native.selectMicrophoneDevice).not.toHaveBeenCalled();
      expect(native.endMicrophoneCheck).not.toHaveBeenCalled();
    } finally { await view.close(); }
  });
  it("handles a brief native resign without a WebView event once, and never steals a duplicate owner", async () => {
    vi.useFakeTimers();
    const native = plugin();
    native.beginMicrophoneCheck = vi.fn().mockResolvedValueOnce(ready).mockRejectedValue(new Error("Synthetic native idle fence"));
    native.readMicrophoneCheck = vi.fn(async () => ({ ...ready, status: "unavailable" }));
    const view = await openIOSAudioPreflight(new AbortController().signal, native);
    try {
      await vi.advanceTimersByTimeAsync(2000);
      expect(native.beginMicrophoneCheck).toHaveBeenCalledTimes(2);
      expect(view.getSnapshot().status).toBe("unavailable");
      expect(native.endMicrophoneCheck).not.toHaveBeenCalled();
      expect(native.requestRecordingAccess).not.toHaveBeenCalled();
      expect(native.selectMicrophoneDevice).not.toHaveBeenCalled();
    } finally { await view.close(); }
  });
  it("keeps malformed recovery metadata unavailable and bounded", async () => {
    vi.useFakeTimers();
    const native = plugin();
    native.beginMicrophoneCheck = vi.fn().mockResolvedValueOnce(ready).mockResolvedValue({ ...ready, microphone: { level: .2 } });
    native.readMicrophoneCheck = vi.fn(async () => ({ ...ready, extra: "invalid" }));
    const view = await openIOSAudioPreflight(new AbortController().signal, native);
    try {
      await vi.advanceTimersByTimeAsync(2000);
      expect(native.beginMicrophoneCheck).toHaveBeenCalledTimes(2);
      expect(view.getSnapshot()).toMatchObject({ status: "unavailable", microphone: null });
      expect(native.requestRecordingAccess).not.toHaveBeenCalled();
    } finally { await view.close(); }
  });
  it("joins a pending recovery before final end and before the caller may admit recording", async () => {
    vi.useFakeTimers();
    const native = plugin(), recovery = deferred(), ending = deferred(), abort = new AbortController();
    native.beginMicrophoneCheck = vi.fn().mockResolvedValueOnce(ready).mockImplementation(() => recovery.promise);
    native.readMicrophoneCheck = vi.fn(async () => ({ ...ready, status: "unavailable" }));
    native.endMicrophoneCheck = vi.fn(() => ending.promise);
    const view = await openIOSAudioPreflight(abort.signal, native);
    const statuses: string[] = []; view.subscribe(value => statuses.push(value.status));
    await vi.advanceTimersByTimeAsync(250);
    expect(native.beginMicrophoneCheck).toHaveBeenCalledTimes(2);
    const closed = view.close(); let mayAdmit = false;
    const admissionFence = closed.then(() => { mayAdmit = true; });
    abort.abort(); expect(view.getSnapshot().status).toBe("unavailable");
    expect(native.endMicrophoneCheck).not.toHaveBeenCalled(); expect(mayAdmit).toBe(false);
    recovery.resolve(ready); await vi.advanceTimersByTimeAsync(0);
    expect(native.endMicrophoneCheck).toHaveBeenCalledOnce(); expect(mayAdmit).toBe(false);
    expect(statuses.at(-1)).toBe("checking"); // No late ready from the closed visit.
    ending.resolve({}); await admissionFence;
    expect(mayAdmit).toBe(true); expect(view.getSnapshot().status).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(1000); expect(native.beginMicrophoneCheck).toHaveBeenCalledTimes(2);
  });
  it("does not publish a late background ready result or queue a permission action during recovery", async () => {
    vi.useFakeTimers();
    const native = plugin(), recovery = deferred();
    native.beginMicrophoneCheck = vi.fn().mockResolvedValueOnce(ready).mockImplementation(() => recovery.promise);
    native.readMicrophoneCheck = vi.fn(async () => ({ ...ready, status: "unavailable" }));
    const view = await openIOSAudioPreflight(new AbortController().signal, native);
    try {
      await vi.advanceTimersByTimeAsync(250);
      await expect(view.requestRecordingAccess!()).rejects.toThrow();
      await expect(view.selectMicrophone("synthetic-headset")).rejects.toThrow();
      visibility("hidden"); recovery.resolve(ready); await vi.advanceTimersByTimeAsync(0);
      expect(view.getSnapshot().status).toBe("unavailable");
      expect(native.requestRecordingAccess).not.toHaveBeenCalled();
      expect(native.selectMicrophoneDevice).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000); expect(native.beginMicrophoneCheck).toHaveBeenCalledTimes(2);
    } finally { recovery.resolve(ready); await view.close(); }
  });
  it("joins account-aborted recovery before a replacement visit can own metadata", async () => {
    vi.useFakeTimers();
    const native = plugin(), recovery = deferred(), account = new AbortController();
    const order: string[] = [];
    native.beginMicrophoneCheck = vi.fn().mockResolvedValueOnce(ready).mockImplementationOnce(() => {
      order.push("old-recovery"); return recovery.promise;
    }).mockImplementation(async () => { order.push("new-begin"); return ready; });
    native.readMicrophoneCheck = vi.fn(async () => ({ ...ready, status: "unavailable" }));
    native.endMicrophoneCheck = vi.fn(async () => { order.push("old-end"); return {}; });
    const old = await openIOSAudioPreflight(new AbortController().signal, native, account.signal);
    const statuses: string[] = []; old.subscribe(value => statuses.push(value.status));
    await vi.advanceTimersByTimeAsync(250);
    account.abort(); const closed = old.close();
    expect(old.getSnapshot().status).toBe("unavailable");
    expect(native.endMicrophoneCheck).not.toHaveBeenCalled();
    await expect(old.requestRecordingAccess!()).rejects.toThrow();
    recovery.resolve(ready); await closed;
    expect(statuses).toEqual(["ready", "unavailable", "checking"]);
    const next = await openIOSAudioPreflight(new AbortController().signal, native);
    try {
      expect(order).toEqual(["old-recovery", "old-end", "new-begin"]);
      expect(old.getSnapshot().status).toBe("unavailable");
      expect(next.getSnapshot().status).toBe("ready");
      expect(native.requestRecordingAccess).not.toHaveBeenCalled();
    } finally { await next.close(); }
  });
  it("preserves rejection of a permission action spanning resign and requires deliberate retry", async () => {
    vi.useFakeTimers();
    const native = plugin(), permission = deferred();
    native.requestRecordingAccess = vi.fn().mockImplementationOnce(() => permission.promise).mockResolvedValue(ready);
    native.readMicrophoneCheck = vi.fn(async () => ({ ...ready, status: "unavailable" }));
    const view = await openIOSAudioPreflight(new AbortController().signal, native);
    try {
      const asking = view.requestRecordingAccess!(), rejected = expect(asking).rejects.toThrow();
      await Promise.resolve(); visibility("hidden"); visibility("visible");
      await vi.advanceTimersByTimeAsync(500); expect(native.beginMicrophoneCheck).toHaveBeenCalledOnce();
      permission.resolve(ready); await rejected;
      expect(view.getSnapshot().status).toBe("unavailable");
      await vi.advanceTimersByTimeAsync(250);
      expect(native.beginMicrophoneCheck).toHaveBeenCalledTimes(2);
      expect(native.requestRecordingAccess).toHaveBeenCalledOnce();
      await view.requestRecordingAccess!(); expect(native.requestRecordingAccess).toHaveBeenCalledTimes(2);
      expect(view.getSnapshot().status).toBe("ready");
    } finally { permission.resolve(ready); await view.close(); }
  });
});
