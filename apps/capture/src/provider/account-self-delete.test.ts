import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_SELF_DELETE_MESSAGES,
  accountSelfDelete,
  clearCachedProviderPreferences,
  interpretAccountSelfDeleteBridge,
  interpretAccountSelfDeleteResponse,
  type AccountSelfDeleteHost,
  type AccountSelfDeleteResult,
  type AccountSelfDeleteState,
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
  outcome: "deleted",
  status: "deleted",
  practiceLeftOwnerless: false,
  clerkIdentityRemoved: true,
};

function fixture(overrides: Partial<AccountSelfDeleteHost> = {}): {
  host: AccountSelfDeleteHost;
  states: AccountSelfDeleteState[];
  flow: ReturnType<typeof accountSelfDelete>;
  deleteAccount: ReturnType<typeof vi.fn>;
  clearLocalCredentials: ReturnType<typeof vi.fn>;
  closeWorkspace: ReturnType<typeof vi.fn>;
  sameAccountSession: ReturnType<typeof vi.fn>;
} {
  const states: AccountSelfDeleteState[] = [];
  const deleteAccount = vi.fn(async () => deleted);
  const clearLocalCredentials = vi.fn(async () => undefined);
  const closeWorkspace = vi.fn(async () => undefined);
  const sameAccountSession = vi.fn(() => true);
  const host: AccountSelfDeleteHost = {
    client: { deleteAccount },
    sameAccountSession,
    closeWorkspace,
    clearLocalCredentials,
    ...overrides,
  };
  const flow = accountSelfDelete(host, value => { states.push({ ...value }); });
  return { host, states, flow, deleteAccount, clearLocalCredentials, closeWorkspace, sameAccountSession };
}

describe("interpretAccountSelfDeleteResponse", () => {
  it("treats 200 deleted as success", () => {
    expect(interpretAccountSelfDeleteResponse(200, {
      status: "deleted", practice_left_ownerless: false, clerk_identity_removed: true,
    })).toEqual({
      outcome: "deleted", status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    });
  });

  it("treats 200 already_deleted as success", () => {
    expect(interpretAccountSelfDeleteResponse(200, {
      status: "already_deleted", practice_left_ownerless: true, clerk_identity_removed: true,
    })).toEqual({
      outcome: "deleted", status: "already_deleted", practiceLeftOwnerless: true, clerkIdentityRemoved: true,
    });
  });

  it("maps 401 to unauthorized so the app signs out with session-expired copy", () => {
    expect(interpretAccountSelfDeleteResponse(401, null)).toEqual({ outcome: "unauthorized" });
  });

  it("maps 410 to gone so the app signs out with access-ended copy", () => {
    expect(interpretAccountSelfDeleteResponse(410, null)).toEqual({ outcome: "gone" });
  });

  it("maps 404 to unavailable and keeps the session", () => {
    expect(interpretAccountSelfDeleteResponse(404, null)).toEqual({ outcome: "unavailable" });
  });

  it("maps 503 to retryable and keeps the session", () => {
    expect(interpretAccountSelfDeleteResponse(503, null)).toEqual({ outcome: "retryable" });
  });

  it("rejects 409 and 422 so the session stays signed in", () => {
    expect(() => interpretAccountSelfDeleteResponse(409, { detail: "conflict" }))
      .toThrow(/account_self_delete_http_409/);
    expect(() => interpretAccountSelfDeleteResponse(422, { detail: "confirm_required" }))
      .toThrow(/account_self_delete_http_422/);
  });

  it("rejects other HTTP statuses so the session stays signed in", () => {
    expect(() => interpretAccountSelfDeleteResponse(500, {})).toThrow(/account_self_delete_http_500/);
  });

  it("rejects a 200 body that is not the locked Cosmas shape", () => {
    expect(() => interpretAccountSelfDeleteResponse(200, { status: "deleted" }))
      .toThrow(/account_self_delete_body/);
  });
});

describe("interpretAccountSelfDeleteBridge", () => {
  it("accepts the locked native success payload", () => {
    expect(interpretAccountSelfDeleteBridge({
      status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    })).toEqual({
      outcome: "deleted", status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    });
  });

  it("maps flag payloads for 401/410/404/503", () => {
    expect(interpretAccountSelfDeleteBridge({ unauthorized: true })).toEqual({ outcome: "unauthorized" });
    expect(interpretAccountSelfDeleteBridge({ gone: true })).toEqual({ outcome: "gone" });
    expect(interpretAccountSelfDeleteBridge({ unavailable: true })).toEqual({ outcome: "unavailable" });
    expect(interpretAccountSelfDeleteBridge({ retryable: true })).toEqual({ outcome: "retryable" });
  });

  it("rejects mutated or extra bridge keys", () => {
    expect(() => interpretAccountSelfDeleteBridge({ unauthorized: true, status: "deleted" }))
      .toThrow(/account_self_delete_bridge/);
    expect(() => interpretAccountSelfDeleteBridge({
      status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true, extra: true,
    })).toThrow(/account_self_delete_bridge/);
  });
});

describe("accountSelfDelete", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("200 deleted signs out and clears local state after Cosmas delete", async () => {
    const { flow, deleteAccount, clearLocalCredentials, closeWorkspace } = fixture();
    flow.confirm("DELETE");
    await flow.submit();
    expect(deleteAccount).toHaveBeenCalledWith({ confirm: "DELETE" }, expect.any(AbortSignal));
    expect(closeWorkspace).toHaveBeenCalledOnce();
    expect(clearLocalCredentials).toHaveBeenCalledOnce();
    expect(deleteAccount.mock.invocationCallOrder[0]).toBeLessThan(closeWorkspace.mock.invocationCallOrder[0]!);
    expect(flow.read()).toMatchObject({ phase: "complete", completion: "deleted" });
  });

  it("200 already_deleted also signs out and clears local state", async () => {
    const deleteAccount = vi.fn(async (): Promise<AccountSelfDeleteResult> => ({
      outcome: "deleted",
      status: "already_deleted",
      practiceLeftOwnerless: true,
      clerkIdentityRemoved: true,
    }));
    const { flow, clearLocalCredentials } = fixture({ client: { deleteAccount } });
    flow.confirm("DELETE");
    await flow.submit();
    expect(clearLocalCredentials).toHaveBeenCalledOnce();
    expect(flow.read()).toMatchObject({ phase: "complete", completion: "deleted" });
  });

  it("401 signs out locally with session_expired completion, not deleted copy", async () => {
    const deleteAccount = vi.fn(async (): Promise<AccountSelfDeleteResult> => ({ outcome: "unauthorized" }));
    const { flow, clearLocalCredentials, closeWorkspace } = fixture({ client: { deleteAccount } });
    flow.confirm("DELETE");
    await flow.submit();
    expect(closeWorkspace).toHaveBeenCalledOnce();
    expect(clearLocalCredentials).toHaveBeenCalledOnce();
    expect(flow.read()).toMatchObject({ phase: "complete", completion: "session_expired" });
  });

  it("410 signs out locally with gone completion", async () => {
    const deleteAccount = vi.fn(async (): Promise<AccountSelfDeleteResult> => ({ outcome: "gone" }));
    const { flow, clearLocalCredentials } = fixture({ client: { deleteAccount } });
    flow.confirm("DELETE");
    await flow.submit();
    expect(clearLocalCredentials).toHaveBeenCalledOnce();
    expect(flow.read()).toMatchObject({ phase: "complete", completion: "gone" });
  });

  it("404 keeps the session and shows the unavailable message", async () => {
    const deleteAccount = vi.fn(async (): Promise<AccountSelfDeleteResult> => ({ outcome: "unavailable" }));
    const { flow, clearLocalCredentials, closeWorkspace } = fixture({ client: { deleteAccount } });
    flow.confirm("DELETE");
    await flow.submit();
    expect(closeWorkspace).not.toHaveBeenCalled();
    expect(clearLocalCredentials).not.toHaveBeenCalled();
    expect(flow.read()).toMatchObject({
      phase: "failed",
      confirmation: "DELETE",
      error: ACCOUNT_SELF_DELETE_MESSAGES.unavailable,
      retryable: false,
      completion: null,
    });
  });

  it("503 keeps the session and marks the failure retryable", async () => {
    const deleteAccount = vi.fn(async (): Promise<AccountSelfDeleteResult> => ({ outcome: "retryable" }));
    const { flow, clearLocalCredentials } = fixture({ client: { deleteAccount } });
    flow.confirm("DELETE");
    await flow.submit();
    expect(clearLocalCredentials).not.toHaveBeenCalled();
    expect(flow.read()).toMatchObject({
      phase: "failed",
      confirmation: "DELETE",
      error: ACCOUNT_SELF_DELETE_MESSAGES.retryable,
      retryable: true,
      completion: null,
    });
  });

  it("422 keeps the session and does not clear credentials", async () => {
    const deleteAccount = vi.fn(async () => {
      throw new Error("account_self_delete_http_422");
    });
    const { flow, clearLocalCredentials, closeWorkspace } = fixture({ client: { deleteAccount } });
    flow.confirm("DELETE");
    await flow.submit();
    expect(closeWorkspace).not.toHaveBeenCalled();
    expect(clearLocalCredentials).not.toHaveBeenCalled();
    expect(flow.read()).toMatchObject({
      phase: "failed",
      confirmation: "DELETE",
      error: expect.stringContaining("still signed in"),
    });
  });

  it("still attempts sign-out when workspace close fails after server delete", async () => {
    const closeWorkspace = vi.fn(async () => { throw new Error("close_failed"); });
    const { flow, clearLocalCredentials } = fixture({ closeWorkspace });
    flow.confirm("DELETE");
    await flow.submit();
    expect(clearLocalCredentials).toHaveBeenCalledOnce();
    expect(flow.read().phase).toBe("complete");
  });

  it("surfaces local_clear_failed with Done/acknowledge when sign-out fails after server delete", async () => {
    const clearLocalCredentials = vi.fn(async () => { throw new Error("sign_out_failed"); });
    const { flow } = fixture({ clearLocalCredentials });
    flow.confirm("DELETE");
    await flow.submit();
    expect(flow.read()).toMatchObject({
      phase: "local_clear_failed",
      completion: "local_clear_failed",
      error: ACCOUNT_SELF_DELETE_MESSAGES.localClearFailed,
    });
    expect(flow.acknowledge()).toBe(true);
    expect(flow.read().phase).toBe("closed");
  });

  it("cancel does nothing and never calls Cosmas", () => {
    const { flow, deleteAccount, clearLocalCredentials, closeWorkspace } = fixture();
    flow.confirm("DELETE");
    expect(flow.cancel()).toBe(true);
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(clearLocalCredentials).not.toHaveBeenCalled();
    expect(closeWorkspace).not.toHaveBeenCalled();
    expect(flow.read().phase).toBe("closed");
  });

  it("refuses submit without exact DELETE confirmation", async () => {
    const { flow, deleteAccount } = fixture();
    flow.confirm("delete");
    await flow.submit();
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(flow.read().phase).toBe("confirming");
  });

  it("stops before Cosmas when the signed-in session changes", async () => {
    const { flow, deleteAccount, clearLocalCredentials, sameAccountSession } = fixture();
    sameAccountSession.mockReturnValue(false);
    flow.confirm("DELETE");
    await flow.submit();
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(clearLocalCredentials).not.toHaveBeenCalled();
    expect(flow.read().phase).toBe("failed");
  });

  it("clearCachedProviderPreferences removes only preference keys", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem("scribe-preferences-v1:abc", "{\"language\":\"en-US\",\"modality\":\"in_person\",\"audio\":\"microphone\"}");
    storage.setItem("unrelated", "keep");
    clearCachedProviderPreferences();
    expect(storage.getItem("scribe-preferences-v1:abc")).toBeNull();
    expect(storage.getItem("unrelated")).toBe("keep");
  });
});
