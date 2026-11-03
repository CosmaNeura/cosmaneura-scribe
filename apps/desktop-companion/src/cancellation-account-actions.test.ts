import { describe, expect, it, vi } from "vitest";
import { DesktopProviderWorkspaceMain, type DesktopProviderMainHost } from "./provider-workspace-main.js";
import type { ProviderSessionState } from "../../capture/src/provider/native-plugin";

async function fixture(phase: ProviderSessionState["phase"] = "ready") {
  const state: ProviderSessionState = { phase, revision: crypto.randomUUID() };
  const openDashboard = vi.fn(async () => undefined), status = vi.fn(async () => null);
  const connect = vi.fn(async () => { throw new Error("No recording workspace should open"); });
  const host: DesktopProviderMainHost = { openDashboard, connect,
    cancellation: { status, load: vi.fn(), submit: vi.fn() },
    session: { getState: async () => state, signIn: async () => state, signOut: async () => state,
      addListener: async () => ({ remove: async () => undefined }) } };
  const main = new DesktopProviderWorkspaceMain(host, () => ({ dispose: async () => undefined }));
  await main.initialize();
  const send = (method: "open_dashboard" | "cancellation", payload: Record<string, unknown>, connectionId: string | null = null) => main.request({
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
