import { describe, expect, it, vi } from "vitest";

import { DesktopApiClient } from "./desktop-api.js";
import { DesktopLifecycleCoordinator } from "./desktop-lifecycle.js";
import {
  DesktopSecureStateStore,
  type ElectronSafeStoragePort,
  type EncryptedStateFilePort,
} from "./secure-state-store.js";

const ACCESS_TOKEN = "t".repeat(43);
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
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => Buffer.from(value).toString("utf8"),
};

async function sessionStore(): Promise<DesktopSecureStateStore> {
  const store = new DesktopSecureStateStore(encryption, new MemoryFile());
  await store.update((state) => ({
    ...state,
    sessionCredential: {
      accessToken: ACCESS_TOKEN,
      expiresAt: "2030-01-01T00:05:00.000Z",
      grant,
    },
  }));
  return store;
}

describe("desktop lifecycle coordination", () => {
  it("durably records stop before sending and reuses the same key after an outage", async () => {
    let available = false;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() =>
      available
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                schemaVersion: 1,
                decision: "accepted",
                sessionStatus: "stopping",
              }),
              { status: 200 },
            ),
          )
        : Promise.reject(new Error("synthetic outage")),
    );
    const store = await sessionStore();
    const lifecycle = new DesktopLifecycleCoordinator({
      api: new DesktopApiClient("https://api.example.invalid", {
        fetch: fetchMock,
        clock: () => new Date("2030-01-01T00:01:00.000Z"),
      }),
      store,
      clock: () => new Date("2030-01-01T00:01:00.000Z"),
      idempotencyKey: () => "stop.synthetic-request-001",
    });

    await lifecycle.recordStopIntent("capability-synthetic-001");
    expect((await store.load()).pendingStopReceipts).toHaveLength(1);
    available = true;
    await expect(
      lifecycle.flushPendingStops(new AbortController().signal),
    ).resolves.toBe(1);
    expect((await store.load()).pendingStopReceipts).toHaveLength(0);
    const keys = fetchMock.mock.calls.map(
      ([, options]) =>
        (options?.headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(keys).toEqual([
      "stop.synthetic-request-001",
      "stop.synthetic-request-001",
    ]);
  });

  it("sends a heartbeat with the protected session and no renderer input", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          decision: "accepted",
          sessionStatus: "recording",
        }),
        { status: 200 },
      ),
    );
    const lifecycle = new DesktopLifecycleCoordinator({
      api: new DesktopApiClient("https://api.example.invalid", {
        fetch: fetchMock,
        clock: () => new Date("2030-01-01T00:01:00.000Z"),
      }),
      store: await sessionStore(),
      idempotencyKey: () => "heartbeat.synthetic-request-001",
    });
    await lifecycle.heartbeat(
      "capability-synthetic-002",
      new AbortController().signal,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ capabilityId: "capability-synthetic-002" }),
    );
  });
});
