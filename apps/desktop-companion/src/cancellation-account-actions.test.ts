import { describe, expect, it, vi } from "vitest";
import { DesktopProviderWorkspaceMain, type DesktopProviderMainHost } from "./provider-workspace-main.js";
import type { ProviderSessionState } from "../../capture/src/provider/native-plugin";

type DeleteFn = NonNullable<DesktopProviderMainHost["session"]["deleteAccount"]>;
const sessionOf = (state: ProviderSessionState, deleteAccount?: DeleteFn) => ({
  getState: async () => state, signIn: async () => state, signOut: async () => state,
  addListener: async () => ({ remove: async () => undefined }),
  ...(deleteAccount ? { deleteAccount } : {}),
});
async function fixture(phase: ProviderSessionState["phase"] = "ready",
  deleteAccount?: DeleteFn,
  purgeLocalClinicalData = vi.fn(async () => undefined),
  prepareClinicalPurge = vi.fn(async () => purgeLocalClinicalData),
  extras: Partial<DesktopProviderMainHost> = {}) {
  const state: ProviderSessionState = { phase, revision: crypto.randomUUID() };
  const openDashboard = vi.fn(async () => undefined), status = vi.fn(async () => null);
  const connect = vi.fn(async () => { throw new Error("No recording workspace should open"); });
  const host: DesktopProviderMainHost = {
    openDashboard, connect, prepareClinicalPurge, purgeLocalClinicalData,
    cancellation: { status, load: vi.fn(), submit: vi.fn() },
    session: sessionOf(state, deleteAccount), ...extras,
  };
  const main = new DesktopProviderWorkspaceMain(host, () => ({ dispose: async () => undefined }));
  await main.initialize();
  const send = (method: "open_dashboard" | "cancellation" | "delete_account" | "sign_in",
    payload: Record<string, unknown>, connectionId: string | null = null) => main.request({
    method, payload, requestId: crypto.randomUUID(), connectionId, encounterId: null,
  });
  return { main, openDashboard, status, connect, purgeLocalClinicalData, prepareClinicalPurge, send, state };
}
async function withFix<T>(
  args: Parameters<typeof fixture>, body: (f: Awaited<ReturnType<typeof fixture>>) => Promise<T>,
): Promise<T> {
  const f = await fixture(...args);
  try { return await body(f); } finally { await f.main.dispose(); }
}

describe("desktop account self-delete IPC", () => {
  const okDelete = () => ({
    status: "deleted" as const, practiceLeftOwnerless: false, clerkIdentityRemoved: true,
  });

  it("forwards DELETE, purges only on deleted, maps flags, surfaces purge failure", async () => {
    const deleteAccount = vi.fn(async () => okDelete());
    await withFix(["ready", deleteAccount], async f => {
      expect(await f.send("delete_account", { confirm: "DELETE" })).toMatchObject({
        ok: true, result: { status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true },
      });
      expect(f.prepareClinicalPurge).toHaveBeenCalledOnce();
      expect(f.purgeLocalClinicalData).toHaveBeenCalledOnce();
      expect(await f.send("delete_account", { confirm: "delete" })).toMatchObject({ ok: false });
    });
    // B2: 401 on a first attempt never wipes; reaches send marker only.
    const markSent401 = vi.fn(), confirm401 = vi.fn();
    await withFix(["ready", vi.fn(async () => ({ unauthorized: true as const })), undefined, undefined, {
      markClinicalPurgeSent: markSent401, confirmClinicalPurge: confirm401,
    }], async unauthorized => {
      expect(await unauthorized.send("delete_account", { confirm: "DELETE" }))
        .toMatchObject({ ok: true, result: { unauthorized: true } });
      expect(unauthorized.purgeLocalClinicalData).not.toHaveBeenCalled();
      expect(markSent401).toHaveBeenCalledOnce();
      expect(confirm401).not.toHaveBeenCalled();
    });
    // Offline / transport throw before definitive answer: no wipe.
    const markSentThrow = vi.fn(), confirmThrow = vi.fn();
    await withFix(["ready", vi.fn(async () => { throw new Error("offline"); }), undefined, undefined, {
      markClinicalPurgeSent: markSentThrow, confirmClinicalPurge: confirmThrow,
    }], async offline => {
      expect(await offline.send("delete_account", { confirm: "DELETE" })).toMatchObject({ ok: false });
      expect(offline.purgeLocalClinicalData).not.toHaveBeenCalled();
      expect(confirmThrow).not.toHaveBeenCalled();
    });
    for (const flag of ["gone", "unavailable", "retryable"] as const) {
      await withFix(["ready", vi.fn(async () => ({ [flag]: true as const }))], async row => {
        expect(await row.send("delete_account", { confirm: "DELETE" }))
          .toMatchObject({ ok: true, result: { [flag]: true } });
        expect(row.purgeLocalClinicalData).not.toHaveBeenCalled();
      });
    }
    const purgeLocalClinicalData = vi.fn(async () => { throw new Error("purge_failed"); });
    await withFix(["ready", vi.fn(async () => okDelete()), purgeLocalClinicalData], async purge => {
      expect(await purge.send("delete_account", { confirm: "DELETE" })).toMatchObject({
        ok: true, result: { status: "deleted", clinicalPurgeFailed: true },
      });
    });
    const blockedDelete = vi.fn(async () => okDelete());
    await withFix(["ready", blockedDelete, vi.fn(async () => undefined),
      vi.fn(async () => { throw new Error("desktop_clinical_scope_unavailable"); })], async refusePrepare => {
      expect(await refusePrepare.send("delete_account", { confirm: "DELETE" })).toMatchObject({ ok: false });
      expect(blockedDelete).not.toHaveBeenCalled();
    });
    await withFix(["ready", vi.fn(async () => ({
      status: "deleted" as const, practiceLeftOwnerless: false,
    }))], async missing => {
      expect(await missing.send("delete_account", { confirm: "DELETE" })).toMatchObject({ ok: false });
    });
    await withFix(["ready", vi.fn(async () => okDelete())], async scoped => {
      expect(await scoped.send("delete_account", { confirm: "DELETE" }, crypto.randomUUID()))
        .toMatchObject({ ok: false });
    });
  });

  it("returns deleted after abort once Cosmas DELETE has been sent", async () => {
    let release!: (value: ReturnType<typeof okDelete>) => void;
    const value = okDelete();
    const deleteAccount = vi.fn(() => new Promise<typeof value>(resolve => { release = resolve; }));
    await withFix(["ready", deleteAccount], async f => {
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
    });
  });

  it("refuses signed-out/missing delete; closes workspace only after session-ending delete", async () => {
    await withFix(["signedOut", vi.fn(async () => ({ unauthorized: true as const }))], async signedOut => {
      expect(await signedOut.send("delete_account", { confirm: "DELETE" })).toMatchObject({ ok: false });
    });
    await withFix(["ready"], async missing => {
      expect(await missing.send("delete_account", { confirm: "DELETE" })).toMatchObject({ ok: false });
    });
    const dispose = vi.fn(async () => undefined);
    const state: ProviderSessionState = { phase: "ready", revision: crypto.randomUUID() };
    const hostFor = (deleteAccount: DeleteFn): DesktopProviderMainHost => ({
      connect: vi.fn(async signal => ({
        dispose, workspace: {
          signal, listEncounters: async () => [], openEncounter: async () => { throw new Error("no"); },
          createEncounter: async () => undefined,
        },
      })),
      session: sessionOf(state, deleteAccount),
    });
    const run = async (deleteAccount: DeleteFn, expectDispose: boolean, result: object) => {
      const main = new DesktopProviderWorkspaceMain(hostFor(deleteAccount), () => ({ dispose: async () => undefined }));
      await main.initialize();
      try {
        await main.request({ method: "connect", payload: {}, requestId: crypto.randomUUID(), connectionId: null, encounterId: null });
        expect(await main.request({
          method: "delete_account", payload: { confirm: "DELETE" }, requestId: crypto.randomUUID(),
          connectionId: null, encounterId: null,
        })).toMatchObject({ ok: true, result });
        if (expectDispose) expect(dispose).toHaveBeenCalledOnce();
        else expect(dispose).not.toHaveBeenCalled();
      } finally { await main.dispose(); }
    };
    await run(vi.fn(async () => ({ unavailable: true as const })), false, { unavailable: true });
    dispose.mockClear();
    await run(vi.fn(async () => okDelete()), true, { status: "deleted" });
  });

  it("refuses delete_account for any non-terminal recorder state", async () => {
    const deleteAccount = vi.fn(async () => okDelete()), stop = vi.fn(async () => undefined);
    const state: ProviderSessionState = { phase: "ready", revision: crypto.randomUUID() };
    const sessionId = "10000000-0000-4000-8000-000000000001";
    const scope = {
      workspaceId: "20000000-0000-4000-8000-000000000002",
      bindingRef: "scribe_capture_binding_01j00000000000000000000000",
      appointmentRef: "appointment_01j00000000000000000000000",
    };
    const nativeRecord = {
      deactivate: stop, subscribe: () => () => undefined,
      snapshot: { sessionId, state: "recording", statusCode: "capture_recording",
        recordedChunks: 1, queuedChunks: 0, elapsedSeconds: 1, remainingBudgetSeconds: 0,
        remainingAuthoritySeconds: null, transcriptionStatus: null, transcript: null,
        desktop: { phase: "recording", coverage: "active", trimmedStartMs: 0, trimmedEndMs: null } },
    };
    const noopJournal = { load: async () => null, save: async () => undefined, clear: async () => undefined };
    const host = {
      prepareClinicalPurge: vi.fn(async () => vi.fn(async () => undefined)),
      connect: vi.fn(async (signal: AbortSignal) => ({
        dispose: stop, workspace: {
          signal,
          listEncounters: async () => [{ appointmentRef: scope.appointmentRef, title: "S", detail: "V" }],
          openEncounter: async (_: string, encounterSignal: AbortSignal) => ({
            scope, signal: encounterSignal,
            encounter: { appointmentRef: scope.appointmentRef, title: "S", detail: "V" },
            request: async () => Response.json({}), openInCore: async () => undefined,
            journal: { load: async () => ({ revision: "1", progress: { sessionId, uploaded: false, pendingSave: null, admission: {
              key: sessionId, languageMode: "en-US+es-US", attestation: {
                modality: "virtual", participant_regions: ["US-NY"], method: "verbal_attestation",
                all_parties_consented: true, granted_at: new Date().toISOString(),
              },
            } } }), save: async () => undefined },
            reviewJournal: () => noopJournal, recorder: async () => nativeRecord,
          }),
          createEncounter: async () => undefined,
        },
      })),
      session: sessionOf(state, deleteAccount),
    } as unknown as DesktopProviderMainHost;
    const main = new DesktopProviderWorkspaceMain(host, () => ({ dispose: stop }));
    await main.initialize();
    try {
      const req = (method: string, payload: Record<string, unknown>, connectionId: string | null = null,
        encounterId: string | null = null) => main.request({
        method: method as "connect", payload, requestId: crypto.randomUUID(), connectionId, encounterId,
      });
      const connected = await req("connect", {}) as { ok: boolean; result: { connectionId: string } };
      const opened = await req("open", { appointmentRef: scope.appointmentRef }, connected.result.connectionId) as {
        ok: boolean; result: { encounterId: string };
      };
      await req("recorder", { sessionId }, connected.result.connectionId, opened.result.encounterId);
      for (const recorderState of ["recording", "paused", "ready", "preparing", "error"] as const) {
        nativeRecord.snapshot.state = recorderState;
        expect(await req("delete_account", { confirm: "DELETE" }))
          .toMatchObject({ ok: true, result: { recordingActive: true } });
        expect(deleteAccount).not.toHaveBeenCalled();
      }
    } finally { await main.dispose(); }
  });

  it("H1: throw before/after prepare abandons prepared; H6 gates sign_in while pending", async () => {
    const abandonClinicalPurge = vi.fn(), confirmClinicalPurge = vi.fn();
    const hasPendingPurge = vi.fn(() => true);
    const deleteAccount = vi.fn(async () => { throw new Error("account_self_delete_http_500"); });
    await withFix(["ready", deleteAccount, undefined, undefined, {
      abandonClinicalPurge, confirmClinicalPurge, hasPendingPurge,
    }], async f => {
      expect(await f.send("delete_account", { confirm: "DELETE" })).toMatchObject({ ok: false });
      expect(abandonClinicalPurge).toHaveBeenCalled();
      expect(confirmClinicalPurge).not.toHaveBeenCalled();
      expect(await f.send("sign_in", {})).toMatchObject({ ok: false });
      expect(hasPendingPurge).toHaveBeenCalled();
    });
  });

  it("Mac online delete succeeds end-to-end; sign-out with prepared does not wipe", async () => {
    const wipe = vi.fn(async () => undefined);
    const markClinicalPurgeSent = vi.fn();
    const confirmClinicalPurge = vi.fn();
    const resolvePreparedPurge = vi.fn();
    const resetRecoveryScope = vi.fn();
    await withFix(["ready", vi.fn(async () => okDelete()), wipe, vi.fn(async () => wipe), {
      markClinicalPurgeSent, confirmClinicalPurge, resolvePreparedPurge, resetRecoveryScope,
    }], async f => {
      expect(await f.send("delete_account", { confirm: "DELETE" })).toMatchObject({
        ok: true, result: { status: "deleted" },
      });
      expect(markClinicalPurgeSent).toHaveBeenCalled();
      expect(confirmClinicalPurge).toHaveBeenCalled();
      expect(wipe).toHaveBeenCalledOnce();
    });
    // B5: session accept on signedOut must not revoke-wipe prepared markers.
    const hostResolve = vi.fn();
    const hostReset = vi.fn();
    const state: ProviderSessionState = { phase: "ready", revision: crypto.randomUUID() };
    const host: DesktopProviderMainHost = {
      connect: vi.fn(async () => { throw new Error("no"); }),
      resolvePreparedPurge: hostResolve, resetRecoveryScope: hostReset,
      session: {
        getState: async () => state,
        signIn: async () => state,
        signOut: async () => ({ phase: "signedOut", revision: crypto.randomUUID() }),
        addListener: async () => ({ remove: async () => undefined }),
      },
    };
    const main = new DesktopProviderWorkspaceMain(host, () => ({ dispose: async () => undefined }));
    await main.initialize();
    try {
      await main.request({
        method: "sign_out", payload: {}, requestId: crypto.randomUUID(), connectionId: null, encounterId: null,
      });
      expect(hostReset).toHaveBeenCalled();
      expect(hostResolve).not.toHaveBeenCalledWith(expect.objectContaining({ revoked: true }));
    } finally { await main.dispose(); }
  });
});
