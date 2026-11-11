import { afterEach, describe, expect, it, vi } from "vitest";
import { mountProviderApplication, type ProviderApplicationHost, type ProviderSessionState } from "./application";

vi.mock("./workspace", () => ({ mountProviderWorkspace: vi.fn(() => async () => undefined) }));
vi.mock("../../public/icon.svg?raw", () => ({ default: "" }));
vi.mock("./application.css", () => ({}));

class Surface extends EventTarget {
  innerHTML = ""; textContent = ""; dataset: Record<string, string> = {};
  classList = { add: vi.fn() }; style = { setProperty: vi.fn() }; private children = new Map<string, Surface>();
  querySelector(selector: string) {
    if (!this.children.has(selector)) this.children.set(selector, new Surface());
    return this.children.get(selector)!;
  }
  replaceChildren() {} setAttribute() {} getBoundingClientRect() { return { bottom: 0 }; }
  closest(selector: string) { return selector === "button[data-session-action]" ? this : null; }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function fixture(phase: ProviderSessionState["phase"]) {
  vi.stubGlobal("Element", Surface);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const state: ProviderSessionState = { phase, revision: crypto.randomUUID() };
  const host: ProviderApplicationHost = {
    connect: async () => { throw new Error("No real backend in this check"); },
    session: {
      getState: async () => state,
      signIn: async () => state,
      signOut: async () => state,
      addListener: async () => ({ remove: async () => undefined }),
    },
  };
  const root = new Surface();
  cleanups.push(mountProviderApplication(root as unknown as HTMLElement, host));
  for (let i = 0; i < 100; i++) await Promise.resolve();
  return root;
}

describe("first-launch session recovery copy", () => {
  it("offers sign-in recovery when the native session reports unavailable", async () => {
    const root = await fixture("unavailable");
    expect(root.querySelector("[data-session-title]").textContent).toBe("Sign-in unavailable");
    expect(root.querySelector("[data-session-message]").textContent).toContain("Check your connection");
    expect(root.querySelector("[data-session-recovery]").innerHTML).toContain('data-session-action="sign-in"');
    expect(root.querySelector("[data-session-recovery]").innerHTML).toContain("Try again");
  });

  it("keeps a recoverable setup message when auth remains disabled", async () => {
    const root = await fixture("disabled");
    expect(root.querySelector("[data-session-title]").textContent).toBe("Setup required");
    expect(root.querySelector("[data-session-message]").textContent).toContain("not ready for sign-in");
    expect(root.querySelector("[data-session-recovery]").innerHTML).toContain("Try again");
  });

  it("still reaches the normal signed-out sign-in screen", async () => {
    const root = await fixture("signedOut");
    expect(root.querySelector("[data-session-title]").textContent).toBe("Be present. Leave with your note.");
    expect(root.querySelector("[data-session-recovery]").innerHTML).toContain('data-session-action="sign-in"');
  });
});
