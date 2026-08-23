import { describe, expect, it } from "vitest";

import type { OneTimeCaptureCapability } from "./protocol.js";
import {
  normalizeRecallSdkEvent,
  RecallDesktopCaptureAdapter,
  RECALL_DESKTOP_API_URL,
  type RecallEventName,
  type RecallPermission,
  type RecallSdkInitOptions,
  type RecallSdkPort,
} from "./recall-sdk-adapter.js";

class FakeRecallSdk implements RecallSdkPort {
  readonly listeners = new Map<RecallEventName, Set<(payload: unknown) => void>>();
  readonly requestedPermissions: RecallPermission[] = [];
  readonly startSnapshots: Array<{ windowId: string; uploadToken: string }> = [];
  readonly startReferences: Array<{ windowId: string; uploadToken: string }> = [];
  initOptions: RecallSdkInitOptions | null = null;
  inits = 0;
  stops = 0;
  shutdowns = 0;

  init(options: RecallSdkInitOptions): Promise<unknown> {
    this.inits += 1;
    this.initOptions = options;
    return Promise.resolve(null);
  }

  shutdown(): Promise<unknown> {
    this.shutdowns += 1;
    return Promise.resolve(null);
  }

  startRecording(config: {
    windowId: string;
    uploadToken: string;
  }): Promise<unknown> {
    this.startSnapshots.push({ ...config });
    this.startReferences.push(config);
    return Promise.resolve(null);
  }

  stopRecording(_config: { readonly windowId: string }): Promise<unknown> {
    void _config;
    this.stops += 1;
    return Promise.resolve(null);
  }

  requestPermission(permission: RecallPermission): Promise<unknown> {
    this.requestedPermissions.push(permission);
    return Promise.resolve(null);
  }

  addEventListener(
    type: RecallEventName,
    callback: (payload: unknown) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: RecallEventName,
    callback: (payload: unknown) => void,
  ): void {
    this.listeners.get(type)?.delete(callback);
  }

  emit(type: RecallEventName, payload: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(payload);
    }
  }
}

class HungStartRecallSdk extends FakeRecallSdk {
  override startRecording(config: {
    windowId: string;
    uploadToken: string;
  }): Promise<unknown> {
    this.startSnapshots.push({ ...config });
    this.startReferences.push(config);
    return new Promise(() => undefined);
  }
}

class HungStopRecallSdk extends FakeRecallSdk {
  override stopRecording(_config: { readonly windowId: string }): Promise<unknown> {
    void _config;
    this.stops += 1;
    return new Promise(() => undefined);
  }
}

function capability(id = "capability-synthetic-recall"): OneTimeCaptureCapability {
  return {
    capabilityId: id,
    secret: "test-token-test-token",
    expiresAt: "2030-01-01T00:05:00.000Z",
  };
}

describe("Recall desktop adapter", () => {
  it("initializes with an explicit region, no ambient secret, and restart disabled", async () => {
    const sdk = new FakeRecallSdk();
    const adapter = new RecallDesktopCaptureAdapter(sdk);
    process.env.RECALL_API_KEY = "<synthetic-secret>";
    try {
      await expect(adapter.initialize(new AbortController().signal)).resolves.toBe(
        "permission_required",
      );
      expect(sdk.initOptions).toEqual({
        apiUrl: RECALL_DESKTOP_API_URL,
        restartOnError: false,
        acquirePermissionsOnStartup: [],
      });
      expect(Object.keys(sdk.initOptions ?? {})).toEqual([
        "apiUrl",
        "restartOnError",
        "acquirePermissionsOnStartup",
      ]);
      expect(JSON.stringify(sdk.initOptions)).not.toContain(
        "<synthetic-secret>",
      );
    } finally {
      delete process.env.RECALL_API_KEY;
    }
  });

  it("passes only the detected window and one-time server upload token, then scrubs both references", async () => {
    const sdk = new FakeRecallSdk();
    const adapter = new RecallDesktopCaptureAdapter(sdk);
    await adapter.initialize(new AbortController().signal);
    sdk.emit("meeting-detected", {
      window: {
        id: "window-synthetic-001",
        title: "sensitive-title-must-be-discarded",
        url: "https://sensitive.invalid/meeting",
      },
    });
    sdk.emit("permissions-granted", {});

    const first = capability();
    await adapter.start(first, new AbortController().signal);
    expect(sdk.startSnapshots).toEqual([
      {
        windowId: "window-synthetic-001",
        uploadToken: "test-token-test-token",
      },
    ]);
    expect(Object.keys(sdk.startSnapshots[0] ?? {}).sort()).toEqual([
      "uploadToken",
      "windowId",
    ]);
    expect(first.secret).toBe("");
    expect(sdk.startReferences[0]?.uploadToken).toBe("");

    await adapter.abort(new AbortController().signal);
    const replay = capability();
    await expect(
      adapter.start(replay, new AbortController().signal),
    ).rejects.toThrow("cannot start");
    expect(replay.secret).toBe("");
  });

  it("normalizes events without retaining titles, URLs, errors, or other payload fields", () => {
    const normalized = normalizeRecallSdkEvent("meeting-detected", {
      window: {
        id: "window-synthetic-002",
        title: "discard-this-title",
        url: "https://discard.invalid/",
        platform: "discard-this-platform",
      },
      extra: "discard-this-extra",
    });
    expect(normalized).toEqual({
      kind: "meeting_detected",
      windowId: "window-synthetic-002",
    });
    expect(JSON.stringify(normalized)).not.toContain("discard-this");
    expect(
      normalizeRecallSdkEvent("error", {
        message: "sensitive-vendor-message",
        type: "process",
      }),
    ).toEqual({ kind: "failed" });
  });

  it("issues a stop barrier when a native start is aborted", async () => {
    const sdk = new HungStartRecallSdk();
    const adapter = new RecallDesktopCaptureAdapter(sdk);
    await adapter.initialize(new AbortController().signal);
    sdk.emit("meeting-detected", { window: { id: "window-synthetic-abort" } });
    sdk.emit("permissions-granted", {});
    const startAbort = new AbortController();
    const start = adapter.start(capability("capability-abort"), startAbort.signal);
    startAbort.abort();
    await expect(start).rejects.toThrow("cancelled");
    expect(sdk.stops).toBe(1);
    expect(sdk.startReferences[0]?.uploadToken).toBe("");
  });

  it("fully restarts the SDK for a later backend session", async () => {
    const sdk = new FakeRecallSdk();
    const adapter = new RecallDesktopCaptureAdapter(sdk);
    await adapter.initialize(new AbortController().signal);
    sdk.emit("meeting-detected", { window: { id: "window-synthetic-first" } });
    sdk.emit("permissions-granted", {});
    await adapter.start(capability("capability-first"), new AbortController().signal);
    await adapter.stop(new AbortController().signal);

    await expect(adapter.initialize(new AbortController().signal)).resolves.toBe(
      "permission_required",
    );
    expect(sdk.inits).toBe(2);
    expect(sdk.shutdowns).toBe(1);
  });

  it("runs SDK shutdown even when the preceding stop never settles", async () => {
    const sdk = new HungStopRecallSdk();
    const adapter = new RecallDesktopCaptureAdapter(sdk);
    await adapter.initialize(new AbortController().signal);
    sdk.emit("meeting-detected", { window: { id: "window-synthetic-shutdown" } });
    sdk.emit("permissions-granted", {});
    await adapter.start(
      capability("capability-shutdown"),
      new AbortController().signal,
    );

    await expect(adapter.shutdown(new AbortController().signal)).resolves.toBeUndefined();
    expect(sdk.stops).toBe(1);
    expect(sdk.shutdowns).toBe(1);
  });

  it("turns network loss and audio-device loss into terminal controller signals", async () => {
    const sdk = new FakeRecallSdk();
    const adapter = new RecallDesktopCaptureAdapter(sdk);
    const signals: string[] = [];
    adapter.onSignal((signal) => signals.push(signal.kind));
    await adapter.initialize(new AbortController().signal);

    sdk.emit("meeting-detected", { window: { id: "window-synthetic-003" } });
    sdk.emit("permissions-granted", {});
    await adapter.start(capability("capability-device-loss"), new AbortController().signal);
    signals.length = 0;
    sdk.emit("network-status", { status: "reconnected" });
    sdk.emit("network-status", { status: "disconnected", detail: "discarded" });
    sdk.emit("media-capture-status", {
      window: { id: "window-synthetic-003" },
      type: "video",
      capturing: false,
    });
    sdk.emit("media-capture-status", {
      window: { id: "window-synthetic-003" },
      type: "audio",
      capturing: false,
    });
    expect(signals).toEqual(["network_lost", "device_changed"]);
  });

  it("fails closed on a second meeting or an unexpected recording end", async () => {
    const sdk = new FakeRecallSdk();
    const adapter = new RecallDesktopCaptureAdapter(sdk);
    const signals: string[] = [];
    adapter.onSignal((signal) => signals.push(signal.kind));
    await adapter.initialize(new AbortController().signal);
    sdk.emit("meeting-detected", { window: { id: "window-synthetic-primary" } });
    sdk.emit("meeting-updated", { window: { id: "window-synthetic-second" } });
    expect(signals.at(-1)).toBe("failed");

    const activeSdk = new FakeRecallSdk();
    const activeAdapter = new RecallDesktopCaptureAdapter(activeSdk);
    const activeSignals: string[] = [];
    activeAdapter.onSignal((signal) => activeSignals.push(signal.kind));
    await activeAdapter.initialize(new AbortController().signal);
    activeSdk.emit("meeting-detected", {
      window: { id: "window-synthetic-active" },
    });
    activeSdk.emit("permissions-granted", {});
    await activeAdapter.start(
      capability("capability-active-meeting"),
      new AbortController().signal,
    );
    activeSignals.length = 0;
    activeSdk.emit("meeting-detected", {
      window: { id: "window-synthetic-overlap" },
    });
    expect(activeSignals).toEqual(["failed"]);

    const secondSdk = new FakeRecallSdk();
    const secondAdapter = new RecallDesktopCaptureAdapter(secondSdk);
    const secondSignals: string[] = [];
    secondAdapter.onSignal((signal) => secondSignals.push(signal.kind));
    await secondAdapter.initialize(new AbortController().signal);
    secondSdk.emit("meeting-detected", {
      window: { id: "window-synthetic-recording" },
    });
    secondSdk.emit("permissions-granted", {});
    await secondAdapter.start(
      capability("capability-unexpected-end"),
      new AbortController().signal,
    );
    secondSignals.length = 0;
    secondSdk.emit("recording-ended", {
      window: { id: "window-synthetic-recording" },
    });
    expect(secondSignals).toEqual(["failed"]);
  });

  it("requests only the reviewed permission set and removes listeners on shutdown", async () => {
    const sdk = new FakeRecallSdk();
    const adapter = new RecallDesktopCaptureAdapter(sdk);
    await adapter.initialize(new AbortController().signal);
    await adapter.refreshPermissions(new AbortController().signal);
    expect(sdk.requestedPermissions).toEqual([
      "accessibility",
      "screen-capture",
      "microphone",
      "system-audio",
    ]);
    await adapter.shutdown(new AbortController().signal);
    expect(sdk.shutdowns).toBe(1);
    expect([...sdk.listeners.values()].every((listeners) => listeners.size === 0)).toBe(
      true,
    );
  });
});
