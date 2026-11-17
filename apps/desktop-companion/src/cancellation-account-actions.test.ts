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
    const f = await fixture("ready", deleteAccount);
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
  it("does not close an open workspace before a keep-session delete response", async () => {
    const deleteAccount = vi.fn(async () => ({ unavailable: true as const }));
    const dispose = vi.fn(async () => undefined);
    const events: { kind: string }[] = [];
    const state: ProviderSessionState = { phase: "ready", revision: crypto.randomUUID() };
    const host: DesktopProviderMainHost = {
      openDashboard: vi.fn(async () => undefined),
      connect: vi.fn(async signal => ({
        dispose,
        workspace: {
          signal,
          listEncounters: async () => [],
          openEncounter: async () => { throw new Error("no encounter"); },
          createEncounter: async () => undefined,
        },
      })),
      cancellation: { status: vi.fn(async () => null), load: vi.fn(), submit: vi.fn() },
      session: {
        getState: async () => state,
        signIn: async () => state,
        signOut: async () => state,
        addListener: async () => ({ remove: async () => undefined }),
        deleteAccount,
      },
    };
    const main = new DesktopProviderWorkspaceMain(host, () => ({ dispose: async () => undefined }));
    main.subscribe(event => events.push(event));
    await main.initialize();
    try {
      const connected = await main.request({
        method: "connect", payload: {}, requestId: crypto.randomUUID(),
        connectionId: null, encounterId: null,
      }) as { ok: boolean; result: { connectionId: string } };
      expect(connected.ok).toBe(true);
      events.length = 0;
      expect(await main.request({
        method: "delete_account", payload: { confirm: "DELETE" },
        requestId: crypto.randomUUID(), connectionId: null, encounterId: null,
      })).toMatchObject({ ok: true, result: { unavailable: true } });
      expect(deleteAccount).toHaveBeenCalledOnce();
      expect(dispose).not.toHaveBeenCalled();
      expect(events.some(event => event.kind === "connection_closed")).toBe(false);
      // Connection remains usable after keep-session failure.
      expect(await main.request({
        method: "list", payload: {}, requestId: crypto.randomUUID(),
        connectionId: connected.result.connectionId, encounterId: null,
      })).toMatchObject({ ok: true });
    } finally { await main.dispose(); }
  });
  it("refuses delete_account while a recorder is attached and leaves the connection open", async () => {
    const deleteAccount = vi.fn(async () => ({
      status: "deleted" as const, practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    }));
    const dispose = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const events: { kind: string }[] = [];
    const state: ProviderSessionState = { phase: "ready", revision: crypto.randomUUID() };
    const sessionId = "10000000-0000-4000-8000-000000000001";
    const workspaceId = "20000000-0000-4000-8000-000000000002";
    const scope = {
      workspaceId, bindingRef: "scribe_capture_binding_01j00000000000000000000000",
      appointmentRef: "appointment_01j00000000000000000000000",
    };
    const progress = {
      sessionId, uploaded: false, pendingSave: null,
      admission: {
        key: sessionId, languageMode: "en-US+es-US",
        attestation: {
          modality: "virtual", participant_regions: ["US-NY"], method: "verbal_attestation",
          all_parties_consented: true, granted_at: new Date().toISOString(),
        },
      },
    };
    const saved = { revision: "1", progress: structuredClone(progress) };
    const nativeRecord = {
      deactivate: stop,
      snapshot: {
        sessionId, state: "recording", statusCode: "capture_recording",
        recordedChunks: 1, queuedChunks: 0, elapsedSeconds: 1, remainingBudgetSeconds: 0,
        remainingAuthoritySeconds: null, transcriptionStatus: null, transcript: null,
        desktop: { phase: "recording", coverage: "active", trimmedStartMs: 0, trimmedEndMs: null },
      },
      subscribe: () => () => undefined,
    };
    const host: DesktopProviderMainHost = {
      connect: vi.fn(async signal => ({
        dispose,
        workspace: {
          signal,
          listEncounters: async () => [{
            appointmentRef: scope.appointmentRef, title: "Synthetic", detail: "Visit",
          }],
          openEncounter: async (_ref: string, encounterSignal: AbortSignal) => ({
            scope, signal: encounterSignal,
            encounter: { appointmentRef: scope.appointmentRef, title: "Synthetic", detail: "Visit" },
            request: async () => Response.json({}),
            openInCore: async () => undefined,
            journal: {
              load: async () => structuredClone(saved),
              save: async () => saved,
            },
            reviewJournal: () => ({
              load: async () => null, save: async () => undefined, clear: async () => undefined,
            }),
            recorder: async () => nativeRecord,
          }),
          createEncounter: async () => undefined,
        },
      })),
      session: {
        getState: async () => state,
        signIn: async () => state,
        signOut: async () => state,
        addListener: async () => ({ remove: async () => undefined }),
        deleteAccount,
      },
    };
    const main = new DesktopProviderWorkspaceMain(host, () => ({ dispose: stop }));
    main.subscribe(event => events.push(event));
    await main.initialize();
    try {
      const connected = await main.request({
        method: "connect", payload: {}, requestId: crypto.randomUUID(),
        connectionId: null, encounterId: null,
      }) as { ok: boolean; result: { connectionId: string } };
      expect(connected.ok).toBe(true);
      const opened = await main.request({
        method: "open", payload: { appointmentRef: scope.appointmentRef },
        requestId: crypto.randomUUID(),
        connectionId: connected.result.connectionId, encounterId: null,
      }) as { ok: boolean; result: { encounterId: string } };
      expect(opened.ok).toBe(true);
      expect((await main.request({
        method: "recorder", payload: { sessionId },
        requestId: crypto.randomUUID(),
        connectionId: connected.result.connectionId,
        encounterId: opened.result.encounterId,
      }) as { ok: boolean }).ok).toBe(true);
      events.length = 0;
      expect(await main.request({
        method: "delete_account", payload: { confirm: "DELETE" },
        requestId: crypto.randomUUID(), connectionId: null, encounterId: null,
      })).toMatchObject({ ok: false });
      expect(deleteAccount).not.toHaveBeenCalled();
      expect(events.some(event => event.kind === "connection_closed")).toBe(false);
      expect(dispose).not.toHaveBeenCalled();
    } finally { await main.dispose(); }
  });
  it("closes the workspace only after a session-ending delete response", async () => {
    const deleteAccount = vi.fn(async () => ({
      status: "deleted" as const, practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    }));
    const dispose = vi.fn(async () => undefined);
    const events: { kind: string }[] = [];
    const state: ProviderSessionState = { phase: "ready", revision: crypto.randomUUID() };
    const host: DesktopProviderMainHost = {
      connect: vi.fn(async signal => ({
        dispose,
        workspace: {
          signal,
          listEncounters: async () => [],
          openEncounter: async () => { throw new Error("no encounter"); },
          createEncounter: async () => undefined,
        },
      })),
      session: {
        getState: async () => state,
        signIn: async () => state,
        signOut: async () => state,
        addListener: async () => ({ remove: async () => undefined }),
        deleteAccount,
      },
    };
    const main = new DesktopProviderWorkspaceMain(host, () => ({ dispose: async () => undefined }));
    main.subscribe(event => events.push(event));
    await main.initialize();
    try {
      expect((await main.request({
        method: "connect", payload: {}, requestId: crypto.randomUUID(),
        connectionId: null, encounterId: null,
      }) as { ok: boolean }).ok).toBe(true);
      events.length = 0;
      expect(await main.request({
        method: "delete_account", payload: { confirm: "DELETE" },
        requestId: crypto.randomUUID(), connectionId: null, encounterId: null,
      })).toMatchObject({ ok: true, result: { status: "deleted" } });
      expect(events.some(event => event.kind === "connection_closed")).toBe(true);
      expect(dispose).toHaveBeenCalledOnce();
    } finally { await main.dispose(); }
  });
});
