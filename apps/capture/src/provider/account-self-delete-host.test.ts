import { describe, expect, it, vi } from "vitest";
import {
  CLINICAL_RECOVERY_SCOPE_UNAVAILABLE,
  clearWriteOwnerAfterBackendDispose,
  createAccountSelfDeleteScopeGate,
  createDeleteAwareServerScopeRefresh,
  nativeAccountSelfDeleteWithRememberRetry,
} from "./account-self-delete-host";

const scope = "11111111-1111-4111-8111-111111111111";
const unavailable = Object.assign(new Error("Clinical account unavailable"), {
  code: "clinical_account_unavailable",
});
const deleted = { status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true };

describe("nativeAccountSelfDeleteWithRememberRetry", () => {
  it("remembers delete-time Core scope and retries once", async () => {
    const nativeDelete = vi.fn().mockRejectedValueOnce(unavailable).mockResolvedValueOnce(deleted);
    const remember = vi.fn(async () => undefined);
    const serverScope = vi.fn(async () => scope);
    await expect(nativeAccountSelfDeleteWithRememberRetry({
      nativeDelete, remember, serverScope, request: { confirm: "DELETE" },
    })).resolves.toMatchObject({ outcome: "deleted", status: "deleted" });
    expect(serverScope).toHaveBeenCalledOnce();
    expect(remember).toHaveBeenCalledWith(scope);
    expect(remember).toHaveBeenCalledTimes(1);
    expect(nativeDelete).toHaveBeenCalledTimes(2);
  });

  it("throws clinical_account_unavailable_after_remember when retry fails", async () => {
    const nativeDelete = vi.fn().mockRejectedValue(unavailable);
    const remember = vi.fn(async () => undefined);
    await expect(nativeAccountSelfDeleteWithRememberRetry({
      nativeDelete, remember, serverScope: async () => scope, request: { confirm: "DELETE" },
    })).rejects.toThrow(/clinical_account_unavailable_after_remember/);
    expect(remember).toHaveBeenCalledWith(scope);
    expect(remember).toHaveBeenCalledTimes(1);
    expect(nativeDelete).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "", "not-a-uuid"])(
    "missing/invalid Core scope (%j): distinct code, no remember",
    async recoveryScope => {
      const nativeDelete = vi.fn().mockRejectedValue(unavailable);
      const remember = vi.fn(async () => undefined);
      await expect(nativeAccountSelfDeleteWithRememberRetry({
        nativeDelete, remember, serverScope: async () => recoveryScope, request: { confirm: "DELETE" },
      })).rejects.toThrow(CLINICAL_RECOVERY_SCOPE_UNAVAILABLE);
      expect(remember).not.toHaveBeenCalled();
      expect(nativeDelete).toHaveBeenCalledTimes(1);
    },
  );

  // Parser drops null/"" recoveryScope at native-backend.ts ~240 (catalog recoveryScope %j ok=%s).
  it("null-like serverScope uses distinct code (parser already refuses null recoveryScope)", async () => {
    const nativeDelete = vi.fn().mockRejectedValue(unavailable);
    const remember = vi.fn(async () => undefined);
    await expect(nativeAccountSelfDeleteWithRememberRetry({
      nativeDelete, remember,
      serverScope: async () => null as unknown as string | undefined,
      request: { confirm: "DELETE" },
    })).rejects.toThrow(CLINICAL_RECOVERY_SCOPE_UNAVAILABLE);
    expect(remember).not.toHaveBeenCalled();
  });
});

describe("delete-aware refreshServerScope", () => {
  it("returns undefined while delete is in flight or confirmed; refreshes when open", async () => {
    const gate = createAccountSelfDeleteScopeGate();
    const refresh = vi.fn(async () => scope);
    const serverScope = createDeleteAwareServerScopeRefresh({ refresh, deleteActive: () => gate.active() });
    await expect(serverScope()).resolves.toBe(scope);
    expect(refresh).toHaveBeenCalledOnce();
    gate.begin("a".repeat(64));
    await expect(serverScope()).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledOnce();
    gate.clear();
    await expect(serverScope()).resolves.toBe(scope);
    gate.begin("a".repeat(64));
    gate.confirm();
    expect(gate.confirmed()).toBe(true);
    expect(gate.deletedIdentity()).toBe("a".repeat(64));
    await expect(serverScope()).resolves.toBeUndefined();
    gate.clear();
    await expect(serverScope()).resolves.toBeUndefined();
    gate.reset();
    await expect(serverScope()).resolves.toBe(scope);
  });

  it("confirmed identity survives confirm; reset clears it for a new identity", () => {
    const gate = createAccountSelfDeleteScopeGate();
    const deleted = "b".repeat(64);
    gate.begin(deleted);
    gate.confirm();
    expect(gate.confirmed()).toBe(true);
    expect(gate.deletedIdentity()).toBe(deleted);
    gate.begin("c".repeat(64));
    expect(gate.confirmed()).toBe(true);
    expect(gate.deletedIdentity()).toBe(deleted);
    gate.reset();
    expect(gate.confirmed()).toBe(false);
    expect(gate.active()).toBe(false);
    expect(gate.deletedIdentity()).toBeUndefined();
  });
});

describe("clearWriteOwnerAfterBackendDispose", () => {
  it("clearOwner waits until dispose resolves", async () => {
    let resolveDispose!: () => void;
    const dispose = new Promise<void>(resolve => { resolveDispose = resolve; });
    const clearOwner = vi.fn(async () => undefined);
    const done = clearWriteOwnerAfterBackendDispose(async () => dispose, clearOwner);
    await Promise.resolve();
    expect(clearOwner).not.toHaveBeenCalled();
    resolveDispose();
    await done;
    expect(clearOwner).toHaveBeenCalledOnce();
  });

  it("dispose reject: clearOwner never called, rejection propagates", async () => {
    const clearOwner = vi.fn(async () => undefined);
    await expect(clearWriteOwnerAfterBackendDispose(
      async () => { throw new Error("dispose_failed"); },
      clearOwner,
    )).rejects.toThrow("dispose_failed");
    expect(clearOwner).not.toHaveBeenCalled();
  });
});
