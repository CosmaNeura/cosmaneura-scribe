import { describe, expect, it, vi } from "vitest";
import { BETA_CONSENT_PREPARATION } from "./beta-consent-preparation";
import { consentPreparationEnabled } from "./consent-preparation";
import { createDesktopProviderApplicationHost } from "./desktop-application";
import type { DesktopProviderPort } from "./desktop-host-protocol";

describe("signed beta preparation control", () => {
  it("expires automatically and cannot be changed by a mounted workspace", () => {
    expect(Object.isFrozen(BETA_CONSENT_PREPARATION)).toBe(true);
    expect(consentPreparationEnabled(BETA_CONSENT_PREPARATION, Date.parse("2026-10-17T00:00:00Z"))).toBe(true);
    expect(consentPreparationEnabled(BETA_CONSENT_PREPARATION, Date.parse("2026-11-01T00:00:00Z"))).toBe(false);
  });

  it.each([undefined, BETA_CONSENT_PREPARATION])("desktop forwards only the selected control without preparing or recording", async release => {
    const revision = crypto.randomUUID(), connectionId = crypto.randomUUID();
    const request = vi.fn<DesktopProviderPort["request"]>(async value => ({ requestId: value.requestId, ok: true,
      result: value.method === "session_read" ? { phase: "ready", revision }
        : value.method === "connect" ? { connectionId, revision } : null }));
    const record = vi.fn(async () => { throw new Error("Synthetic recorder must remain idle"); });
    const application = createDesktopProviderApplicationHost({ request, subscribe: () => () => undefined },
      { request: record, subscribe: () => () => undefined }, release);
    try {
      await application.host.session.getState();
      const connection = await application.host.connect(new AbortController().signal);
      expect(connection.workspace.consentPreparation).toBe(release);
      expect(request.mock.calls.map(([row]) => row.method)).toEqual(["session_read", "connect"]);
      expect(record).not.toHaveBeenCalled();
    } finally { await application.dispose(); }
  });
});
