import { afterEach, describe, expect, it, vi } from "vitest";
import { mountProviderApplication, type ProviderApplicationHost } from "./application";
import { ACCOUNT_SELF_DELETE_MESSAGES, type AccountSelfDeleteHost } from "./account-self-delete";
import { mountAccountSelfDeleteDialog } from "./account-self-delete-dialog";
import type { ProviderSessionState } from "./native-plugin";

vi.mock("./workspace", () => ({ mountProviderWorkspace: vi.fn(() => async () => undefined) }));
vi.mock("./account-self-delete-dialog", () => ({ mountAccountSelfDeleteDialog: vi.fn(() => () => undefined) }));

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

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose();
  vi.unstubAllGlobals();
  vi.mocked(mountAccountSelfDeleteDialog).mockClear();
});

async function fixture() {
  vi.stubGlobal("Element", Surface);
  vi.stubGlobal("document", Object.assign(new EventTarget(), {
    visibilityState: "visible", body: new Surface(),
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  let state: ProviderSessionState = { phase: "ready", revision: crypto.randomUUID() };
  let observe!: (value: ProviderSessionState) => void;
  const deleteAccount = vi.fn(async () => ({
    outcome: "deleted" as const, status: "deleted" as const,
    practiceLeftOwnerless: false, clerkIdentityRemoved: true,
  }));
  const host: ProviderApplicationHost = {
    connect: vi.fn(async (signal: AbortSignal) => ({
      dispose: async () => undefined,
      workspace: { signal, listEncounters: vi.fn(), openEncounter: vi.fn(), createEncounter: vi.fn() },
    })),
    accountSelfDelete: { deleteAccount },
    session: {
      getState: async () => state,
      signIn: async () => { state = { phase: "ready", revision: crypto.randomUUID() }; observe(state); return state; },
      signOut: async () => { state = { phase: "signedOut", revision: crypto.randomUUID() }; observe(state); return state; },
      addListener: async (_name, listener) => { observe = listener; return { remove: async () => undefined }; },
    },
  };
  const root = new Surface();
  cleanups.push(mountProviderApplication(root as unknown as HTMLElement, host));
  const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  const click = async (action: string) => {
    const target = new Surface(); target.dataset.sessionAction = action;
    const event = new Event("click"); Object.defineProperty(event, "target", { value: target });
    root.dispatchEvent(event); await settle();
  };
  await settle();
  return {
    root, click, deleteAccount, settle,
    emitSignedOut: () => {
      state = { phase: "signedOut", revision: crypto.randomUUID() };
      observe(state);
    },
  };
}

describe("account self-delete recording guard", () => {
  it("refuses Delete account while recording is active", async () => {
    const f = await fixture();
    f.root.querySelector("[data-provider-workflow]")!.dataset.providerRecordingActive = "true";
    await f.click("delete-account");
    expect(mountAccountSelfDeleteDialog).not.toHaveBeenCalled();
    expect(f.root.querySelector("[data-session-message]")?.textContent)
      .toBe(ACCOUNT_SELF_DELETE_MESSAGES.recordingActive);
  });

  it("opens the delete dialog when no recording is active", async () => {
    const f = await fixture();
    await f.click("delete-account");
    expect(mountAccountSelfDeleteDialog).toHaveBeenCalledOnce();
  });

  it("re-checks providerRecordingActive at submit and skips Cosmas", async () => {
    const f = await fixture();
    await f.click("delete-account");
    const dialog = vi.mocked(mountAccountSelfDeleteDialog).mock.calls.at(-1)?.[1] as AccountSelfDeleteHost;
    f.root.querySelector("[data-provider-workflow]")!.dataset.providerRecordingActive = "true";
    expect(await dialog.client.deleteAccount({ confirm: "DELETE" })).toEqual({ outcome: "recording_active" });
    expect(f.deleteAccount).not.toHaveBeenCalled();
  });

  it("keeps dialog across signedOut during in-flight DELETE and still clears", async () => {
    let release!: (value: {
      outcome: "deleted"; status: "deleted"; practiceLeftOwnerless: false; clerkIdentityRemoved: true;
    }) => void;
    const disposeDialog = vi.fn();
    vi.mocked(mountAccountSelfDeleteDialog).mockImplementationOnce(() => disposeDialog);
    const f = await fixture();
    f.deleteAccount.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await f.click("delete-account");
    const dialog = vi.mocked(mountAccountSelfDeleteDialog).mock.calls.at(-1)?.[1] as AccountSelfDeleteHost;
    const pending = dialog.client.deleteAccount({ confirm: "DELETE" });
    await f.settle();
    f.emitSignedOut();
    await f.settle();
    expect(disposeDialog).not.toHaveBeenCalled();
    release({
      outcome: "deleted", status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    });
    await pending;
    await dialog.purgeLocalClinicalData();
    await dialog.clearLocalCredentials();
    expect(f.root.querySelector("[data-session-title]")?.textContent).toBe("Account deleted");
  });
});
