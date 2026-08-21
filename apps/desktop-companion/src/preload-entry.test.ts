import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { ELECTRON_IPC_CHANNELS } from "./electron-ipc.js";
import type { ElectronRendererApi } from "./electron-ipc.js";

describe("packaged preload entry", () => {
  it("exposes only the fixed bridge and invokes only fixed channels", async () => {
    const source = await readFile(
      new URL("../static/preload.cjs", import.meta.url),
      "utf8",
    );
    const invocations: Array<{ channel: string; payload: unknown }> = [];
    const exposed: {
      name: string | null;
      api: ElectronRendererApi | null;
    } = { name: null, api: null };
    const ipcRenderer = {
      invoke(channel: string, payload: unknown): Promise<unknown> {
        invocations.push({ channel, payload });
        if (channel === ELECTRON_IPC_CHANNELS.getState) {
          return Promise.resolve({
            schemaVersion: 1,
            requestId: Reflect.get(payload as object, "requestId"),
            state: "stopped",
            captureSessionId: null,
            reasonCode: null,
          });
        }
        return Promise.resolve({
          schemaVersion: 1,
          requestId: Reflect.get(payload as object, "requestId"),
          ok: false,
          errorCode: "feature_disabled",
        });
      },
      on: () => undefined,
      removeListener: () => undefined,
    };
    const contextBridge = {
      exposeInMainWorld(name: string, api: ElectronRendererApi): void {
        exposed.name = name;
        exposed.api = api;
      },
    };

    runInNewContext(source, {
      TextEncoder,
      crypto: { randomUUID: () => "request-synthetic-preload" },
      require: (name: string): unknown => {
        if (name !== "electron") {
          throw new Error("Unexpected preload module request");
        }
        return { contextBridge, ipcRenderer };
      },
    });

    expect(exposed.name).toBe("cosmasDesktop");
    if (exposed.api === null) {
      throw new Error("Synthetic preload did not expose its API");
    }
    expect(Object.keys(exposed.api).sort()).toEqual([
      "getState",
      "onStateChanged",
      "refreshPermissions",
      "start",
      "stop",
    ]);
    await exposed.api.getState();
    await exposed.api.start();
    expect(invocations.map(({ channel }) => channel)).toEqual([
      ELECTRON_IPC_CHANNELS.getState,
      ELECTRON_IPC_CHANNELS.start,
    ]);
    expect(JSON.stringify(invocations)).not.toContain("token");
    expect(source).not.toContain("shell");
    expect(source).not.toContain("send(");
  });
});
