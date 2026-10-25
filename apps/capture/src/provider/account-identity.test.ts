import { describe, expect, it } from "vitest";
import { parseDesktopProviderEvent, sessionState } from "./desktop-host-protocol";

describe("desktop account correlation metadata", () => {
  const base = { phase: "ready", revision: crypto.randomUUID() };
  const digest = "3a6f489add536606a2e34c4bda54eeb612a5450a41249a92e62eaa923d762d56";

  it("preserves a ready digest across normal session replies and events without copying raw identity", () => {
    const input = { ...base, accountIdentitySHA256: digest, identity: { userId: "user_offline", sessionId: "sess_offline" } };
    expect(sessionState(input)).toEqual({ ...base, accountIdentitySHA256: digest });
    expect(parseDesktopProviderEvent({ kind: "session", state: input })).toEqual({ kind: "session", state: { ...base, accountIdentitySHA256: digest } });
  });

  it("keeps old helpers compatible and withholds malformed metadata", () => {
    expect(sessionState(base)).toEqual(base);
    for (const accountIdentitySHA256 of [null, false, "", "user_offline", digest.toUpperCase(), "a".repeat(63), "a".repeat(65)]) {
      expect(sessionState({ ...base, accountIdentitySHA256 })).toEqual(base);
    }
    expect(() => sessionState({ ...base, revision: "invalid", accountIdentitySHA256: digest })).toThrow();
  });

  it.each(["signedOut", "signingIn", "signOutPending", "disabled", "loading", "unavailable"])("never exposes an account digest in %s", phase => {
    expect(sessionState({ ...base, phase, accountIdentitySHA256: digest })).toEqual({ ...base, phase });
  });
});
