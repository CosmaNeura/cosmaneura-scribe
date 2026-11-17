import { afterEach, describe, expect, it, vi } from "vitest";
import { mountProviderApplication, type ProviderApplicationHost, type ProviderSessionState } from "./application";
import { ProviderSetupRequired } from "./account-setup";

vi.mock("./workspace", () => ({ mountProviderWorkspace: vi.fn(() => async () => undefined) }));
vi.mock("../../public/icon.svg?raw", () => ({ default: "" }));
vi.mock("./application.css", () => ({}));
class Surface extends EventTarget {
  innerHTML = ""; textContent = ""; dataset: Record<string, string> = {};
  classList = { add: vi.fn() }; style = { setProperty: vi.fn() }; private children = new Map<string, Surface>();
  querySelector(selector: string) { if (!this.children.has(selector)) this.children.set(selector, new Surface()); return this.children.get(selector)!; }
  replaceChildren() {} setAttribute() {} getBoundingClientRect() { return { bottom: 0 }; }
  closest(selector: string) { return selector === "button[data-session-action]" ? this : null; }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanups.splice(0)) await dispose(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function fixture(connect: ProviderApplicationHost["connect"], activate?: ProviderApplicationHost["activateScribe"]) {
  vi.stubGlobal("Element", Surface);
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" }); vi.stubGlobal("document", document);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  let state: ProviderSessionState = { phase: "ready", revision: crypto.randomUUID() };
  let observe!: (value: ProviderSessionState) => void;
  const openPracticeSetup = vi.fn(async () => undefined), activation = vi.fn(activate ?? (async () => undefined));
  const host: ProviderApplicationHost = { connect, openPracticeSetup, activateScribe: activation,
    cancellation: { status: vi.fn(async () => null), load: vi.fn(), submit: vi.fn() },
    session: { getState: async () => state, signIn: async () => state,
      signOut: async () => { state = { phase: "signedOut", revision: crypto.randomUUID() }; observe(state); return state; },
      addListener: async (_name, listener) => { observe = listener; return { remove: async () => undefined }; } } };
  const root = new Surface(); cleanups.push(mountProviderApplication(root as unknown as HTMLElement, host));
  const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  const click = async (action: string) => {
    const target = new Surface(); target.dataset.sessionAction = action;
    const event = new Event("click"); Object.defineProperty(event, "target", { value: target }); root.dispatchEvent(event); await settle();
  };
  await settle();
  return { root, click, settle, document, activation, openPracticeSetup,
    change: () => { state = { phase: "ready", revision: crypto.randomUUID() }; observe(state); } };
}
const connected = async (signal: AbortSignal) => ({ dispose: async () => undefined,
  workspace: { signal, listEncounters: vi.fn(), openEncounter: vi.fn(), createEncounter: vi.fn() } });
describe("account setup without recording access", () => {
  it("offers fixed practice setup and rechecks on return before opening the workspace", async () => {
    let ready = false;
    const connect = vi.fn(async (signal: AbortSignal) => { if (!ready) throw new ProviderSetupRequired("practice"); return connected(signal); });
    const f = await fixture(connect);
    expect(f.root.querySelector("[data-session-title]").textContent).toBe("Complete practice setup");
    expect(f.activation).not.toHaveBeenCalled();
    await f.click("practice-setup"); expect(f.openPracticeSetup).toHaveBeenCalledOnce();
    ready = true; f.document.dispatchEvent(new Event("visibilitychange")); await f.settle();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(f.root.querySelector("[data-session-title]").textContent).toBe("");
  });
  it("activates once per session revision and requires a fresh successful connection", async () => {
    const connect = vi.fn(async (signal: AbortSignal) => {
      if (connect.mock.calls.length === 1) throw new ProviderSetupRequired("activation"); return connected(signal);
    });
    const f = await fixture(connect);
    expect(f.activation).toHaveBeenCalledOnce(); expect(connect).toHaveBeenCalledTimes(2);
    expect(f.root.querySelector("[data-session-title]").textContent).toBe("");
  });
  it("does not loop if activation succeeds but a connection still needs activation", async () => {
    const connect = vi.fn(async () => { throw new ProviderSetupRequired("activation"); });
    const f = await fixture(connect);
    expect(f.activation).toHaveBeenCalledOnce(); expect(connect).toHaveBeenCalledTimes(2);
    expect(f.root.querySelector("[data-session-recovery]").innerHTML).toContain("Retry activation");
    f.document.dispatchEvent(new Event("visibilitychange")); await f.settle();
    expect(f.activation).toHaveBeenCalledOnce();
  });
  it("rejects a late activation result after account revision changes", async () => {
    let resolve!: () => void;
    const connect = vi.fn(async () => { throw new ProviderSetupRequired("activation"); });
    const f = await fixture(connect, () => new Promise<void>(done => { resolve = done; }));
    expect(f.activation).toHaveBeenCalledOnce(); f.change(); resolve(); await f.settle();
    expect(connect).toHaveBeenCalledOnce();
    expect(f.root.querySelector("[data-session-recovery]").innerHTML).not.toContain("Complete practice setup");
  });
  it("shows practice setup if authorization becomes incomplete during activation", async () => {
    const connect = vi.fn(async () => { throw new ProviderSetupRequired("activation"); });
    const f = await fixture(connect, async () => { throw new ProviderSetupRequired("practice"); });
    expect(f.root.querySelector("[data-session-title]").textContent).toBe("Complete practice setup");
    expect(connect).toHaveBeenCalledOnce();
  });
});
