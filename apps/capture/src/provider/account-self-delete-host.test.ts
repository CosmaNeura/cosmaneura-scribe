import { describe, expect, it, vi } from "vitest";
import { nativeAccountSelfDeleteWithRememberRetry } from "./account-self-delete-host";

const scope = "11111111-1111-4111-8111-111111111111";
const unavailable = Object.assign(new Error("Clinical account unavailable"), {
  code: "clinical_account_unavailable",
});
const deleted = { status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true };

describe("nativeAccountSelfDeleteWithRememberRetry", () => {
  it("remembers server scope and retries once on clinical_account_unavailable", async () => {
    const nativeDelete = vi.fn().mockRejectedValueOnce(unavailable).mockResolvedValueOnce(deleted);
    const remember = vi.fn(async () => undefined);
    await expect(nativeAccountSelfDeleteWithRememberRetry({
      nativeDelete, remember, serverScope: () => scope, request: { confirm: "DELETE" },
    })).resolves.toMatchObject({ outcome: "deleted", status: "deleted" });
    expect(remember).toHaveBeenCalledWith(scope);
    expect(nativeDelete).toHaveBeenCalledTimes(2);
  });

  it("throws clinical_account_unavailable_after_remember when retry fails", async () => {
    const nativeDelete = vi.fn().mockRejectedValue(unavailable);
    await expect(nativeAccountSelfDeleteWithRememberRetry({
      nativeDelete, remember: async () => undefined, serverScope: () => scope,
      request: { confirm: "DELETE" },
    })).rejects.toThrow(/clinical_account_unavailable_after_remember/);
    expect(nativeDelete).toHaveBeenCalledTimes(2);
  });
});
