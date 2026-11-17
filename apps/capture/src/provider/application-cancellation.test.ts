import { afterEach, describe, expect, it, vi } from "vitest";
import { mountProviderApplication, type ProviderApplicationHost } from "./application";
import { openCancellationDialog } from "./cancellation-dialog";
import type { CancellationReceipt } from "./cancellation";
import type { ProviderSessionState } from "./native-plugin";

// Real application-owner actions; this command-target surface does not claim
// native/browser layout, network, recording or export qualification.
vi.mock("./workspace", () => ({ mountProviderWorkspace: vi.fn(() => async () => undefined) }));
vi.mock("./cancellation-dialog", () => ({ openCancellationDialog: vi.fn(() => () => undefined) }));
class Surface extends EventTarget {
  readonly nodes = new Map<string, Surface>();
  readonly dataset: Record<string, string> = {};
  readonly classList = { add: vi.fn() }; readonly style = { setProperty: vi.fn() };
  textContent = ""; markup = "";
  set innerHTML(value: string) {
    this.markup = value;
    for (const name of ["session-actions", "session-title", "session-message", "session-recovery", "provider-workflow", "provider-name"]) {
      if (value.includes(`data-${name}`)) this.nodes.set(`[data-${name}]`, new Surface());
    }
    if (value.includes('class="provider-session-header"')) this.nodes.set(".provider-session-header", new Surface());
  }
  get innerHTML() { return this.markup; }
  querySelector(selector: string) { return this.nodes.get(selector) ?? null; }
  setAttribute() {}
  getBoundingClientRect() { return { bottom: 0 }; }
  replaceChildren() { this.markup = ""; }
  closest(selector: string) { return selector === "button[data-session-action]" ? this : null; }
}
const receipt: CancellationReceipt = { contract_version: "1", action: "status", request_nonce: crypto.randomUUID(),
  operation_id: crypto.randomUUID(), received_at: "2026-11-02T12:00:00Z", export_until: "2027-01-31T12:00:00Z",
  grace_days: 90, phi_scope: "core-and-scribe-clinical-records", scope: "scribe-only", shared_login_preserved: true,
  resource_manifest_status: "unresolved", access_fence_confirmed: true, erasure_confirmed: false, phase: "read-only-export" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanups.splice(0)) await dispose(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function fixture(status: () => Promise<CancellationReceipt | null>) {
  vi.stubGlobal("Element", Surface);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  let state: ProviderSessionState = { phase: "ready", revision: crypto.randomUUID() };
  let observe!: (value: ProviderSessionState) => void;
  const connect = vi.fn(async (signal: AbortSignal) => ({ dispose: async () => undefined,
    workspace: { signal, listEncounters: vi.fn(), openEncounter: vi.fn(), createEncounter: vi.fn() } }));
  const openDashboard = vi.fn(async () => undefined), statusCheck = vi.fn(status);
  const host: ProviderApplicationHost = { openDashboard, connect,
    cancellation: { status: statusCheck, load: vi.fn(async () => receipt), submit: vi.fn(async () => receipt) },
    session: { getState: async () => state, signIn: async () => { state = { phase: "ready", revision: crypto.randomUUID() }; observe(state); return state; },
      signOut: async () => { state = { phase: "signedOut", revision: crypto.randomUUID() }; observe(state); return state; },
      addListener: async (_name, listener) => { observe = listener; return { remove: async () => undefined }; } },
  };
  const root = new Surface(); const dispose = mountProviderApplication(root as unknown as HTMLElement, host); cleanups.push(dispose);
  const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  const click = async (action: string) => {
    const target = new Surface(); target.dataset.sessionAction = action;
    const event = new Event("click"); Object.defineProperty(event, "target", { value: target }); root.dispatchEvent(event); await settle();
  };
  await settle();
  return { root, host, statusCheck, connect, openDashboard, click, settle };
}
describe("canceled account application access", () => {
  it("recovers read-only at reopen, offers the trusted dashboard, and remains closed after sign-out/in", async () => {
    const f = await fixture(async () => receipt);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.root.querySelector("[data-session-recovery]")?.innerHTML).toContain("Open dashboard to read or export");
    expect(f.root.querySelector("[data-session-recovery]")?.innerHTML).not.toContain("Open workspace");
    await f.click("open"); expect(f.connect).not.toHaveBeenCalled();
    await f.click("dashboard"); expect(f.openDashboard).toHaveBeenCalledOnce();
    await f.click("sign-out"); await f.click("sign-in");
    expect(f.connect).not.toHaveBeenCalled(); expect(f.statusCheck).toHaveBeenCalledTimes(3);
  });
  it("an accepted receipt replaces workspace reopening with read-only dashboard access", async () => {
    const f = await fixture(async () => null); expect(f.connect).toHaveBeenCalledOnce();
    await f.click("cancel-scribe");
    const invocation = vi.mocked(openCancellationDialog).mock.calls.at(-1)!;
    await invocation[2](); invocation[3](receipt);
    expect(f.root.querySelector("[data-session-recovery]")?.innerHTML).not.toContain("Open workspace");
    expect(f.root.querySelector("[data-session-recovery]")?.innerHTML).toContain("Open dashboard to read or export");
    expect(invocation[4]).toBe(f.openDashboard);
    await f.click("open"); expect(f.connect).toHaveBeenCalledOnce();
    await f.click("dashboard"); expect(f.openDashboard).toHaveBeenCalledOnce();
  });
  it("opens the ordinary workspace after own status confirms no cancellation", async () => {
    const f = await fixture(async () => null); expect(f.connect).toHaveBeenCalledOnce(); expect(f.openDashboard).not.toHaveBeenCalled();
  });
  it("holds recording closed when own status or a retained request cannot be confirmed", async () => {
    const f = await fixture(async () => { throw new Error("retained request unconfirmed"); });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.root.querySelector("[data-session-recovery]")?.innerHTML).toContain("Check access");
    await f.click("open"); expect(f.connect).not.toHaveBeenCalled();
  });
  it("bounds an unanswered status check and supplies a retry instead of recording", async () => {
    vi.useFakeTimers(); const f = await fixture(() => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(5000); await f.settle();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.root.querySelector("[data-session-recovery]")?.innerHTML).toContain("Check access");
    expect(f.root.querySelector("[data-session-message]")?.textContent).toContain("Recording stays closed");
  });
  it("does not offer dashboard PHI access after the export window has expired", async () => {
    const f = await fixture(async () => ({ ...receipt, phase: "read-only-expired" }));
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.root.querySelector("[data-session-recovery]")?.innerHTML).not.toContain("Open dashboard");
    await f.click("dashboard"); expect(f.openDashboard).not.toHaveBeenCalled();
  });
});
