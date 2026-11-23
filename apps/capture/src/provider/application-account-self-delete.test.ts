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
  vi.unstubAllGlobals(); vi.mocked(mountAccountSelfDeleteDialog).mockClear();
});

async function fixture() {
  vi.stubGlobal("Element", Surface);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible", body: new Surface() }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("indexedDB", {
    databases: async () => [],
    deleteDatabase: () => ({
      set onsuccess(h: () => void) { queueMicrotask(h); },
      set onerror(_h: () => void) {}, set onblocked(_h: () => void) {}, error: null,
    }),
  });
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
    emitSignedOut: () => { state = { phase: "signedOut", revision: crypto.randomUUID() }; observe(state); },
  };
}

describe("account self-delete recording guard", () => {
  it("refuses while recording or sealing; allows post-seal pending upload (Delete anyway); opens when idle", async () => {
    // Live recording: active without upload-pending (workspace classification for
    // recording / sealing — sealing must not set providerUploadPending).
    const blocked = await fixture();
    blocked.root.querySelector("[data-provider-workflow]")!.dataset.providerRecordingActive = "true";
    await blocked.click("delete-account");
    expect(mountAccountSelfDeleteDialog).not.toHaveBeenCalled();
    expect(blocked.deleteAccount).not.toHaveBeenCalled();
    expect(blocked.root.querySelector("[data-session-message]")?.textContent)
      .toBe(ACCOUNT_SELF_DELETE_MESSAGES.recordingActive);
    // Same flag shape as native phase sealing after workspace syncRecordingActive.
    const sealing = await fixture();
    sealing.root.querySelector("[data-provider-workflow]")!.dataset.providerRecordingActive = "true";
    delete sealing.root.querySelector("[data-provider-workflow]")!.dataset.providerUploadPending;
    await sealing.click("delete-account");
    expect(mountAccountSelfDeleteDialog).not.toHaveBeenCalled();
    expect(sealing.deleteAccount).not.toHaveBeenCalled();
    expect(sealing.root.querySelector("[data-session-message]")?.textContent)
      .toBe(ACCOUNT_SELF_DELETE_MESSAGES.recordingActive);
    // Post-seal uploading only (John Delete anyway): active + upload-pending.
    const pending = await fixture();
    const workflow = pending.root.querySelector("[data-provider-workflow]")!;
    workflow.dataset.providerRecordingActive = "true";
    workflow.dataset.providerUploadPending = "true";
    await pending.click("delete-account");
    expect(mountAccountSelfDeleteDialog).toHaveBeenCalledOnce();
    vi.mocked(mountAccountSelfDeleteDialog).mockClear();
    const idle = await fixture();
    await idle.click("delete-account");
    expect(mountAccountSelfDeleteDialog).toHaveBeenCalledOnce();
  });

  it("re-checks recording at submit; keeps dialog across mid-flight signedOut", async () => {
    const f = await fixture();
    await f.click("delete-account");
    const dialog = vi.mocked(mountAccountSelfDeleteDialog).mock.calls.at(-1)?.[1] as AccountSelfDeleteHost;
    f.root.querySelector("[data-provider-workflow]")!.dataset.providerRecordingActive = "true";
    expect(await dialog.client.deleteAccount({ confirm: "DELETE" })).toEqual({ outcome: "recording_active" });
    expect(f.deleteAccount).not.toHaveBeenCalled();

    let release!: (value: {
      outcome: "deleted"; status: "deleted"; practiceLeftOwnerless: false; clerkIdentityRemoved: true;
    }) => void;
    const disposeDialog = vi.fn();
    vi.mocked(mountAccountSelfDeleteDialog).mockImplementationOnce(() => disposeDialog);
    const live = await fixture();
    live.deleteAccount.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await live.click("delete-account");
    const liveDialog = vi.mocked(mountAccountSelfDeleteDialog).mock.calls.at(-1)?.[1] as AccountSelfDeleteHost;
    const pending = liveDialog.client.deleteAccount({ confirm: "DELETE" });
    await live.settle(); live.emitSignedOut(); await live.settle();
    expect(disposeDialog).not.toHaveBeenCalled();
    release({ outcome: "deleted", status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true });
    await pending; await liveDialog.purgeLocalClinicalData(); await liveDialog.clearLocalCredentials();
    expect(live.root.querySelector("[data-session-title]")?.textContent).toBe("Account deleted");
  });
});
