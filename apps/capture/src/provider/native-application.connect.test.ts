import { beforeEach, describe, expect, it, vi } from "vitest";

const identityA = "a".repeat(64);
const identityB = "b".repeat(64);
const scopeA = "11111111-1111-4111-8111-111111111111";
const scopeB = "22222222-2222-4222-8222-222222222222";

const sq = vi.hoisted(() => ({
  migrateAccounts: vi.fn(async () => undefined), rememberedAccount: vi.fn(async () => ({})),
  setActiveWriteAccount: vi.fn(async () => undefined), rememberAccount: vi.fn(async () => undefined),
  list: vi.fn(async () => ({ keys: [] })), delete: vi.fn(async () => undefined),
  wipeAccount: vi.fn(async () => ({ cleared: 0, remaining: 0 })),
}));
const disposeBackend = vi.hoisted(() => vi.fn(async () => undefined));
const listEncounters = vi.hoisted(() => vi.fn(async () => []));
const getState = vi.hoisted(() => vi.fn(async (): Promise<{
  phase: string; revision: string; accountIdentitySHA256?: string;
}> => ({ phase: "signed_out", revision: "rev" })));
const deleteAccount = vi.hoisted(() => vi.fn(async () => ({
  status: "deleted" as const, practiceLeftOwnerless: false, clerkIdentityRemoved: true,
})));
let recoveryScope: string | undefined;
let captured: {
  connect: (signal: AbortSignal) => Promise<{ dispose: () => Promise<void> }>;
  accountSelfDelete?: { deleteAccount: (request: { confirm: "DELETE" }, signal?: AbortSignal) => Promise<unknown> };
} | undefined;

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => "ios", isPluginAvailable: () => true },
}));
vi.mock("@cosmaneura-scribe/capacitor-secure-queue", () => ({ SecureQueue: sq }));
vi.mock("./native-backend", () => ({
  connectNativeProviderIOSBackend: vi.fn(async () => ({
    get listEncounters() { return listEncounters; },
    get recoveryScope() { return recoveryScope; },
    openEncounter: vi.fn(), dispose: disposeBackend,
  })),
}));
vi.mock("./application", () => ({
  mountProviderApplication: vi.fn((_r: unknown, host: {
    connect: (s: AbortSignal) => Promise<{ dispose: () => Promise<void> }>;
    accountSelfDelete?: { deleteAccount: (request: { confirm: "DELETE" }, signal?: AbortSignal) => Promise<unknown> };
  }) => {
    captured = host; return async () => undefined;
  }),
}));
vi.mock("./ios-host", () => ({ createProviderIOSHost: vi.fn(() => ({})) }));
vi.mock("./native-plugin", () => ({
  nativeProviderPlugin: { getState, deleteAccount },
}));
vi.mock("./recording-open", () => ({ subscribeIOSRecordingOpen: vi.fn() }));
vi.mock("./native-cancellation", () => ({ nativeScribeCancellation: () => undefined }));
vi.mock("./native-activation", () => ({ activateNativeScribe: vi.fn() }));
vi.mock("./purge-local-clinical", () => ({
  clinicalStoresFromKeys: vi.fn(() => []), purgeLocalClinicalData: vi.fn(),
}));

import { mountNativeProviderIOSApplication } from "./native-application";

function mount() {
  mountNativeProviderIOSApplication({} as HTMLElement, {
    profile: "core-staging-personal-v1", uploadTarget: {} as never,
    core: { createEncounter: vi.fn(), openEncounter: vi.fn() },
  });
}

describe("native-application connect stale-owner clear", () => {
  beforeEach(() => {
    captured = undefined; vi.clearAllMocks();
    recoveryScope = undefined;
    sq.rememberedAccount.mockResolvedValue({});
    sq.setActiveWriteAccount.mockResolvedValue(undefined);
    sq.rememberAccount.mockResolvedValue(undefined);
    listEncounters.mockResolvedValue([]);
    getState.mockResolvedValue({ phase: "signed_out", revision: "rev" });
    deleteAccount.mockResolvedValue({
      status: "deleted", practiceLeftOwnerless: false, clerkIdentityRemoved: true,
    });
  });

  it("setActiveWriteAccount null reject → connect throws; backend disposed", async () => {
    sq.setActiveWriteAccount.mockRejectedValue(new Error("keychain_unavailable"));
    mount();
    await expect(captured!.connect(AbortSignal.timeout(5_000)))
      .rejects.toThrow("provider_session_unavailable");
    expect(sq.setActiveWriteAccount).toHaveBeenCalledWith({ accountId: null });
    expect(disposeBackend).toHaveBeenCalledOnce();
  });

  it("connect after confirmed delete for a new identity remembers scope and sets write owner", async () => {
    getState.mockResolvedValue({ phase: "ready", revision: "rev-a", accountIdentitySHA256: identityA });
    recoveryScope = scopeA;
    mount();
    await captured!.connect(AbortSignal.timeout(5_000));
    expect(sq.rememberAccount).toHaveBeenCalledWith({
      accountId: scopeA, accountIdentitySHA256: identityA,
    });
    expect(sq.setActiveWriteAccount).toHaveBeenCalledWith({ accountId: scopeA });

    sq.rememberAccount.mockClear();
    sq.setActiveWriteAccount.mockClear();
    await captured!.accountSelfDelete!.deleteAccount({ confirm: "DELETE" });
    expect(deleteAccount).toHaveBeenCalledOnce();

    // Same mount, new native identity after confirmed delete must remember again.
    getState.mockResolvedValue({ phase: "ready", revision: "rev-b", accountIdentitySHA256: identityB });
    recoveryScope = scopeB;
    sq.rememberAccount.mockClear();
    sq.setActiveWriteAccount.mockClear();
    await captured!.connect(AbortSignal.timeout(5_000));
    expect(sq.rememberAccount).toHaveBeenCalledWith({
      accountId: scopeB, accountIdentitySHA256: identityB,
    });
    expect(sq.setActiveWriteAccount).toHaveBeenCalledWith({ accountId: scopeB });
  });

  it("second delete after confirm calls neither rememberAccount nor setActiveWriteAccount", async () => {
    getState.mockResolvedValue({ phase: "ready", revision: "rev-a", accountIdentitySHA256: identityA });
    recoveryScope = scopeA;
    mount();
    await captured!.connect(AbortSignal.timeout(5_000));
    sq.rememberAccount.mockClear();
    sq.setActiveWriteAccount.mockClear();

    await captured!.accountSelfDelete!.deleteAccount({ confirm: "DELETE" });
    expect(deleteAccount).toHaveBeenCalledTimes(1);

    // Force a remember-retry path on the second delete: native unavailable + scope present.
    const unavailable = Object.assign(new Error("Clinical account unavailable"), {
      code: "clinical_account_unavailable",
    });
    deleteAccount.mockRejectedValue(unavailable);
    sq.rememberAccount.mockClear();
    sq.setActiveWriteAccount.mockClear();
    await expect(captured!.accountSelfDelete!.deleteAccount({ confirm: "DELETE" }))
      .rejects.toThrow();
    expect(sq.rememberAccount).not.toHaveBeenCalled();
    expect(sq.setActiveWriteAccount).not.toHaveBeenCalled();
  });

  it("writeClinicalAccount aborts SecureQueue writes when delete begins while getState is pending", async () => {
    let releaseState!: (value: { phase: string; revision: string; accountIdentitySHA256: string }) => void;
    const pendingState = new Promise<{ phase: string; revision: string; accountIdentitySHA256: string }>(
      resolve => { releaseState = resolve; },
    );
    getState
      .mockResolvedValueOnce({ phase: "ready", revision: "rev-a", accountIdentitySHA256: identityA })
      .mockImplementationOnce(() => pendingState)
      .mockResolvedValue({ phase: "ready", revision: "rev-a", accountIdentitySHA256: identityA });
    recoveryScope = scopeA;
    mount();
    const connecting = captured!.connect(AbortSignal.timeout(5_000));
    // Wait until catalog remember is blocked inside writeClinicalAccount.getState.
    await vi.waitFor(() => expect(getState).toHaveBeenCalledTimes(2));
    const deleting = captured!.accountSelfDelete!.deleteAccount({ confirm: "DELETE" });
    await vi.waitFor(() => expect(getState).toHaveBeenCalledTimes(3));
    releaseState({ phase: "ready", revision: "rev-a", accountIdentitySHA256: identityA });
    await connecting;
    await deleting;
    // Catalog remember raced with delete begin: no SecureQueue write from that remember.
    expect(sq.rememberAccount).not.toHaveBeenCalled();
    expect(sq.setActiveWriteAccount).not.toHaveBeenCalledWith({ accountId: scopeA });
  });
});
