import { describe, expect, it, vi } from "vitest";
import { DesktopProviderWorkspaceMain, type DesktopProviderMainHost } from "./provider-workspace-main.js";
import type { ProviderSessionState } from "../../capture/src/provider/native-plugin";

async function fixture(phase: ProviderSessionState["phase"] = "ready",
  deleteAccount?: NonNullable<DesktopProviderMainHost["session"]["deleteAccount"]>) {
  const state: ProviderSessionState = { phase, revision: crypto.randomUUID() };
  const openDashboard = vi.fn(async () => undefined), status = vi.fn(async () => null);
  const connect = vi.fn(async () => { throw new Error("No recording workspace should open"); });
  const host: DesktopProviderMainHost = { openDashboard, connect,
    cancellation: { status, load: vi.fn(), submit: vi.fn() },
    session: { getState: async () => state, signIn: async () => state, signOut: async () => state,
      addListener: async () => ({ remove: async () => undefined }),
      ...(deleteAccount ? { deleteAccount } : {}) } };
  const main = new DesktopProviderWorkspaceMain(host, () => ({ dispose: async () => undefined }));
  await main.initialize();
  const send = (method: "open_dashboard" | "cancellation" | "delete_account", payload: Record<string, unknown>, connectionId: string | null = null) => main.request({
    method, payload, requestId: crypto.randomUUID(), connectionId, encounterId: null,
  });
  return { main, openDashboard, status, connect, send };
}
describe("fixed account-level desktop cancellation actions", () => {
  it("opens the trusted account dashboard and reads own status without any recording connection", async () => {
    const f = await fixture();
    try {
      expect(await f.send("open_dashboard", {})).toMatchObject({ ok: true, result: null });
      expect(f.openDashboard).toHaveBeenCalledOnce(); expect(f.connect).not.toHaveBeenCalled();
      expect(await f.send("cancellation", { action: "status" })).toMatchObject({ ok: true, result: null });
      expect(f.status).toHaveBeenCalledOnce();
    } finally { await f.main.dispose(); }
  });
  it("rejects a renderer URL or visit-scoped account dashboard request", async () => {
    const f = await fixture();
    try {
      expect(await f.send("open_dashboard", { url: "https://untrusted.synthetic.invalid" })).toMatchObject({ ok: false });
      expect(await f.send("open_dashboard", {}, crypto.randomUUID())).toMatchObject({ ok: false });
      expect(f.openDashboard).not.toHaveBeenCalled();
    } finally { await f.main.dispose(); }
  });
  it("does not open the account dashboard or query cancellation while signed out", async () => {
    const f = await fixture("signedOut");
    try {
      expect(await f.send("open_dashboard", {})).toMatchObject({ ok: false });
      expect(await f.send("cancellation", { action: "status" })).toMatchObject({ ok: false });
      expect(f.openDashboard).not.toHaveBeenCalled(); expect(f.status).not.toHaveBeenCalled();
    } finally { await f.main.dispose(); }
  });
});

describe("desktop account self-delete IPC", () => {
  it("forwards DELETE confirm to native session for the signed-in caller only", async () => {
    const deleteAccount = vi.fn(async () => ({
      status: "deleted" as const, practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    }));
    const f = await fixture("ready", deleteAccount);
    try {
      expect(await f.send("delete_account", { confirm: "DELETE" })).toMatchObject({
        ok: true,
        result: { status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true },
      });
      expect(deleteAccount).toHaveBeenCalledWith({ confirm: "DELETE" });
      expect(f.connect).not.toHaveBeenCalled();
      expect(await f.send("delete_account", { confirm: "delete" })).toMatchObject({ ok: false });
      expect(await f.send("delete_account", { confirm: "DELETE" }, crypto.randomUUID())).toMatchObject({ ok: false });
    } finally { await f.main.dispose(); }
  });
  it("forwards unauthorized/gone/unavailable/retryable bridge flags without mutation", async () => {
    for (const flag of ["unauthorized", "gone", "unavailable", "retryable"] as const) {
      const deleteAccount = vi.fn(async () => ({ [flag]: true as const }));
      const f = await fixture("ready", deleteAccount);
      try {
        expect(await f.send("delete_account", { confirm: "DELETE" })).toMatchObject({
          ok: true,
          result: { [flag]: true },
        });
        expect(deleteAccount).toHaveBeenCalledOnce();
      } finally { await f.main.dispose(); }
    }
  });
  it("rejects a mutated native success payload missing clerkIdentityRemoved", async () => {
    const deleteAccount = vi.fn(async () => ({
      status: "deleted" as const, practiceLeftOwnerless: false,
    }));
    const f = await fixture("ready", deleteAccount as never);
    try {
      expect(await f.send("delete_account", { confirm: "DELETE" })).toMatchObject({ ok: false });
    } finally { await f.main.dispose(); }
  });
  it("refuses delete_account while signed out or when native delete is unavailable", async () => {
    const signedOut = await fixture("signedOut", vi.fn(async () => ({ unauthorized: true as const })));
    try {
      expect(await signedOut.send("delete_account", { confirm: "DELETE" })).toMatchObject({ ok: false });
    } finally { await signedOut.main.dispose(); }
    const missing = await fixture("ready");
    try {
      expect(await missing.send("delete_account", { confirm: "DELETE" })).toMatchObject({ ok: false });
    } finally { await missing.main.dispose(); }
  });
});
