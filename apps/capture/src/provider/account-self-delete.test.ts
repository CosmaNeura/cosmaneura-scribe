import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountSelfDelete,
  clearCachedProviderPreferences,
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

  it("maps 401 to unauthorized so the app signs out locally", () => {
    expect(interpretAccountSelfDeleteResponse(401, null)).toEqual({ outcome: "unauthorized" });
  });

  it("rejects 422 so the session stays signed in", () => {
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
    expect(flow.read().phase).toBe("complete");
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
    expect(flow.read().phase).toBe("complete");
  });

  it("401 signs out locally because the session is already invalid", async () => {
    const deleteAccount = vi.fn(async (): Promise<AccountSelfDeleteResult> => ({ outcome: "unauthorized" }));
    const { flow, clearLocalCredentials, closeWorkspace } = fixture({ client: { deleteAccount } });
    flow.confirm("DELETE");
    await flow.submit();
    expect(closeWorkspace).toHaveBeenCalledOnce();
    expect(clearLocalCredentials).toHaveBeenCalledOnce();
    expect(flow.read().phase).toBe("complete");
  });

  it("422 keeps the session and does not clear credentials", async () => {
    const deleteAccount = vi.fn(async () => {
      expect(() => interpretAccountSelfDeleteResponse(422, { detail: "confirm_required" }))
        .toThrow(/account_self_delete_http_422/);
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

  it("other Cosmas failures keep the session signed in", async () => {
    const deleteAccount = vi.fn(async () => {
      expect(() => interpretAccountSelfDeleteResponse(503, null)).toThrow(/account_self_delete_http_503/);
      throw new Error("account_self_delete_http_503");
    });
    const { flow, clearLocalCredentials } = fixture({ client: { deleteAccount } });
    flow.confirm("DELETE");
    await flow.submit();
    expect(clearLocalCredentials).not.toHaveBeenCalled();
    expect(flow.read().phase).toBe("failed");
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
