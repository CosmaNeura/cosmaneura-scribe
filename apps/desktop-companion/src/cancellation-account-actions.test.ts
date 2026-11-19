import { describe, expect, it, vi } from "vitest";
import { DesktopProviderWorkspaceMain, type DesktopProviderMainHost } from "./provider-workspace-main.js";
import type { ProviderSessionState } from "../../capture/src/provider/native-plugin";

async function fixture(phase: ProviderSessionState["phase"] = "ready",
  deleteAccount?: NonNullable<DesktopProviderMainHost["session"]["deleteAccount"]>,
  purgeLocalClinicalData = vi.fn(async () => undefined)) {
  const state: ProviderSessionState = { phase, revision: crypto.randomUUID() };
  const openDashboard = vi.fn(async () => undefined), status = vi.fn(async () => null);
  const connect = vi.fn(async () => { throw new Error("No recording workspace should open"); });
  const host: DesktopProviderMainHost = { openDashboard, connect, purgeLocalClinicalData,
    cancellation: { status, load: vi.fn(), submit: vi.fn() },
    session: { getState: async () => state, signIn: async () => state, signOut: async () => state,
      addListener: async () => ({ remove: async () => undefined }),
      ...(deleteAccount ? { deleteAccount } : {}) } };
  const main = new DesktopProviderWorkspaceMain(host, () => ({ dispose: async () => undefined }));
  await main.initialize();
  const send = (method: "open_dashboard" | "cancellation" | "delete_account", payload: Record<string, unknown>, connectionId: string | null = null) => main.request({
    method, payload, requestId: crypto.randomUUID(), connectionId, encounterId: null,
  });
  return { main, openDashboard, status, connect, purgeLocalClinicalData, send };
}

describe("fixed account-level desktop cancellation actions", () => {
  it("opens dashboard and status without a recording connection", async () => {
    const f = await fixture();
    try {
      expect(await f.send("open_dashboard", {})).toMatchObject({ ok: true });
      expect(f.openDashboard).toHaveBeenCalledOnce();
      expect(await f.send("cancellation", { action: "status" })).toMatchObject({ ok: true });
      expect(f.status).toHaveBeenCalledOnce();
    } finally { await f.main.dispose(); }
  });
  it("rejects untrusted dashboard requests and signed-out actions", async () => {
    const f = await fixture();
    try {
      expect(await f.send("open_dashboard", { url: "https://untrusted.synthetic.invalid" })).toMatchObject({ ok: false });
      expect(f.openDashboard).not.toHaveBeenCalled();
    } finally { await f.main.dispose(); }
    const out = await fixture("signedOut");
    try {
      expect(await out.send("open_dashboard", {})).toMatchObject({ ok: false });
      expect(await out.send("cancellation", { action: "status" })).toMatchObject({ ok: false });
    } finally { await out.main.dispose(); }
  });
});

describe("desktop account self-delete IPC", () => {
  it("forwards DELETE, purges only on deleted, and keeps locked success keys", async () => {
    const deleteAccount = vi.fn(async () => ({
      status: "deleted" as const, practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    }));
    const f = await fixture("ready", deleteAccount);
    try {
      expect(await f.send("delete_account", { confirm: "DELETE" })).toMatchObject({
        ok: true, result: { status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true },
      });
      expect(f.purgeLocalClinicalData).toHaveBeenCalledOnce();
      expect(await f.send("delete_account", { confirm: "delete" })).toMatchObject({ ok: false });
    } finally { await f.main.dispose(); }
  });

  it("401/410/404/503 never purge; purge throw still returns server result", async () => {
    for (const flag of ["unauthorized", "gone", "unavailable", "retryable"] as const) {
      const f = await fixture("ready", vi.fn(async () => ({ [flag]: true as const })));
      try {
        expect(await f.send("delete_account", { confirm: "DELETE" })).toMatchObject({ ok: true, result: { [flag]: true } });
        expect(f.purgeLocalClinicalData).not.toHaveBeenCalled();
      } finally { await f.main.dispose(); }
    }
    const purgeLocalClinicalData = vi.fn(async () => { throw new Error("purge_failed"); });
    const f = await fixture("ready", vi.fn(async () => ({
      status: "deleted" as const, practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    })), purgeLocalClinicalData);
    try {
      expect(await f.send("delete_account", { confirm: "DELETE" })).toMatchObject({
        ok: true, result: { status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true },
      });
      expect(purgeLocalClinicalData).toHaveBeenCalledOnce();
    } finally { await f.main.dispose(); }
  });

  it("returns deleted after abort once Cosmas DELETE has been sent", async () => {
    let release!: (value: { status: "deleted"; practiceLeftOwnerless: false; clerkIdentityRemoved: true }) => void;
    const value = { status: "deleted" as const, practiceLeftOwnerless: false as const, clerkIdentityRemoved: true as const };
    const deleteAccount = vi.fn(() => new Promise<typeof value>(resolve => { release = resolve; }));
    const f = await fixture("ready", deleteAccount);
    try {
      const requestId = crypto.randomUUID();
      const pending = f.main.request({
        method: "delete_account", payload: { confirm: "DELETE" }, requestId, connectionId: null, encounterId: null,
      });
      await vi.waitFor(() => { expect(deleteAccount).toHaveBeenCalledOnce(); });
      expect(await f.main.request({
        method: "cancel", payload: { requestId }, requestId: crypto.randomUUID(), connectionId: null, encounterId: null,
      })).toMatchObject({ ok: true });
      release(value);
      expect(await pending).toMatchObject({ ok: true, result: value });
      expect(f.purgeLocalClinicalData).toHaveBeenCalledOnce();
    } finally { await f.main.dispose(); }
  });

  it("refuses delete while signed out or without native delete", async () => {
    const signedOut = await fixture("signedOut", vi.fn(async () => ({ unauthorized: true as const })));
    try { expect(await signedOut.send("delete_account", { confirm: "DELETE" })).toMatchObject({ ok: false }); }
    finally { await signedOut.main.dispose(); }
    const missing = await fixture("ready");
    try { expect(await missing.send("delete_account", { confirm: "DELETE" })).toMatchObject({ ok: false }); }
    finally { await missing.main.dispose(); }
  });

  it("closes workspace only after session-ending delete; keep-session leaves it open", async () => {
    const dispose = vi.fn(async () => undefined);
    const state: ProviderSessionState = { phase: "ready", revision: crypto.randomUUID() };
    const hostFor = (deleteAccount: NonNullable<DesktopProviderMainHost["session"]["deleteAccount"]>): DesktopProviderMainHost => ({
      connect: vi.fn(async signal => ({
        dispose, workspace: {
          signal, listEncounters: async () => [], openEncounter: async () => { throw new Error("no"); },
          createEncounter: async () => undefined,
        },
      })),
      session: {
        getState: async () => state, signIn: async () => state, signOut: async () => state,
        addListener: async () => ({ remove: async () => undefined }), deleteAccount,
      },
    });
    const keep = new DesktopProviderWorkspaceMain(hostFor(vi.fn(async () => ({ unavailable: true as const }))), () => ({ dispose: async () => undefined }));
    await keep.initialize();
    try {
      const connected = await keep.request({
        method: "connect", payload: {}, requestId: crypto.randomUUID(), connectionId: null, encounterId: null,
      }) as { ok: boolean; result: { connectionId: string } };
      expect(connected.ok).toBe(true);
      expect(await keep.request({
        method: "delete_account", payload: { confirm: "DELETE" }, requestId: crypto.randomUUID(), connectionId: null, encounterId: null,
      })).toMatchObject({ ok: true, result: { unavailable: true } });
      expect(dispose).not.toHaveBeenCalled();
      expect(await keep.request({
        method: "list", payload: {}, requestId: crypto.randomUUID(),
        connectionId: connected.result.connectionId, encounterId: null,
      })).toMatchObject({ ok: true });
    } finally { await keep.dispose(); }
    dispose.mockClear();
    const end = new DesktopProviderWorkspaceMain(hostFor(vi.fn(async () => ({
      status: "deleted" as const, practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    }))), () => ({ dispose: async () => undefined }));
    await end.initialize();
    try {
      expect((await end.request({
        method: "connect", payload: {}, requestId: crypto.randomUUID(), connectionId: null, encounterId: null,
      }) as { ok: boolean }).ok).toBe(true);
      expect(await end.request({
        method: "delete_account", payload: { confirm: "DELETE" }, requestId: crypto.randomUUID(), connectionId: null, encounterId: null,
      })).toMatchObject({ ok: true, result: { status: "deleted" } });
      expect(dispose).toHaveBeenCalledOnce();
    } finally { await end.dispose(); }
  });

});
