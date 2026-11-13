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

async function fixture(phase: ProviderSessionState["phase"] | null, notice?: string) {
  vi.stubGlobal("Element", Surface);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const state: ProviderSessionState | null = phase === null ? null : { phase, revision: crypto.randomUUID() };
  let current = state;
  const order: string[] = [];
  const signIn = vi.fn(async () => {
    order.push("signIn");
    current = { phase: "ready", revision: crypto.randomUUID() };
    return current;
  });
  const host: ProviderApplicationHost = {
    connect: async () => {
      order.push("connect");
      return {
        workspace: { signal: new AbortController().signal } as never,
        dispose: async () => { order.push("close"); },
      };
    },
    session: {
      getState: async () => {
        if (current === null) throw new Error(notice ?? "Native session unavailable");
        return current;
      },
      signIn,
      signOut: async () => {
        current = { phase: "signedOut", revision: crypto.randomUUID() };
        return current;
      },
      addListener: async () => ({ remove: async () => undefined }),
    },
  };
  const root = new Surface();
  cleanups.push(mountProviderApplication(root as unknown as HTMLElement, host));
  for (let i = 0; i < 100; i++) await Promise.resolve();
  return { root, host, signIn, order };
}

describe("first-launch session recovery copy", () => {
  it("offers sign-in only for an unavailable session phase", async () => {
    const { root } = await fixture("unavailable");
    expect(root.querySelector("[data-session-title]").textContent).toBe("Session unavailable");
    expect(root.querySelector("[data-session-message]").textContent.toLowerCase()).not.toContain("connection");
    expect(root.querySelector("[data-session-recovery]").innerHTML).toContain('data-session-action="sign-in"');
    expect(root.querySelector("[data-session-recovery]").innerHTML).toContain("Try again");
  });

  it("keeps Session unavailable without Sign in when state is null with a notice", async () => {
    const { root } = await fixture(null, "The native session is unavailable. Reopen Scribe to try again.");
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(root.querySelector("[data-session-title]").textContent).toBe("Session unavailable");
    expect(root.querySelector("[data-session-recovery]").innerHTML).not.toContain('data-session-action="sign-in"');
    expect(root.querySelector("[data-session-recovery]").innerHTML).toContain("Try again");
  });

  it("keeps a recoverable setup message when auth remains disabled", async () => {
    const { root } = await fixture("disabled");
    expect(root.querySelector("[data-session-title]").textContent).toBe("Setup required");
    expect(root.querySelector("[data-session-message]").textContent).toContain("not ready for sign-in");
    expect(root.querySelector("[data-session-message]").textContent.toLowerCase()).not.toContain("practice activates");
    expect(root.querySelector("[data-session-recovery]").innerHTML).toContain("Try again");
  });

  it("still reaches the normal signed-out sign-in screen", async () => {
    const { root } = await fixture("signedOut");
    expect(root.querySelector("[data-session-title]").textContent).toBe("Be present. Leave with your note.");
    expect(root.querySelector("[data-session-recovery]").innerHTML).toContain('data-session-action="sign-in"');
  });

  it("clicks Sign in in unavailable and calls signIn once after close", async () => {
    const { root, signIn, order } = await fixture("unavailable");
    expect(root.querySelector("[data-session-recovery]").innerHTML).toContain('data-session-action="sign-in"');
    const button = new Surface();
    button.dataset = { sessionAction: "sign-in" };
    const event = new Event("click");
    Object.defineProperty(event, "target", { value: button });
    root.dispatchEvent(event);
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(signIn).toHaveBeenCalledOnce();
    // No prior workspace on cold unavailable; close() is a no-op, then signIn, then open/connect.
    expect(order[0]).toBe("signIn");
    expect(order.filter(step => step === "signIn")).toEqual(["signIn"]);
  });
});
