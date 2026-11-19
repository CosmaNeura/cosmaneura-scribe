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
  it("forwards DELETE, purges only on deleted, maps flags, and surfaces purge failure", async () => {
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
    for (const flag of ["unauthorized", "gone", "unavailable", "retryable"] as const) {
      const row = await fixture("ready", vi.fn(async () => ({ [flag]: true as const })));
      try {
        expect(await row.send("delete_account", { confirm: "DELETE" })).toMatchObject({ ok: true, result: { [flag]: true } });
        expect(row.purgeLocalClinicalData).not.toHaveBeenCalled();
      } finally { await row.main.dispose(); }
    }
    const purgeLocalClinicalData = vi.fn(async () => { throw new Error("purge_failed"); });
    const purge = await fixture("ready", vi.fn(async () => ({
      status: "deleted" as const, practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    })), purgeLocalClinicalData);
    try {
      expect(await purge.send("delete_account", { confirm: "DELETE" })).toMatchObject({
        ok: true, result: { status: "deleted", clinicalPurgeFailed: true },
      });
    } finally { await purge.main.dispose(); }
    const missing = await fixture("ready", vi.fn(async () => ({ status: "deleted" as const, practiceLeftOwnerless: false })));
    try { expect(await missing.send("delete_account", { confirm: "DELETE" })).toMatchObject({ ok: false }); }
    finally { await missing.main.dispose(); }
    const scoped = await fixture("ready", vi.fn(async () => ({
      status: "deleted" as const, practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    })));
    try { expect(await scoped.send("delete_account", { confirm: "DELETE" }, crypto.randomUUID())).toMatchObject({ ok: false }); }
    finally { await scoped.main.dispose(); }
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

  it("refuses signed-out/missing delete; closes workspace only after session-ending delete", async () => {
    const signedOut = await fixture("signedOut", vi.fn(async () => ({ unauthorized: true as const })));
    try { expect(await signedOut.send("delete_account", { confirm: "DELETE" })).toMatchObject({ ok: false }); }
    finally { await signedOut.main.dispose(); }
    const missing = await fixture("ready");
    try { expect(await missing.send("delete_account", { confirm: "DELETE" })).toMatchObject({ ok: false }); }
    finally { await missing.main.dispose(); }
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

  it("refuses delete_account while a recorder is actively recording", async () => {
    const deleteAccount = vi.fn(async () => ({
      status: "deleted" as const, practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    }));
    const dispose = vi.fn(async () => undefined), stop = vi.fn(async () => undefined);
    const state: ProviderSessionState = { phase: "ready", revision: crypto.randomUUID() };
    const sessionId = "10000000-0000-4000-8000-000000000001";
    const scope = {
      workspaceId: "20000000-0000-4000-8000-000000000002",
      bindingRef: "scribe_capture_binding_01j00000000000000000000000",
      appointmentRef: "appointment_01j00000000000000000000000",
    };
    const saved = { revision: "1", progress: { sessionId, uploaded: false, pendingSave: null, admission: {
      key: sessionId, languageMode: "en-US+es-US", attestation: {
        modality: "virtual", participant_regions: ["US-NY"], method: "verbal_attestation",
        all_parties_consented: true, granted_at: new Date().toISOString(),
      },
    } } };
    const nativeRecord = {
      deactivate: stop, subscribe: () => () => undefined,
      snapshot: { sessionId, state: "recording", statusCode: "capture_recording",
        recordedChunks: 1, queuedChunks: 0, elapsedSeconds: 1, remainingBudgetSeconds: 0,
        remainingAuthoritySeconds: null, transcriptionStatus: null, transcript: null,
        desktop: { phase: "recording", coverage: "active", trimmedStartMs: 0, trimmedEndMs: null } },
    };
    const host = {
      connect: vi.fn(async (signal: AbortSignal) => ({
        dispose, workspace: {
          signal,
          listEncounters: async () => [{ appointmentRef: scope.appointmentRef, title: "S", detail: "V" }],
          openEncounter: async (_: string, encounterSignal: AbortSignal) => ({
            scope, signal: encounterSignal,
            encounter: { appointmentRef: scope.appointmentRef, title: "S", detail: "V" },
            request: async () => Response.json({}), openInCore: async () => undefined,
            journal: { load: async () => structuredClone(saved), save: async () => saved },
            reviewJournal: () => ({ load: async () => null, save: async () => undefined, clear: async () => undefined }),
            recorder: async () => nativeRecord,
          }),
          createEncounter: async () => undefined,
        },
      })),
      session: {
        getState: async () => state, signIn: async () => state, signOut: async () => state,
        addListener: async () => ({ remove: async () => undefined }), deleteAccount,
      },
    } as unknown as DesktopProviderMainHost;
    const main = new DesktopProviderWorkspaceMain(host, () => ({ dispose: stop }));
    await main.initialize();
    try {
      const connected = await main.request({
        method: "connect", payload: {}, requestId: crypto.randomUUID(), connectionId: null, encounterId: null,
      }) as { ok: boolean; result: { connectionId: string } };
      const opened = await main.request({
        method: "open", payload: { appointmentRef: scope.appointmentRef },
        requestId: crypto.randomUUID(), connectionId: connected.result.connectionId, encounterId: null,
      }) as { ok: boolean; result: { encounterId: string } };
      expect((await main.request({
        method: "recorder", payload: { sessionId }, requestId: crypto.randomUUID(),
        connectionId: connected.result.connectionId, encounterId: opened.result.encounterId,
      }) as { ok: boolean }).ok).toBe(true);
      expect(await main.request({
        method: "delete_account", payload: { confirm: "DELETE" },
        requestId: crypto.randomUUID(), connectionId: null, encounterId: null,
      })).toMatchObject({ ok: false });
      expect(deleteAccount).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
    } finally { await main.dispose(); }
  });
});
