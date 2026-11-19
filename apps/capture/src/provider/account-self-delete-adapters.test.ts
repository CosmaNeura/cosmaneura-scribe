import { describe, expect, it, vi } from "vitest";
import { interpretAccountSelfDeleteBridge } from "./account-self-delete";

/** Teardown through the real adapter shapes (native + desktop bridge interpret). */
describe("account self-delete adapters after abort", () => {
  it("native-shaped adapter returns Cosmas result even if aborted after DELETE", async () => {
    let release!: (value: Record<string, unknown>) => void;
    const nativeDelete = vi.fn(() => new Promise<Record<string, unknown>>(resolve => { release = resolve; }));
    const adapter = async (request: { confirm: "DELETE" }, signal?: AbortSignal) => {
      if (request.confirm !== "DELETE") throw new Error("account_self_delete_unconfirmed");
      if (signal?.aborted) throw new Error("account_self_delete_aborted");
      const value = await nativeDelete();
      return interpretAccountSelfDeleteBridge(value);
    };
    const abort = new AbortController();
    const pending = adapter({ confirm: "DELETE" }, abort.signal);
    await Promise.resolve();
    abort.abort();
    release({ status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true });
    expect(await pending).toEqual({
      outcome: "deleted", status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    });
  });

  it("desktop-shaped adapter returns Cosmas result when cancel arrives after DELETE", async () => {
    let release!: (value: { requestId: string; ok: true; result: Record<string, unknown> }) => void;
    let capturedId = "";
    const portRequest = vi.fn(() => {
      capturedId = crypto.randomUUID();
      return new Promise<{ requestId: string; ok: true; result: Record<string, unknown> }>(resolve => { release = resolve; });
    });
    const adapter = async (confirm: "DELETE") => {
      if (confirm !== "DELETE") throw new Error("unavailable");
      const reply = await portRequest();
      if (reply.requestId !== capturedId || reply.ok !== true) throw new Error("unavailable");
      return interpretAccountSelfDeleteBridge(reply.result);
    };
    const pending = adapter("DELETE");
    await Promise.resolve();
    release({
      requestId: capturedId, ok: true,
      result: { status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true },
    });
    expect(await pending).toMatchObject({ outcome: "deleted", status: "deleted" });
  });
});
