import { describe, expect, it, vi } from "vitest";
import { DesktopProviderWorkspaceMain, type DesktopProviderMainHost } from "./provider-workspace-main.js";
import type { DesktopProviderRecorder } from "./provider-recorder.js";
import type { DesktopProviderMethod, DesktopProviderEvent } from "../../capture/src/provider/desktop-host-protocol";
import type { ProviderSessionState } from "../../capture/src/provider/native-plugin";
import type { JournalSnapshot, ProviderProgress } from "../../capture/src/provider/workspace-journal";
import type { PendingReviewDecision } from "../../review-ui/src/creator-review-journal";

const sessionId = "10000000-0000-4000-8000-000000000001", workspaceId = "20000000-0000-4000-8000-000000000002";
const scope = { workspaceId, bindingRef: "scribe_capture_binding_01j00000000000000000000000", appointmentRef: "appointment_01j00000000000000000000000" };
const consent: ProviderProgress = { sessionId, uploaded: false, pendingSave: null, admission: { key: sessionId, languageMode: "en-US+es-US",
  attestation: { modality: "virtual", participant_regions: ["US-NY"], method: "verbal_attestation", all_parties_consented: true, granted_at: new Date().toISOString() } } };
const decision = { key: "invented-review-operation", request: { schema_version: "1.0" as const, source_segment_id: workspaceId,
  translation_id: sessionId, decision: "accepted" as const, expected_source_segment_version: 1,
  expected_source_transcript_version: 1, expected_translation_version: 1 } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(openingReview?: { scope: typeof scope; receivedAt: number; view: null }) {
  let state: ProviderSessionState = { phase: "ready", revision: crypto.randomUUID() };
  const authListeners = new Set<(value: ProviderSessionState) => void>(), events: DesktopProviderEvent[] = [];
  let saved: JournalSnapshot = { revision: "1", progress: structuredClone(consent) };
  let pending: PendingReviewDecision | null = null;
  let connectGate: Promise<void> | null = null, recorderGate: Promise<void> | null = null, coreGate: Promise<void> | null = null;
  let refuseStop = false, refuseAttachment = false, opens = 0;
  const contextSignals: AbortSignal[] = [];
  const changed = (phase: ProviderSessionState["phase"]) => {
    state = { phase, revision: crypto.randomUUID() }; authListeners.forEach(listener => listener(state));
  };
  const stop = vi.fn(async () => { if (refuseStop) throw new Error("invented native stop unconfirmed"); });
  const dispose = vi.fn(async () => undefined), nativeRecord = { deactivate: stop } as unknown as DesktopProviderRecorder;
  const backend = vi.fn(async () => { if (coreGate) await coreGate; return Response.json({ allowed: "invented-result" }); });
  const navigation = vi.fn(async () => undefined), create = vi.fn(async () => undefined);
  const signOut = vi.fn(async () => { changed("signedOut"); return state; });
  const host: DesktopProviderMainHost = {
    session: { getState: async () => state, signIn: async () => { changed("ready"); return state; },
      signOut,
      addListener: async (_event, listener) => { authListeners.add(listener); return { remove: async () => { authListeners.delete(listener); } }; } },
    connect: vi.fn(async signal => {
      opens++;
      if (connectGate) await connectGate;
      return { dispose, workspace: { signal, createEncounter: create,
        listEncounters: async () => [{ appointmentRef: scope.appointmentRef, title: "Invented desktop visit", detail: "Invented all-party consent" }],
        openEncounter: async (_ref: string, encounterSignal: AbortSignal) => {
          contextSignals.push(encounterSignal);
          return { scope, signal: encounterSignal, encounter: { appointmentRef: scope.appointmentRef, title: "Invented desktop visit", detail: "Invented consent" },
            request: backend, openInCore: navigation, ...(openingReview ? { openingReview } : {}),
            journal: { load: async () => structuredClone(saved), save: async (previous: JournalSnapshot, progress: ProviderProgress) => {
              if (previous.revision !== saved.revision) throw new Error("invented CAS conflict");
              saved = { revision: String(Number(saved.revision) + 1), progress: structuredClone(progress) }; return saved;
            } },
            reviewJournal: () => ({ load: async () => pending, save: async (value: PendingReviewDecision) => { pending = value; }, clear: async () => { pending = null; } }),
            recorder: async () => { if (recorderGate) await recorderGate; return nativeRecord; },
          };
        } } };
    }),
  };
  const attached = vi.fn(() => { if (refuseAttachment) throw new Error("invented IPC attachment failure"); return { dispose: stop }; });
  const main = new DesktopProviderWorkspaceMain(host, attached);
  main.subscribe(event => events.push(event)); await main.initialize();
  let connectionId: string | null = null, encounterId: string | null = null;
  const invoke = async (method: DesktopProviderMethod, payload: Record<string, unknown> = {}, ids?: { connectionId: string | null; encounterId: string | null }) =>
    main.request({ requestId: crypto.randomUUID(), method, payload, ...(ids ?? { connectionId, encounterId }) }) as Promise<{ ok: boolean; result: Record<string, unknown> | null }>;
  const connect = async () => { const reply = await invoke("connect", {}, { connectionId: null, encounterId: null });
    expect(reply.ok).toBe(true); connectionId = reply.result!.connectionId as string; encounterId = null; };
  const open = async () => { const reply = await invoke("open", { appointmentRef: scope.appointmentRef }, { connectionId, encounterId: null });
    expect(reply.ok).toBe(true); encounterId = reply.result!.encounterId as string; };
  return { main, invoke, connect, open, backend, attached, stop, dispose, events, changed, contextSignals, navigation, signOut,
    get opens() { return opens; },
    get ids() { return { connectionId, encounterId }; }, get saved() { return saved; },
    delayCore: (value: Promise<void>) => { coreGate = value; }, delayRecorder: (value: Promise<void>) => { recorderGate = value; },
    delayConnect: (value: Promise<void>) => { connectGate = value; }, refuseStop: (value: boolean) => { refuseStop = value; },
    refuseAttachment: (value: boolean) => { refuseAttachment = value; } };
}
const core = (kind: string) => ({ path: "/service/v1/agent/scribe/capture-operations", key: crypto.randomUUID(),
  body: { binding_ref: scope.bindingRef, workspace_id: workspaceId, request_nonce: crypto.randomUUID(), operation: { kind } } });

describe("trusted desktop provider workspace", () => {
  it.each([
    ["capture-admissions", 409, { detail: "provider_consent_required" }, { detail: "provider_consent_required" }],
    ["capture-notes", 409, { detail: "provider_consent_required" }, null],
    ["capture-admissions", 503, { detail: "provider_consent_required" }, null],
    ["capture-admissions", 409, { detail: "provider_consent_required", extra: "untrusted" }, null],
    ["capture-admissions", 409, { detail: "provider_request_unconfirmed" }, null],
  ] as const)("forwards only the bounded admission renewal outcome across the desktop bridge (%s %s)", async (action, status, body, expected) => {
    const f = await fixture();
    try {
      await f.connect(); await f.open();
      f.backend.mockResolvedValueOnce(Response.json(body, { status }));
      const reply = await f.invoke("core", { path: "/service/v1/agent/scribe/" + action, key: crypto.randomUUID(),
        body: { binding_ref: scope.bindingRef, workspace_id: workspaceId, request_nonce: crypto.randomUUID() } });
      expect(reply.ok).toBe(true); expect(reply.result).toEqual({ status, body: expected });
    } finally { await f.main.dispose(); }
  });
  it("connects encounter/review/note actions while denying recorder credentials and changed scopes", async () => {
    const f = await fixture();
    try {
      await f.connect(); await f.open();
      expect((await f.invoke("journal_load")).ok).toBe(true);
      expect((await f.invoke("journal_save", { previous: f.saved, progress: consent })).ok).toBe(true);
      expect((await f.invoke("review_save", { sessionId, operation: decision })).ok).toBe(true);
      expect((await f.invoke("review_load", { sessionId })).result).toEqual(decision);
      expect((await f.invoke("review_clear", { sessionId, key: decision.key })).ok).toBe(true);
      expect((await f.invoke("review_load", { sessionId: crypto.randomUUID() })).ok).toBe(false);
      expect((await f.invoke("core", core("creator_review"))).ok).toBe(true);
      expect((await f.invoke("core", core("provider_encounter"))).ok).toBe(true);
      for (const kind of ["authorize_upload", "bind_key", "issue_lease", "reserve_chunks", "complete"]) {
        expect((await f.invoke("core", core(kind))).ok).toBe(false);
      }
      const wrong = core("creator_review"); wrong.body.workspace_id = crypto.randomUUID();
      expect((await f.invoke("core", wrong)).ok).toBe(false); expect(f.backend).toHaveBeenCalledTimes(2);
      expect((await f.invoke("recorder", { sessionId })).ok).toBe(true); expect(f.attached).toHaveBeenCalledTimes(1);
      expect((await f.invoke("recorder", { sessionId })).ok).toBe(false);
      expect((await f.invoke("open_core", { noteRef: null })).ok).toBe(true); expect(f.navigation).toHaveBeenCalledWith(null);
      const old = f.ids; await f.open();
      expect(f.stop).toHaveBeenCalledTimes(1); expect(f.contextSignals[0]!.aborted).toBe(true);
      expect((await f.invoke("journal_load", {}, old)).ok).toBe(false);
    } finally { await f.main.dispose(); }
  });
  it("clears access on revocation and holds old ownership until in-flight content finishes", async () => {
    const f = await fixture(), gate = deferred<void>();
    try {
      await f.connect(); await f.open(); f.delayCore(gate.promise);
      const pending = f.invoke("core", core("creator_review"));
      await vi.waitFor(() => expect(f.backend).toHaveBeenCalledTimes(1));
      f.changed("signedOut");
      expect(f.events.some(event => event.kind === "connection_closed")).toBe(true);
      expect(f.contextSignals[0]!.aborted).toBe(true); expect(f.dispose).not.toHaveBeenCalled();
      gate.resolve(); expect((await pending).ok).toBe(false);
      expect((await f.invoke("disconnect", {}, { ...f.ids, encounterId: null })).ok).toBe(true);
      expect(f.dispose).toHaveBeenCalledTimes(1);
    } finally { gate.resolve(); await f.main.dispose(); }
  });
  it("owns a late recorder and retries failed cleanup before allowing another connection", async () => {
    const f = await fixture(), gate = deferred<void>();
    try {
      await f.connect(); await f.open(); f.delayRecorder(gate.promise); f.refuseStop(true);
      const acquiring = f.invoke("recorder", { sessionId });
      await new Promise(resolve => setTimeout(resolve, 0));
      const closing = f.invoke("disconnect", {}, { ...f.ids, encounterId: null });
      gate.resolve(); expect((await acquiring).ok).toBe(false); expect((await closing).ok).toBe(false);
      expect(f.attached).toHaveBeenCalledTimes(1); expect(f.dispose).not.toHaveBeenCalled();
      expect((await f.invoke("connect", {}, { connectionId: null, encounterId: null })).ok).toBe(false);
      expect(f.opens).toBe(1);
      f.refuseStop(false);
      expect((await f.invoke("disconnect", {}, { ...f.ids, encounterId: null })).ok).toBe(true);
      expect(f.dispose).toHaveBeenCalledTimes(1); await f.connect(); expect(f.opens).toBe(2);
    } finally { gate.resolve(); f.refuseStop(false); await f.main.dispose(); }
  });
  it("runs native sign-out immediately while a connection is still opening", async () => {
    const f = await fixture(), gate = deferred<void>(); f.delayConnect(gate.promise);
    try {
      const opening = f.invoke("connect", {}, { connectionId: null, encounterId: null });
      await vi.waitFor(() => expect(f.opens).toBe(1));
      const signingOut = f.invoke("sign_out", {}, { connectionId: null, encounterId: null });
      await vi.waitFor(() => expect(f.signOut).toHaveBeenCalledTimes(1));
      gate.resolve(); expect((await opening).ok).toBe(false); expect((await signingOut).ok).toBe(true);
      expect(f.dispose).toHaveBeenCalledTimes(1);
    } finally { gate.resolve(); await f.main.dispose(); }
  });
  it("reserves cancellation and logout while all content slots are occupied", async () => {
    const f = await fixture(), gate = deferred<void>(), requestId = crypto.randomUUID();
    try {
      await f.connect(); await f.open(); f.delayCore(gate.promise);
      const first = f.main.request({ requestId, method: "core", payload: core("creator_review"), ...f.ids });
      const others = Array.from({ length: 7 }, () => f.invoke("core", core("creator_review")));
      await vi.waitFor(() => expect(f.backend).toHaveBeenCalledTimes(8));
      await expect(f.invoke("journal_load")).rejects.toThrow("unavailable");
      expect((await f.invoke("cancel", { requestId }, { connectionId: null, encounterId: null })).ok).toBe(true);
      const signingOut = f.invoke("sign_out", {}, { connectionId: null, encounterId: null });
      await vi.waitFor(() => expect(f.signOut).toHaveBeenCalledTimes(1));
      gate.resolve();
      expect(await first).toMatchObject({ ok: false, result: null });
      expect((await Promise.all(others)).every(reply => !reply.ok)).toBe(true);
      expect((await signingOut).ok).toBe(true);
    } finally { gate.resolve(); await f.main.dispose(); }
  });
  it("rejects concurrent recorder acquisition and retains cleanup after failed IPC attachment", async () => {
    const f = await fixture(), gate = deferred<void>();
    try {
      await f.connect(); await f.open(); f.delayRecorder(gate.promise); f.refuseAttachment(true); f.refuseStop(true);
      const first = f.invoke("recorder", { sessionId });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect((await f.invoke("recorder", { sessionId })).ok).toBe(false);
      gate.resolve(); expect((await first).ok).toBe(false);
      expect(f.attached).toHaveBeenCalledTimes(1);
      expect((await f.invoke("disconnect", {}, { ...f.ids, encounterId: null })).ok).toBe(false);
      expect(f.dispose).not.toHaveBeenCalled(); f.refuseStop(false);
      expect((await f.invoke("disconnect", {}, { ...f.ids, encounterId: null })).ok).toBe(true);
      expect(f.stop).toHaveBeenCalled(); expect(f.dispose).toHaveBeenCalledTimes(1);
    } finally { gate.resolve(); f.refuseStop(false); await f.main.dispose(); }
  });
});


it("passes opening display data through main IPC without renewing its timestamp", async () => {
  const openingReview = { scope, receivedAt: Date.now() - 100, view: null };
  const f = await fixture(openingReview);
  try {
    await f.connect();
    const reply = await f.invoke("open", { appointmentRef: scope.appointmentRef }, { ...f.ids, encounterId: null });
    expect(reply.ok).toBe(true);
    expect(reply.result!.openingReview).toEqual(openingReview);
  } finally { await f.main.dispose(); }
});
