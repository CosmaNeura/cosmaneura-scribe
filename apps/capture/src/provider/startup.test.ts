import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { mountProviderStartup } from "./startup";

type Configuration = Parameters<typeof mountProviderStartup>[1]["configuration"];
const production = { enabled: true, coreOrigin: "https://app.cosmaneura.com",
  uploadOrigins: ["https://syntheticfixture.blob.core.windows.net"] };

describe("sealed native startup profile", () => {
  it.each(["core-production-organization-v1", "core-production-personal-v1"] as const)(
    "mounts %s only from the production native configuration", async profile => {
      const root = { classList: { add: vi.fn() }, setAttribute: vi.fn(),
        addEventListener: vi.fn(), removeEventListener: vi.fn(), innerHTML: "" };
      const release = vi.fn(async () => {});
      const mount = vi.fn(() => release);
      const close = mountProviderStartup(root as unknown as HTMLElement, {
        configuration: async () => ({ ...production, profile }), application: async () => ({ mount }),
      });
      await setImmediate();
      expect(mount).toHaveBeenCalledOnce();
      await close();
      expect(release).toHaveBeenCalledOnce();
    });

  it.each([
    { ...production, profile: "core-production-personal-v1", coreOrigin: "https://staging-app.cosmaneura.com" },
    { ...production, profile: "core-production-personal-v1", enabled: false },
    { ...production, profile: "unapproved-production-profile" },
    { ...production, profile: undefined },
  ])("does not mount unbound or disabled production inputs", async configuration => {
    const root = { classList: { add: vi.fn() }, setAttribute: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), innerHTML: "" };
    const mount = vi.fn(() => async () => {});
    const close = mountProviderStartup(root as unknown as HTMLElement, {
      configuration: (async () => configuration) as Configuration, application: async () => ({ mount }),
    });
    await setImmediate();
    expect(mount).not.toHaveBeenCalled();
    await close();
  });
});
