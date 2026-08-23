import { describe, expect, it } from "vitest";

import {
  createDesktopBrowserHandoff,
  DESKTOP_REDIRECT_URI,
  DesktopBrowserHandoffError,
  parseDesktopAuthorizationCallback,
  parseDesktopLaunchUrl,
  validateDesktopAuthorizationCallback,
} from "./browser-handoff.js";

const FIRST_SECRET = "A".repeat(43);
const SECOND_SECRET = "B".repeat(43);
const INSTALLATION_SECRET = "C".repeat(43);
const LAUNCH_TICKET = "D".repeat(43);

describe("desktop browser handoff", () => {
  it("creates a fragment-only PKCE handoff without exposing the verifier", () => {
    const secrets = [FIRST_SECRET, SECOND_SECRET];
    const handoff = createDesktopBrowserHandoff(
      LAUNCH_TICKET,
      INSTALLATION_SECRET,
      "https://app.example.invalid",
      new Date("2030-01-01T00:00:00.000Z"),
      () => secrets.shift() ?? "",
    );
    const url = new URL(handoff.connectUrl);

    expect(url.origin + url.pathname).toBe(
      "https://app.example.invalid/desktop-capture/connect",
    );
    expect(url.search).toBe("");
    expect(url.hash).not.toContain(FIRST_SECRET);
    expect(url.hash).toContain(`launch_ticket=${LAUNCH_TICKET}`);
    expect(url.hash).toContain(`state=${SECOND_SECRET}`);
    expect(handoff.pending).toEqual({
      schemaVersion: 1,
      state: SECOND_SECRET,
      codeVerifier: FIRST_SECRET,
      redirectUri: DESKTOP_REDIRECT_URI,
      createdAt: "2030-01-01T00:00:00.000Z",
    });
  });

  it("accepts only the exact launch and callback URLs", () => {
    expect(
      parseDesktopLaunchUrl(
        `cosmaneura-capture://launch?launch_ticket=${LAUNCH_TICKET}`,
      ),
    ).toBe(LAUNCH_TICKET);
    expect(
      parseDesktopAuthorizationCallback(
        `cosmaneura-capture://oauth/callback?code=${FIRST_SECRET}&state=${SECOND_SECRET}`,
      ),
    ).toEqual({ code: FIRST_SECRET, state: SECOND_SECRET });

    for (const value of [
      `https://launch/?launch_ticket=${LAUNCH_TICKET}`,
      `cosmaneura-capture://launch?launch_ticket=${LAUNCH_TICKET}&extra=1`,
      `cosmaneura-capture://oauth/callback?code=${FIRST_SECRET}&state=${SECOND_SECRET}#leak`,
    ]) {
      expect(() => parseDesktopLaunchUrl(value)).toThrow(
        DesktopBrowserHandoffError,
      );
    }
  });

  it("rejects mismatched, expired, and future callbacks", () => {
    const pending = createDesktopBrowserHandoff(
      LAUNCH_TICKET,
      INSTALLATION_SECRET,
      "https://app.example.invalid",
      new Date("2030-01-01T00:00:00.000Z"),
      (() => {
        const values = [FIRST_SECRET, SECOND_SECRET];
        return () => values.shift() ?? "";
      })(),
    ).pending;

    expect(() =>
      validateDesktopAuthorizationCallback(
        { code: FIRST_SECRET, state: SECOND_SECRET },
        pending,
        new Date("2030-01-01T00:02:59.000Z"),
      ),
    ).not.toThrow();
    expect(() =>
      validateDesktopAuthorizationCallback(
        { code: FIRST_SECRET, state: "E".repeat(43) },
        pending,
        new Date("2030-01-01T00:01:00.000Z"),
      ),
    ).toThrow(DesktopBrowserHandoffError);
    expect(() =>
      validateDesktopAuthorizationCallback(
        { code: FIRST_SECRET, state: SECOND_SECRET },
        pending,
        new Date("2030-01-01T00:03:01.000Z"),
      ),
    ).toThrow(DesktopBrowserHandoffError);
    expect(() =>
      validateDesktopAuthorizationCallback(
        { code: FIRST_SECRET, state: SECOND_SECRET },
        pending,
        new Date("2029-12-31T23:59:59.000Z"),
      ),
    ).toThrow(DesktopBrowserHandoffError);
  });
});
