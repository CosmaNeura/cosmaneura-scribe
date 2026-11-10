import { Capacitor } from "@capacitor/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountNativeProviderIOSApplication } from "./native-application";
import { mountProviderApplication } from "./application";
import { connectNativeProviderIOSBackend } from "./native-backend";
import { createProviderIOSHost } from "./ios-host";

vi.mock("./application", () => ({ mountProviderApplication: vi.fn(() => vi.fn()) }));
vi.mock("./native-backend", () => ({ connectNativeProviderIOSBackend: vi.fn() }));
vi.mock("./ios-host", () => ({ createProviderIOSHost: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("native patient-ready release", () => {
  it.each([
    "core-staging-personal-v1", "core-production-personal-v1", "core-production-organization-v1",
  ] as const)("uses the native flag after the old experiment expiry for %s", async profile => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-12-01T00:00:00Z"));
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    vi.spyOn(Capacitor, "getPlatform").mockReturnValue("ios");
    vi.spyOn(Capacitor, "isPluginAvailable").mockReturnValue(true);
    for (const enabled of [false, true]) {
      const backend = { patientReadyStartEnabled: enabled,
        listEncounters: vi.fn(async () => []), dispose: vi.fn(async () => undefined) };
      vi.mocked(connectNativeProviderIOSBackend).mockResolvedValue(
        backend as unknown as Awaited<ReturnType<typeof connectNativeProviderIOSBackend>>);
      mountNativeProviderIOSApplication({} as HTMLElement, { profile,
        uploadTarget: { putCompleteEnvelope: vi.fn() },
        core: { createEncounter: vi.fn(), openEncounter: vi.fn() } });
      const host = vi.mocked(mountProviderApplication).mock.calls.at(-1)![1];
      const connection = await host.connect(new AbortController().signal);
      expect(createProviderIOSHost).toHaveBeenLastCalledWith(backend, undefined, [], expect.any(Number), enabled);
      await connection.dispose();
      expect(backend.dispose).toHaveBeenCalledOnce();
    }
  });
});
