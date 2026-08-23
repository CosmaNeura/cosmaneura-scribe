import { describe, expect, it, vi } from "vitest";

import {
  DesktopDeepLinkError,
  DesktopDeepLinkIngress,
  DesktopDeepLinkRouter,
  extractDesktopDeepLinkFromCommandLine,
  parseDesktopDeepLink,
  registerDesktopProtocolClient,
} from "./electron-deep-link.js";

const LAUNCH =
  `cosmaneura-capture://launch?launch_ticket=${"l".repeat(43)}`;
const CALLBACK =
  `cosmaneura-capture://oauth/callback?code=${"c".repeat(43)}&state=${"s".repeat(43)}`;

describe("Electron desktop deep links", () => {
  it("classifies only the two exact secret-bearing URL shapes", () => {
    expect(parseDesktopDeepLink(LAUNCH)).toEqual({ kind: "launch", url: LAUNCH });
    expect(parseDesktopDeepLink(CALLBACK)).toEqual({
      kind: "authorization_callback",
      url: CALLBACK,
    });
    for (const value of [
      "https://example.invalid/",
      "cosmaneura-capture://launch",
      `${LAUNCH}&extra=value`,
      `${CALLBACK}#fragment`,
      `cosmaneura-capture://oauth/callback?code=${"c".repeat(43)}`,
    ]) {
      expect(() => parseDesktopDeepLink(value)).toThrow(DesktopDeepLinkError);
    }
  });

  it("extracts one exact protocol argument and rejects ambiguity", () => {
    expect(extractDesktopDeepLinkFromCommandLine(["app.exe", "--flag", LAUNCH])).toEqual({
      kind: "launch",
      url: LAUNCH,
    });
    expect(extractDesktopDeepLinkFromCommandLine(["app.exe", "--flag"])).toBeNull();
    expect(() =>
      extractDesktopDeepLinkFromCommandLine(["app.exe", LAUNCH, CALLBACK]),
    ).toThrow(DesktopDeepLinkError);
  });

  it("registers packaged and absolute-path development clients without URL arguments", () => {
    const setAsDefaultProtocolClient = vi.fn(() => true);
    const application = { setAsDefaultProtocolClient };
    expect(
      registerDesktopProtocolClient(application, {
        isPackaged: true,
        isDefaultApp: false,
        executablePath: "/ignored/electron",
        entryScriptPath: "/ignored/main.js",
      }),
    ).toBe(true);
    expect(setAsDefaultProtocolClient).toHaveBeenLastCalledWith(
      "cosmaneura-capture",
    );

    expect(
      registerDesktopProtocolClient(application, {
        isPackaged: false,
        isDefaultApp: true,
        executablePath: "/synthetic/electron",
        entryScriptPath: "/synthetic/dist/main-entry.js",
      }),
    ).toBe(true);
    expect(setAsDefaultProtocolClient).toHaveBeenLastCalledWith(
      "cosmaneura-capture",
      "/synthetic/electron",
      ["/synthetic/dist/main-entry.js"],
    );
    expect(
      registerDesktopProtocolClient(application, {
        isPackaged: false,
        isDefaultApp: true,
        executablePath: "relative/electron",
        entryScriptPath: "/synthetic/main.js",
      }),
    ).toBe(false);
  });

  it("queues one pre-ready URL, ignores invalid input, and serializes routing", async () => {
    const calls: string[] = [];
    const router = new DesktopDeepLinkRouter({
      enabled: true,
      activateWindow: () => calls.push("activate"),
      session: {
        handleLaunchUrl: async (url) => {
          calls.push(`launch:${url}`);
        },
        handleAuthorizationCallback: async (url) => {
          calls.push(`callback:${url}`);
        },
      },
    });
    const ingress = new DesktopDeepLinkIngress();
    expect(ingress.acceptUrl("https://example.invalid/")).toBe(false);
    expect(ingress.acceptCommandLine(["app.exe", LAUNCH])).toBe(true);
    expect(ingress.acceptUrl(CALLBACK)).toBe(true);
    ingress.connect(router);
    ingress.acceptCommandLine(["app.exe", CALLBACK]);
    await ingress.settled();
    expect(calls).toEqual([
      "activate",
      `launch:${LAUNCH}`,
      "activate",
      `callback:${CALLBACK}`,
    ]);
  });

  it("validates and activates but performs no session work while disabled", async () => {
    const session = {
      handleLaunchUrl: vi.fn(() => Promise.resolve()),
      handleAuthorizationCallback: vi.fn(() => Promise.resolve()),
    };
    const activateWindow = vi.fn();
    const router = new DesktopDeepLinkRouter({
      session,
      enabled: false,
      activateWindow,
    });
    await expect(router.route(LAUNCH)).resolves.toBe("feature_disabled");
    expect(activateWindow).toHaveBeenCalledOnce();
    expect(session.handleLaunchUrl).not.toHaveBeenCalled();
    expect(session.handleAuthorizationCallback).not.toHaveBeenCalled();
  });
});
