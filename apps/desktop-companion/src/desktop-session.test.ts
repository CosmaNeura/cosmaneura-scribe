import { describe, expect, it, vi } from "vitest";

import { DesktopApiClient } from "./desktop-api.js";
import {
  DesktopSessionCoordinator,
  DesktopSessionError,
} from "./desktop-session.js";
import {
  DesktopSecureStateStore,
  type ElectronSafeStoragePort,
  type EncryptedStateFilePort,
} from "./secure-state-store.js";

const LAUNCH_TICKET = "l".repeat(43);
const ACCESS_TOKEN = "t".repeat(43);
const AUTH_CODE = "c".repeat(43);
const grant = {
  captureSessionId: "capture-synthetic-001",
  actorId: "actor-synthetic-001",
  consentRecordId: "consent-synthetic-001",
  consentStatus: "granted",
  sessionStatus: "authorized",
  source: "desktop_companion",
  sourceLeaseId: "lease-synthetic-001",
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
  encryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x5a),
  decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0x5a).toString(),
};

describe("desktop session coordinator", () => {
  it("persists PKCE before opening the browser and exchanges the callback", async () => {
    const file = new MemoryFile();
    const store = new DesktopSecureStateStore(encryption, file);
    const browser = { openExternal: vi.fn(() => Promise.resolve()) };
    const initialize = vi.fn(() => Promise.resolve());
    const api = new DesktopApiClient("https://api.example.invalid", {
      clock: () => new Date("2030-01-01T00:00:30.000Z"),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: ACCESS_TOKEN,
            expires_in: 300,
            grant,
            token_type: "Bearer",
          }),
          { status: 200 },
        ),
      ),
    });
    const coordinator = new DesktopSessionCoordinator({
      platformAppOrigin: "https://app.example.invalid",
      api,
      store,
      browser,
      initializer: { initialize },
      clock: () => new Date("2030-01-01T00:00:00.000Z"),
    });

    await coordinator.handleLaunchUrl(
      `cosmaneura-capture://launch?launch_ticket=${LAUNCH_TICKET}`,
    );
    const pending = (await store.load()).pendingAuthorization;
    expect(pending).not.toBeNull();
    expect(browser.openExternal).toHaveBeenCalledOnce();
    expect(file.value).not.toContain(pending?.codeVerifier);

    await coordinator.handleAuthorizationCallback(
      `cosmaneura-capture://oauth/callback?code=${AUTH_CODE}&state=${pending?.state ?? ""}`,
    );
    expect(initialize).toHaveBeenCalledWith(
      grant,
      expect.stringMatching(/^oauth\./u),
    );
    expect((await coordinator.credential()).accessToken).toBe(ACCESS_TOKEN);
    expect((await store.load()).pendingAuthorization).toBeNull();
  });

  it("clears pending authorization if the browser cannot open", async () => {
    const store = new DesktopSecureStateStore(encryption, new MemoryFile());
    const coordinator = new DesktopSessionCoordinator({
      platformAppOrigin: "https://app.example.invalid",
      api: new DesktopApiClient("https://api.example.invalid"),
      store,
      browser: { openExternal: () => Promise.reject(new Error("synthetic")) },
      initializer: { initialize: () => Promise.resolve() },
      clock: () => new Date("2030-01-01T00:00:00.000Z"),
    });
    await expect(
      coordinator.handleLaunchUrl(
        `cosmaneura-capture://launch?launch_ticket=${LAUNCH_TICKET}`,
      ),
    ).rejects.toMatchObject({ code: "browser_unavailable" });
    expect((await store.load()).pendingAuthorization).toBeNull();
  });

  it("rejects a callback that does not match protected state", async () => {
    const coordinator = new DesktopSessionCoordinator({
      platformAppOrigin: "https://app.example.invalid",
      api: new DesktopApiClient("https://api.example.invalid"),
      store: new DesktopSecureStateStore(encryption, new MemoryFile()),
      browser: { openExternal: () => Promise.resolve() },
      initializer: { initialize: () => Promise.resolve() },
    });
    await expect(
      coordinator.handleAuthorizationCallback(
        `cosmaneura-capture://oauth/callback?code=${AUTH_CODE}&state=${"s".repeat(43)}`,
      ),
    ).rejects.toBeInstanceOf(DesktopSessionError);
  });
});
