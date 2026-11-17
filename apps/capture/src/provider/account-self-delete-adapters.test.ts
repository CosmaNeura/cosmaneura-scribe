import { describe, expect, it, vi } from "vitest";
import { interpretAccountSelfDeleteBridge } from "./account-self-delete";

/** Renderer/desktop adapter contract: bridge payloads must stay exact. */
describe("account self-delete renderer adapters", () => {
  it("maps locked IPC success and flag payloads the desktop host forwards", () => {
    expect(interpretAccountSelfDeleteBridge({
      status: "already_deleted", practiceLeftOwnerless: true, clerkIdentityRemoved: true,
    })).toMatchObject({ outcome: "deleted", status: "already_deleted" });
    expect(interpretAccountSelfDeleteBridge({ unauthorized: true })).toEqual({ outcome: "unauthorized" });
    expect(interpretAccountSelfDeleteBridge({ gone: true })).toEqual({ outcome: "gone" });
    expect(interpretAccountSelfDeleteBridge({ unavailable: true })).toEqual({ outcome: "unavailable" });
    expect(interpretAccountSelfDeleteBridge({ retryable: true })).toEqual({ outcome: "retryable" });
  });

  it("catches mutated bridge payloads before the Account UI treats them as success", () => {
    expect(() => interpretAccountSelfDeleteBridge({
      status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true, leaked: "x",
    })).toThrow(/account_self_delete_bridge/);
    expect(() => interpretAccountSelfDeleteBridge({
      unauthorized: true, practiceLeftOwnerless: false,
    })).toThrow(/account_self_delete_bridge/);
  });

  it("native iOS adapter path uses the same bridge interpreter", async () => {
    const native = {
      deleteAccount: vi.fn(async () => ({ gone: true as const })),
    };
    const value = await native.deleteAccount({ confirm: "DELETE" as const });
    expect(interpretAccountSelfDeleteBridge(value)).toEqual({ outcome: "gone" });
  });
});
