import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_SELF_DELETE_MESSAGES, accountSelfDelete, clearCachedProviderPreferences,
  interpretAccountSelfDeleteBridge, interpretAccountSelfDeleteResponse,
  type AccountSelfDeleteHost, type AccountSelfDeleteResult, type AccountSelfDeleteState,
} from "./account-self-delete";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; }, clear() { values.clear(); },
    getItem(key: string) { return values.has(key) ? values.get(key)! : null; },
    key(index: number) { return [...values.keys()][index] ?? null; },
    removeItem(key: string) { values.delete(key); },
    setItem(key: string, value: string) { values.set(key, String(value)); },
  };
}

const deleted: AccountSelfDeleteResult = {
  outcome: "deleted", status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true,
};

function fixture(overrides: Partial<AccountSelfDeleteHost> = {}) {
  const states: AccountSelfDeleteState[] = [];
  const deleteAccount = vi.fn(async () => deleted);
  const clearLocalCredentials = vi.fn(async () => undefined);
  const purgeLocalClinicalData = vi.fn(async () => undefined);
  const closeWorkspace = vi.fn(async () => undefined);
  const sameAccountSession = vi.fn(() => true);
  const host: AccountSelfDeleteHost = {
    client: { deleteAccount }, sameAccountSession, closeWorkspace, purgeLocalClinicalData,
    clearLocalCredentials, ...overrides,
  };
  const flow = accountSelfDelete(host, value => { states.push({ ...value }); });
  return { host, states, flow, deleteAccount, clearLocalCredentials, purgeLocalClinicalData, closeWorkspace, sameAccountSession };
}

describe("interpretAccountSelfDeleteResponse", () => {
  it("maps locked Cosmas statuses; rejects 409/422/500 and malformed-200", () => {
    expect(interpretAccountSelfDeleteResponse(200, {
      status: "deleted", practice_left_ownerless: false, clerk_identity_removed: true,
    })).toEqual({
      outcome: "deleted", status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    });
    expect(interpretAccountSelfDeleteResponse(200, {
      status: "already_deleted", practice_left_ownerless: true, clerk_identity_removed: true,
    })).toMatchObject({ outcome: "deleted", practiceLeftOwnerless: true });
    expect(interpretAccountSelfDeleteResponse(401, null)).toEqual({ outcome: "unauthorized" });
    expect(interpretAccountSelfDeleteResponse(410, null)).toEqual({ outcome: "gone" });
    expect(interpretAccountSelfDeleteResponse(404, null)).toEqual({ outcome: "unavailable" });
    expect(interpretAccountSelfDeleteResponse(503, null)).toEqual({ outcome: "retryable" });
    for (const status of [409, 422, 500]) {
      expect(() => interpretAccountSelfDeleteResponse(status, {})).toThrow(new RegExp(`account_self_delete_http_${status}`));
    }
    expect(() => interpretAccountSelfDeleteResponse(200, { status: "deleted" })).toThrow(/account_self_delete_body/);
  });
});

describe("interpretAccountSelfDeleteBridge", () => {
  it("accepts locked success and flag payloads; rejects mutation", () => {
    expect(interpretAccountSelfDeleteBridge({
      status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    })).toMatchObject({ outcome: "deleted" });
    expect(interpretAccountSelfDeleteBridge({ unauthorized: true })).toEqual({ outcome: "unauthorized" });
    expect(interpretAccountSelfDeleteBridge({ gone: true })).toEqual({ outcome: "gone" });
    expect(interpretAccountSelfDeleteBridge({ unavailable: true })).toEqual({ outcome: "unavailable" });
    expect(interpretAccountSelfDeleteBridge({ retryable: true })).toEqual({ outcome: "retryable" });
    expect(interpretAccountSelfDeleteBridge({ recordingActive: true })).toEqual({ outcome: "recording_active" });
    expect(() => interpretAccountSelfDeleteBridge({ unauthorized: true, status: "deleted" }))
      .toThrow(/account_self_delete_bridge/);
    expect(() => interpretAccountSelfDeleteBridge({
      status: "deleted", practiceLeftOwnerless: false,
    })).toThrow(/account_self_delete_bridge/);
  });
});

describe("accountSelfDelete", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("200 deleted purges then clears; keep-session paths and cancel do not purge", async () => {
    const ok = fixture();
    ok.flow.confirm("DELETE"); await ok.flow.submit();
    expect(ok.closeWorkspace).toHaveBeenCalledOnce();
    expect(ok.purgeLocalClinicalData).toHaveBeenCalledOnce();
    expect(ok.clearLocalCredentials).toHaveBeenCalledOnce();
    expect(ok.purgeLocalClinicalData.mock.invocationCallOrder[0]!)
      .toBeLessThan(ok.clearLocalCredentials.mock.invocationCallOrder[0]!);
    expect(ok.flow.read()).toMatchObject({ phase: "complete", completion: "deleted" });
    for (const result of [{ outcome: "unauthorized" }, { outcome: "gone" }] as const) {
      const f = fixture({ client: { deleteAccount: vi.fn(async () => result as AccountSelfDeleteResult) } });
      f.flow.confirm("DELETE"); await f.flow.submit();
      expect(f.purgeLocalClinicalData).not.toHaveBeenCalled();
      expect(f.clearLocalCredentials).toHaveBeenCalledOnce();
    }
    for (const result of [
      { outcome: "unavailable" }, { outcome: "retryable" }, { outcome: "recording_active" },
    ] as const) {
      const f = fixture({ client: { deleteAccount: vi.fn(async () => result as AccountSelfDeleteResult) } });
      f.flow.confirm("DELETE"); await f.flow.submit();
      expect(f.purgeLocalClinicalData).not.toHaveBeenCalled();
      expect(f.clearLocalCredentials).not.toHaveBeenCalled();
      expect(f.flow.read().phase).toBe("failed");
    }
    const thrown = fixture({
      client: { deleteAccount: vi.fn(async () => { throw new Error("account_self_delete_http_422"); }) },
    });
    thrown.flow.confirm("DELETE"); await thrown.flow.submit();
    expect(thrown.purgeLocalClinicalData).not.toHaveBeenCalled();
    expect(thrown.flow.read().error).toMatch(/still signed in/);
    const cancel = fixture();
    cancel.flow.confirm("DELETE");
    expect(cancel.flow.cancel()).toBe(true);
    expect(cancel.deleteAccount).not.toHaveBeenCalled();
  });

  it("survives dispose mid-DELETE; purge failure → local_clear_failed; ownerless + guards", async () => {
    let resolveDelete!: (value: AccountSelfDeleteResult) => void;
    const deleteAccount = vi.fn(() => new Promise<AccountSelfDeleteResult>(resolve => { resolveDelete = resolve; }));
    const mid = fixture({ client: { deleteAccount } });
    mid.flow.confirm("DELETE");
    const pending = mid.flow.submit();
    await Promise.resolve(); mid.flow.dispose(); resolveDelete(deleted); await pending;
    expect(mid.purgeLocalClinicalData).toHaveBeenCalledOnce();
    expect(mid.clearLocalCredentials).toHaveBeenCalledOnce();

    const purgeFail = fixture({ purgeLocalClinicalData: vi.fn(async () => { throw new Error("purge_failed"); }) });
    purgeFail.flow.confirm("DELETE"); await purgeFail.flow.submit();
    expect(purgeFail.clearLocalCredentials).toHaveBeenCalledOnce();
    expect(purgeFail.flow.read()).toMatchObject({ phase: "local_clear_failed", completion: "local_clear_failed" });

    const ownerless = fixture({
      client: { deleteAccount: vi.fn(async (): Promise<AccountSelfDeleteResult> => ({
        outcome: "deleted", status: "already_deleted", practiceLeftOwnerless: true, clerkIdentityRemoved: true,
      })) },
    });
    ownerless.flow.confirm("DELETE"); await ownerless.flow.submit();
    expect(ownerless.flow.read()).toMatchObject({ phase: "complete", practiceLeftOwnerless: true });
    const wrong = fixture();
    wrong.flow.confirm("delete"); await wrong.flow.submit();
    expect(wrong.deleteAccount).not.toHaveBeenCalled();
    const changed = fixture();
    changed.sameAccountSession.mockReturnValue(false);
    changed.flow.confirm("DELETE"); await changed.flow.submit();
    expect(changed.deleteAccount).not.toHaveBeenCalled();

    const closeFail = fixture({ closeWorkspace: vi.fn(async () => { throw new Error("close_failed"); }) });
    closeFail.flow.confirm("DELETE"); await closeFail.flow.submit();
    expect(closeFail.flow.read().phase).toBe("complete");
    const signOutFail = fixture({
      clearLocalCredentials: vi.fn(async () => { throw new Error("sign_out_failed"); }),
    });
    signOutFail.flow.confirm("DELETE"); await signOutFail.flow.submit();
    expect(signOutFail.flow.read()).toMatchObject({
      phase: "local_clear_failed", error: ACCOUNT_SELF_DELETE_MESSAGES.localClearFailed,
    });
    expect(signOutFail.flow.acknowledge()).toBe(true);
  });

  it("clearCachedProviderPreferences removes only preference keys", () => {
    const storage = memoryStorage(); vi.stubGlobal("localStorage", storage);
    storage.setItem("scribe-preferences-v1:abc", "{}"); storage.setItem("unrelated", "keep");
    clearCachedProviderPreferences();
    expect(storage.getItem("scribe-preferences-v1:abc")).toBeNull();
    expect(storage.getItem("unrelated")).toBe("keep");
  });
});
