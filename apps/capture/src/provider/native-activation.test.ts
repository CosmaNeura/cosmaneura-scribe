import { afterEach, describe, expect, it, vi } from "vitest";
import { activateNativeScribe } from "./native-activation";
import { ProviderSetupRequired } from "./account-setup";
import type { NativeProviderSession, ProviderNativePlugin } from "./native-plugin";

afterEach(() => vi.useRealTimers());
function fixture(fault?: string) {
  const revision = crypto.randomUUID(); let reads = 0;
  const getState = vi.fn(async () => ({ phase: "ready", revision: fault === "rebound" && ++reads > 1 ? crypto.randomUUID() : revision }));
  const cancelProviderRequest = vi.fn(async () => undefined);
  const providerRequest = vi.fn(async (request: Parameters<ProviderNativePlugin["providerRequest"]>[0]) => {
    expect(request.action).toBe("activation");
    const body = JSON.parse(request.body) as { action: string; request_nonce: string };
    expect(Object.keys(body).sort()).toEqual(["action", "request_nonce"]);
    if (fault === "hold") return new Promise<Awaited<ReturnType<ProviderNativePlugin["providerRequest"]>>>(() => undefined);
    const value: Record<string, unknown> = fault === "practice"
      ? { type: "scribe_account_setup_required", status: 409, setup: "practice", request_nonce: body.request_nonce, revision }
      : { contract_version: "1", action: "activate", state: "active", request_nonce: body.request_nonce, revision };
    if (fault === "nonce") value.request_nonce = crypto.randomUUID();
    if (fault === "extra") value.tenant_ref = "forbidden";
    return { requestId: request.requestId, revision, status: fault === "practice" ? 409 : fault === "denied" ? 403 : 200, body: JSON.stringify(value) };
  });
  const native = { getState, providerRequest, cancelProviderRequest } as unknown as ProviderNativePlugin & NativeProviderSession;
  return { native, revision, providerRequest, cancelProviderRequest };
}
describe("closed native activation", () => {
  it("uses the fixed native action and accepts only a matching current-account response", async () => {
    const f = fixture(); await activateNativeScribe(f.native, new AbortController().signal, f.revision);
    expect(f.providerRequest).toHaveBeenCalledOnce();
  });
  it.each(["nonce", "extra", "rebound", "denied"])("rejects %s without granting workspace access", async fault => {
    const f = fixture(fault); await expect(activateNativeScribe(f.native, new AbortController().signal, f.revision)).rejects.toThrow();
  });
  it("preserves only a closed practice setup response", async () => {
    const f = fixture("practice"); await expect(activateNativeScribe(f.native, new AbortController().signal, f.revision)).rejects.toBeInstanceOf(ProviderSetupRequired);
  });
  it("cancels an unanswered native operation on abort without waiting for its reply", async () => {
    const f = fixture("hold"), abort = new AbortController();
    const pending = activateNativeScribe(f.native, abort.signal, f.revision);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const rejected = expect(pending).rejects.toThrow(); abort.abort(); await rejected;
    expect(f.cancelProviderRequest).toHaveBeenCalledOnce();
  });
});
