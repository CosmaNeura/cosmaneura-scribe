import { describe, expect, it, vi } from "vitest";
import {
  clearWriteOwnerAfterBackendDispose,
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
    expect(nativeDelete).toHaveBeenCalledTimes(2);
  });

  it("undefined Core scope: clear message, no remember", async () => {
    const nativeDelete = vi.fn().mockRejectedValue(unavailable);
    const remember = vi.fn(async () => undefined);
    await expect(nativeAccountSelfDeleteWithRememberRetry({
      nativeDelete, remember, serverScope: async () => undefined, request: { confirm: "DELETE" },
    })).rejects.toThrow(/clinical_account_unavailable_after_remember/);
    expect(remember).not.toHaveBeenCalled();
    expect(nativeDelete).toHaveBeenCalledTimes(1);
  });
});

describe("clearWriteOwnerAfterBackendDispose", () => {
  it("clears owner after backend.dispose", async () => {
    const order: string[] = [];
    await clearWriteOwnerAfterBackendDispose(
      async () => { order.push("dispose"); },
      async () => { order.push("clear"); },
    );
    expect(order).toEqual(["dispose", "clear"]);
  });
});
