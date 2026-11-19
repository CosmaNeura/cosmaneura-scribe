import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_SELF_DELETE_MESSAGES, accountSelfDelete, clearCachedProviderPreferences,
  interpretAccountSelfDeleteBridge, interpretAccountSelfDeleteResponse,
  type AccountSelfDeleteHost, type AccountSelfDeleteResult, type AccountSelfDeleteState,
} from "./account-self-delete";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
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
  it("maps locked Cosmas statuses", () => {
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
  });
});

describe("accountSelfDelete", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("200 deleted purges clinical data then clears credentials", async () => {
    const { flow, deleteAccount, clearLocalCredentials, purgeLocalClinicalData, closeWorkspace } = fixture();
    flow.confirm("DELETE"); await flow.submit();
    expect(deleteAccount).toHaveBeenCalledWith({ confirm: "DELETE" }, expect.any(AbortSignal));
    expect(closeWorkspace).toHaveBeenCalledOnce();
    expect(purgeLocalClinicalData).toHaveBeenCalledOnce();
    expect(clearLocalCredentials).toHaveBeenCalledOnce();
    expect(purgeLocalClinicalData.mock.invocationCallOrder[0]!)
      .toBeLessThan(clearLocalCredentials.mock.invocationCallOrder[0]!);
    expect(flow.read()).toMatchObject({
      phase: "complete", completion: "deleted", practiceLeftOwnerless: false,
    });
  });

  it("surfaces practiceLeftOwnerless on already_deleted for ownerless notice copy", async () => {
    const deleteAccount = vi.fn(async (): Promise<AccountSelfDeleteResult> => ({
      outcome: "deleted", status: "already_deleted", practiceLeftOwnerless: true, clerkIdentityRemoved: true,
    }));
    const { flow, clearLocalCredentials } = fixture({ client: { deleteAccount } });
    flow.confirm("DELETE"); await flow.submit();
    expect(clearLocalCredentials).toHaveBeenCalledOnce();
    expect(flow.read()).toMatchObject({
      phase: "complete", completion: "deleted", practiceLeftOwnerless: true,
    });
  });

  it("locks John-approved delete confirm and ownerless notice copy", () => {
    expect(ACCOUNT_SELF_DELETE_MESSAGES.confirmBody).toBe(
      "This removes your Cosmaneura sign-in, including Cosmas web access, and deletes your personal Scribe data for this account on this device. Your practice record and clinical records kept with the practice are not deleted by this action.",
    );
    expect(ACCOUNT_SELF_DELETE_MESSAGES.practiceLeftOwnerlessNotice).toBe(
      "If you were the last owner of this practice, Cosmaneura may keep the practice record so billing and retention obligations can finish. Your sign-in is removed; the practice is not deleted by this action.",
    );
    expect(Object.values(ACCOUNT_SELF_DELETE_MESSAGES).join("\n")).not.toMatch(/permanently deletes/);
  });

  it("survives dispose during in-flight DELETE and still purges + clears", async () => {
    let resolveDelete!: (value: AccountSelfDeleteResult) => void;
    const deleteAccount = vi.fn(() => new Promise<AccountSelfDeleteResult>(resolve => { resolveDelete = resolve; }));
    const { flow, clearLocalCredentials, purgeLocalClinicalData } = fixture({ client: { deleteAccount } });
    flow.confirm("DELETE");
    const pending = flow.submit();
    await Promise.resolve();
    flow.dispose();
    resolveDelete(deleted);
    await pending;
    expect(purgeLocalClinicalData).toHaveBeenCalledOnce();
    expect(clearLocalCredentials).toHaveBeenCalledOnce();
    expect(flow.read()).toMatchObject({ phase: "complete", completion: "deleted" });
  });

  it("still signs out when clinical purge fails after server delete", async () => {
    const purgeLocalClinicalData = vi.fn(async () => { throw new Error("purge_failed"); });
    const { flow, clearLocalCredentials } = fixture({ purgeLocalClinicalData });
    flow.confirm("DELETE"); await flow.submit();
    expect(clearLocalCredentials).toHaveBeenCalledOnce();
    expect(flow.read()).toMatchObject({ phase: "local_clear_failed", completion: "local_clear_failed" });
  });

  it("401/410 clear locally; 404/503/recording_active/throw keep session", async () => {
    for (const [result, completion] of [
      [{ outcome: "unauthorized" }, "session_expired"],
      [{ outcome: "gone" }, "gone"],
    ] as const) {
      const { flow, clearLocalCredentials } = fixture({
        client: { deleteAccount: vi.fn(async () => result as AccountSelfDeleteResult) },
      });
      flow.confirm("DELETE"); await flow.submit();
      expect(clearLocalCredentials).toHaveBeenCalledOnce();
      expect(flow.read()).toMatchObject({ phase: "complete", completion });
    }
    for (const [result, error] of [
      [{ outcome: "unavailable" }, ACCOUNT_SELF_DELETE_MESSAGES.unavailable],
      [{ outcome: "retryable" }, ACCOUNT_SELF_DELETE_MESSAGES.retryable],
      [{ outcome: "recording_active" }, ACCOUNT_SELF_DELETE_MESSAGES.recordingActive],
    ] as const) {
      const { flow, clearLocalCredentials, closeWorkspace } = fixture({
        client: { deleteAccount: vi.fn(async () => result as AccountSelfDeleteResult) },
      });
      flow.confirm("DELETE"); await flow.submit();
      expect(closeWorkspace).not.toHaveBeenCalled();
      expect(clearLocalCredentials).not.toHaveBeenCalled();
      expect(flow.read()).toMatchObject({
        phase: "failed", confirmation: "DELETE", error,
        retryable: result.outcome === "retryable",
      });
    }
    const thrown = fixture({
      client: { deleteAccount: vi.fn(async () => { throw new Error("account_self_delete_http_422"); }) },
    });
    thrown.flow.confirm("DELETE"); await thrown.flow.submit();
    expect(thrown.clearLocalCredentials).not.toHaveBeenCalled();
    expect(thrown.flow.read().error).toMatch(/still signed in/);
  });

  it("clears after workspace-close failure; local_clear_failed when sign-out fails", async () => {
    const closeFail = fixture({ closeWorkspace: vi.fn(async () => { throw new Error("close_failed"); }) });
    closeFail.flow.confirm("DELETE"); await closeFail.flow.submit();
    expect(closeFail.clearLocalCredentials).toHaveBeenCalledOnce();
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

  it("cancel / wrong confirm / session change never call Cosmas", async () => {
    const cancel = fixture();
    cancel.flow.confirm("DELETE");
    expect(cancel.flow.cancel()).toBe(true);
    expect(cancel.deleteAccount).not.toHaveBeenCalled();
    const wrong = fixture();
    wrong.flow.confirm("delete"); await wrong.flow.submit();
    expect(wrong.deleteAccount).not.toHaveBeenCalled();
    const changed = fixture();
    changed.sameAccountSession.mockReturnValue(false);
    changed.flow.confirm("DELETE"); await changed.flow.submit();
    expect(changed.deleteAccount).not.toHaveBeenCalled();
    expect(changed.flow.read().phase).toBe("failed");
  });

  it("clearCachedProviderPreferences removes only preference keys", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem("scribe-preferences-v1:abc", "{}");
    storage.setItem("unrelated", "keep");
    clearCachedProviderPreferences();
    expect(storage.getItem("scribe-preferences-v1:abc")).toBeNull();
    expect(storage.getItem("unrelated")).toBe("keep");
  });
});
