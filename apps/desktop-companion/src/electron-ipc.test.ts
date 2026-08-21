import { describe, expect, it } from "vitest";

import {
  OneTimeCapabilityRegistry,
  type TrustedCaptureAuthority,
} from "./capture-authority.js";
import { DesktopCaptureController } from "./controller.js";
import {
  createElectronRendererApi,
  ELECTRON_IPC_CHANNELS,
  ElectronMainIpcBoundary,
  type ElectronIpcMainPort,
  type ElectronIpcRendererPort,
} from "./electron-ipc.js";
import { MockDesktopCaptureAdapter } from "./mock-capture-adapter.js";
import { InMemoryRecordingIndicator } from "./recording-indicator.js";
import { SingleRecordingLease } from "./recording-lease.js";
import type { BackendCaptureGrant } from "./protocol.js";

type Handler = (
  event: {
    readonly sender: {
      readonly id: number;
      readonly mainFrame: { readonly url: string };
    };
    readonly senderFrame: { readonly url: string } | null;
  },
  payload: unknown,
) => Promise<unknown>;

class FakeIpcMain implements ElectronIpcMainPort {
  readonly handlers = new Map<string, Handler>();

  handle(channel: string, listener: Handler): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  async invoke(
    channel: string,
    senderId: number,
    payload: unknown,
    url = "app://cosmas/index.html",
    topLevel = true,
  ): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (handler === undefined) {
      throw new Error("missing synthetic IPC handler");
    }
    const mainFrame = { url };
    return handler({
      sender: { id: senderId, mainFrame },
      senderFrame: topLevel ? mainFrame : { url },
    }, payload);
  }
}

class FakeIpcRenderer implements ElectronIpcRendererPort {
  readonly listeners = new Set<(event: unknown, payload: unknown) => void>();

  constructor(
    private readonly main: FakeIpcMain,
    private readonly senderId: number,
  ) {}

  invoke(channel: string, payload: unknown): Promise<unknown> {
    return this.main.invoke(channel, this.senderId, payload);
  }

  on(
    _channel: typeof ELECTRON_IPC_CHANNELS.stateChanged,
    listener: (event: unknown, payload: unknown) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeListener(
    _channel: typeof ELECTRON_IPC_CHANNELS.stateChanged,
    listener: (event: unknown, payload: unknown) => void,
  ): void {
    this.listeners.delete(listener);
  }

  emit(payload: unknown): void {
    for (const listener of this.listeners) {
      listener({}, payload);
    }
  }
}

const backendGrant: BackendCaptureGrant = {
  captureSessionId: "capture-synthetic-electron",
  actorId: "actor-synthetic-electron",
  consentRecordId: "consent-synthetic-electron",
  consentStatus: "granted",
  sessionStatus: "authorized",
  source: "desktop_companion",
  sourceLeaseId: "source-lease-synthetic-electron",
};
const capabilitySecret = "test-token-test-token";

class AuthorizedAuthority implements TrustedCaptureAuthority {
  authorizeStart(
    session: BackendCaptureGrant,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted || session.source !== "desktop_companion") {
      return Promise.reject(new Error("synthetic authority failure"));
    }
    return Promise.resolve({
      schemaVersion: 1,
      decision: "authorized",
      ...backendGrant,
      issuedAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:05:00.000Z",
      captureCapability: {
        capabilityId: "capability-synthetic-electron",
        secret: capabilitySecret,
        expiresAt: "2030-01-01T00:05:00.000Z",
      },
    });
  }
}

describe("Electron IPC boundary", () => {
  it("exposes only narrow renderer methods and keeps the backend token in main", async () => {
    const ipcMain = new FakeIpcMain();
    const sent: unknown[] = [];
    const controller = new DesktopCaptureController(
      new MockDesktopCaptureAdapter(),
      new InMemoryRecordingIndicator(),
      {
        enabled: true,
        authority: new AuthorizedAuthority(),
        capabilityRegistry: new OneTimeCapabilityRegistry(),
        clock: () => new Date("2030-01-01T00:02:00.000Z"),
        lease: new SingleRecordingLease(),
      },
    );
    const boundary = new ElectronMainIpcBoundary(
      ipcMain,
      {
        id: 7,
        send: (_channel, payload) => void sent.push(payload),
      },
      controller,
    );
    boundary.install();
    expect(
      await boundary.initializeFromBackend(backendGrant, "request-main-init"),
    ).toMatchObject({ ok: true });

    let counter = 0;
    const renderer = new FakeIpcRenderer(ipcMain, 7);
    const api = createElectronRendererApi(
      renderer,
      () => `request-renderer-${String(++counter)}`,
    );
    expect(Object.keys(api).sort()).toEqual([
      "getState",
      "onStateChanged",
      "refreshPermissions",
      "start",
      "stop",
    ]);
    expect(await api.start()).toMatchObject({ ok: true, errorCode: null });
    expect(await api.getState()).toMatchObject({ state: "recording" });
    expect(JSON.stringify(sent)).not.toContain(capabilitySecret);
    expect(JSON.stringify(await api.stop())).not.toContain(capabilitySecret);
  });

  it("rejects another renderer and exposes no generic channel invocation", async () => {
    const ipcMain = new FakeIpcMain();
    const controller = new DesktopCaptureController(
      new MockDesktopCaptureAdapter(),
      new InMemoryRecordingIndicator(),
      { enabled: true, lease: new SingleRecordingLease() },
    );
    const boundary = new ElectronMainIpcBoundary(
      ipcMain,
      { id: 9, send: () => undefined },
      controller,
    );
    boundary.install();

    await expect(
      ipcMain.invoke(ELECTRON_IPC_CHANNELS.start, 99, {
        schemaVersion: 1,
        requestId: "request-hostile-renderer",
      }),
    ).rejects.toMatchObject({ code: "renderer_unauthorized" });

    await expect(
      ipcMain.invoke(
        ELECTRON_IPC_CHANNELS.start,
        9,
        {
          schemaVersion: 1,
          kind: "start",
          requestId: "request-wrong-origin",
        },
        "https://example.invalid/",
        true,
      ),
    ).rejects.toMatchObject({ code: "renderer_unauthorized" });

    await expect(
      ipcMain.invoke(
        ELECTRON_IPC_CHANNELS.getState,
        9,
        { schemaVersion: 1, requestId: "request-subframe" },
        "app://cosmas/index.html",
        false,
      ),
    ).rejects.toMatchObject({ code: "renderer_unauthorized" });

    const renderer = new FakeIpcRenderer(ipcMain, 9);
    const api = createElectronRendererApi(renderer, () => "request-narrow-api");
    expect("invoke" in api).toBe(false);
    expect("shell" in api).toBe(false);
  });
});
