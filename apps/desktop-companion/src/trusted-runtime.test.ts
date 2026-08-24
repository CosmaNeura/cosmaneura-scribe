import { describe, expect, it, vi } from "vitest";

import { DESKTOP_REDIRECT_URI } from "./browser-handoff.js";
import { MockDesktopCaptureAdapter } from "./mock-capture-adapter.js";
import { InMemoryRecordingIndicator } from "./recording-indicator.js";
import type {
  ElectronSafeStoragePort,
  EncryptedStateFilePort,
} from "./secure-state-store.js";
import { createTrustedDesktopRuntime } from "./trusted-runtime.js";

const LAUNCH_TICKET = "l".repeat(43);
const AUTH_CODE = "c".repeat(43);
const ACCESS_TOKEN = "t".repeat(43);
const UPLOAD_TOKEN = "u".repeat(43);
const NOW = new Date("2030-01-01T00:00:30.000Z");
const grant = {
  captureSessionId: "capture-synthetic-runtime",
  actorId: "actor-synthetic-runtime",
  consentRecordId: "consent-synthetic-runtime",
  consentStatus: "granted",
  sessionStatus: "authorized",
  source: "desktop_companion",
  sourceLeaseId: "lease-synthetic-runtime",
} as const;

class MemoryFile implements EncryptedStateFilePort {
  value: string | null = null;
  read = async () => this.value;
  replace = async (value: string) => {
    this.value = value;
  };
}

const encryption: ElectronSafeStoragePort = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x33),
  decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x33).toString(),
};

function command(kind: "start" | "stop", requestId: string) {
  return { schemaVersion: 1, kind, requestId } as const;
}

describe("trusted Electron main-process runtime", () => {
  it("accepts a replacement authentication UI adapter without changing capture coordination", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const pending = {
      schemaVersion: 1,
      state: "s".repeat(43),
      codeVerifier: "v".repeat(43),
      redirectUri: DESKTOP_REDIRECT_URI,
      createdAt: "2030-01-01T00:00:00.000Z",
    } as const;
    const authentication = {
      begin: vi.fn(() => ({
        connectUrl: "https://auth-revision.example.invalid/continue",
        pending,
      })),
      complete: vi.fn(() =>
        Promise.resolve({
          accessToken: ACCESS_TOKEN,
          expiresAt: "2030-01-01T00:05:00.000Z",
          grant,
        }),
      ),
    };
    const runtime = createTrustedDesktopRuntime({
      platformAppOrigin: "https://unused.example.invalid",
      platformApiOrigin: "https://api.example.invalid",
      authentication,
      adapter: new MockDesktopCaptureAdapter("ready"),
      indicator: new InMemoryRecordingIndicator(),
      safeStorage: encryption,
      protectedStateDirectory: "/synthetic/not-used",
      encryptedStateFile: new MemoryFile(),
      browser: { openExternal: vi.fn(() => Promise.resolve()) },
      enabled: true,
      fetch: fetchMock,
      clock: () => NOW,
    });

    await runtime.session.handleLaunchUrl(
      `cosmaneura-capture://launch?launch_ticket=${LAUNCH_TICKET}`,
    );
    await runtime.session.handleAuthorizationCallback(
      `cosmaneura-capture://oauth/callback?code=${AUTH_CODE}&state=${pending.state}`,
    );

    expect(authentication.begin).toHaveBeenCalledOnce();
    expect(authentication.complete).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runtime.controller.snapshot()).toMatchObject({
      state: "ready",
      captureSessionId: grant.captureSessionId,
    });
  });

  it("runs the complete synthetic browser-to-local-start-to-durable-stop flow", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/desktop/v1/oauth/token") {
        return Promise.resolve(
          response({
            access_token: ACCESS_TOKEN,
            expires_in: 300,
            grant,
            token_type: "Bearer",
          }),
        );
      }
      if (path.endsWith("/segments/start-authorizations")) {
        return Promise.resolve(
          response({
            schemaVersion: 1,
            decision: "authorized",
            ...grant,
            issuedAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-01T00:05:00.000Z",
            captureCapability: {
              capabilityId: "capability-synthetic-runtime",
              secret: UPLOAD_TOKEN,
              expiresAt: "2030-01-01T00:05:00.000Z",
            },
          }),
        );
      }
      if (path.endsWith("/heartbeats")) {
        return Promise.resolve(
          response({
            schemaVersion: 1,
            decision: "accepted",
            captureSessionId: grant.captureSessionId,
            capabilityId: "capability-synthetic-runtime",
            receiptId: "receipt-heartbeat-synthetic-runtime",
            sessionStatus: "recording",
          }),
        );
      }
      if (path.endsWith("/stop-requests")) {
        return Promise.resolve(
          response({
            schemaVersion: 1,
            decision: "accepted",
            captureSessionId: grant.captureSessionId,
            capabilityId: "capability-synthetic-runtime",
            receiptId: "receipt-stop-synthetic-runtime",
            sessionStatus: "stopping",
          }),
        );
      }
      return Promise.resolve(response({}, 404));
    });
    const browser = { openExternal: vi.fn(() => Promise.resolve()) };
    const adapter = new MockDesktopCaptureAdapter("ready");
    const runtime = createTrustedDesktopRuntime({
      platformAppOrigin: "https://app.example.invalid",
      platformApiOrigin: "https://api.example.invalid",
      adapter,
      indicator: new InMemoryRecordingIndicator(),
      safeStorage: encryption,
      protectedStateDirectory: "/synthetic/not-used",
      encryptedStateFile: new MemoryFile(),
      browser,
      enabled: true,
      fetch: fetchMock,
      clock: () => NOW,
    });

    await runtime.session.handleLaunchUrl(
      `cosmaneura-capture://launch?launch_ticket=${LAUNCH_TICKET}`,
    );
    const pending = (await runtime.store.load()).pendingAuthorization;
    expect(pending).not.toBeNull();
    await runtime.session.handleAuthorizationCallback(
      `cosmaneura-capture://oauth/callback?code=${AUTH_CODE}&state=${pending?.state ?? ""}`,
    );
    expect(runtime.controller.snapshot()).toMatchObject({
      state: "ready",
      captureSessionId: grant.captureSessionId,
    });

    await runtime.controller.handleRendererCommand(
      command("start", "request-runtime-start"),
    );
    expect(runtime.controller.snapshot().state).toBe("recording");
    expect((await runtime.store.load()).pendingStopReceipts).toHaveLength(1);

    await runtime.controller.handleRendererCommand(
      command("stop", "request-runtime-stop"),
    );
    expect(runtime.controller.snapshot().state).toBe("stopped");
    expect((await runtime.store.load()).pendingStopReceipts).toHaveLength(0);
    expect(adapter.operations).toEqual(["initialize", "start", "stop"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(runtime.controller.snapshot())).not.toContain(
      ACCESS_TOKEN,
    );
    expect(JSON.stringify(runtime.controller.snapshot())).not.toContain(
      UPLOAD_TOKEN,
    );
  });
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
