import { describe, expect, it, vi } from "vitest";
import { desktopAccountSelfDeleteAdapter, nativeAccountSelfDeleteAdapter } from "./account-self-delete-host";
import type { DesktopProviderRequest } from "./desktop-host-protocol";

describe("account self-delete real adapters", () => {
  it("native adapter returns Cosmas result even if aborted after DELETE", async () => {
    let release!: (value: Record<string, unknown>) => void;
    const nativeDelete = vi.fn(() => new Promise<Record<string, unknown>>(resolve => { release = resolve; }));
    const abort = new AbortController();
    const pending = nativeAccountSelfDeleteAdapter(nativeDelete, { confirm: "DELETE" }, abort.signal);
    await Promise.resolve(); abort.abort();
    release({ status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true });
    expect(await pending).toEqual({
      outcome: "deleted", status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    });
  });

  it("native refuses pre-flight abort and missing clerkIdentityRemoved; desktop strips clinicalPurgeFailed", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(nativeAccountSelfDeleteAdapter(vi.fn(), { confirm: "DELETE" }, abort.signal))
      .rejects.toThrow(/account_self_delete_aborted/);
    await expect(nativeAccountSelfDeleteAdapter(
      vi.fn(async () => ({ status: "deleted", practiceLeftOwnerless: false })), { confirm: "DELETE" },
    )).rejects.toThrow(/account_self_delete_bridge/);

    let release!: (value: { requestId: string; ok: true; result: Record<string, unknown> }) => void;
    let capturedId = "";
    const portRequest = vi.fn(async (request: DesktopProviderRequest) => {
      capturedId = request.requestId;
      return new Promise(resolve => { release = resolve; });
    });
    const pending = desktopAccountSelfDeleteAdapter(portRequest, { confirm: "DELETE" }, { closed: () => false });
    await Promise.resolve();
    release({
      requestId: capturedId, ok: true,
      result: { status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true },
    });
    expect(await pending).toMatchObject({ outcome: "deleted", status: "deleted" });
    const onClinicalPurgeFailed = vi.fn();
    expect(await desktopAccountSelfDeleteAdapter(
      async request => ({
        requestId: request.requestId, ok: true as const,
        result: {
          status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true,
          clinicalPurgeFailed: true,
        },
      }),
      { confirm: "DELETE" }, { closed: () => false, onClinicalPurgeFailed },
    )).toMatchObject({ outcome: "deleted" });
    expect(onClinicalPurgeFailed).toHaveBeenCalledOnce();
  });
});
