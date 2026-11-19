import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountSelfDelete, clearCachedProviderPreferences,
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
    expect(interpretAccountSelfDeleteResponse(401, null)).toEqual({ outcome: "unauthorized" });
    expect(interpretAccountSelfDeleteResponse(410, null)).toEqual({ outcome: "gone" });
    expect(interpretAccountSelfDeleteResponse(404, null)).toEqual({ outcome: "unavailable" });
    expect(interpretAccountSelfDeleteResponse(503, null)).toEqual({ outcome: "retryable" });
  });
});

describe("interpretAccountSelfDeleteBridge", () => {
  it("accepts locked success and flag payloads", () => {
    expect(interpretAccountSelfDeleteBridge({
      status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    })).toMatchObject({ outcome: "deleted" });
    expect(interpretAccountSelfDeleteBridge({ unauthorized: true })).toEqual({ outcome: "unauthorized" });
    expect(interpretAccountSelfDeleteBridge({ recordingActive: true })).toEqual({ outcome: "recording_active" });
  });
});

describe("accountSelfDelete", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("200 deleted purges then clears; 401/410/404/503/throw/cancel do not purge", async () => {
    const ok = fixture();
    ok.flow.confirm("DELETE"); await ok.flow.submit();
    expect(ok.purgeLocalClinicalData).toHaveBeenCalledOnce();
    expect(ok.clearLocalCredentials).toHaveBeenCalledOnce();
    expect(ok.flow.read()).toMatchObject({ phase: "complete", completion: "deleted" });

    for (const result of [
      { outcome: "unauthorized" }, { outcome: "gone" },
    ] as const) {
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
    expect(thrown.clearLocalCredentials).not.toHaveBeenCalled();

    const cancel = fixture();
    cancel.flow.confirm("DELETE");
    expect(cancel.flow.cancel()).toBe(true);
    expect(cancel.purgeLocalClinicalData).not.toHaveBeenCalled();
    expect(cancel.deleteAccount).not.toHaveBeenCalled();
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
  });

  it("purge failure after server delete still clears credentials to local_clear_failed", async () => {
    const purgeLocalClinicalData = vi.fn(async () => { throw new Error("purge_failed"); });
    const { flow, clearLocalCredentials } = fixture({ purgeLocalClinicalData });
    flow.confirm("DELETE"); await flow.submit();
    expect(clearLocalCredentials).toHaveBeenCalledOnce();
    expect(flow.read()).toMatchObject({ phase: "local_clear_failed", completion: "local_clear_failed" });
  });

  it("handles practiceLeftOwnerless; wrong confirm never calls Cosmas", async () => {
    const deleteAccount = vi.fn(async (): Promise<AccountSelfDeleteResult> => ({
      outcome: "deleted", status: "already_deleted", practiceLeftOwnerless: true, clerkIdentityRemoved: true,
    }));
    const { flow } = fixture({ client: { deleteAccount } });
    flow.confirm("DELETE"); await flow.submit();
    expect(flow.read()).toMatchObject({ phase: "complete", practiceLeftOwnerless: true });
    const wrong = fixture();
    wrong.flow.confirm("delete"); await wrong.flow.submit();
    expect(wrong.deleteAccount).not.toHaveBeenCalled();
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
