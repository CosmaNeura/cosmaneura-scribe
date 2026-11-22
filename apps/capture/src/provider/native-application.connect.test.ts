import { beforeEach, describe, expect, it, vi } from "vitest";

const sq = vi.hoisted(() => ({
  migrateAccounts: vi.fn(async () => undefined), rememberedAccount: vi.fn(async () => ({})),
  setActiveWriteAccount: vi.fn(async () => undefined), rememberAccount: vi.fn(async () => undefined),
  list: vi.fn(async () => ({ keys: [] })), delete: vi.fn(async () => undefined),
  wipeAccount: vi.fn(async () => ({ cleared: 0, remaining: 0 })),
}));
const disposeBackend = vi.hoisted(() => vi.fn(async () => undefined));
const listEncounters = vi.hoisted(() => vi.fn(async () => []));
let captured: { connect: (signal: AbortSignal) => Promise<unknown> } | undefined;

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => "ios", isPluginAvailable: () => true },
}));
vi.mock("@cosmaneura-scribe/capacitor-secure-queue", () => ({ SecureQueue: sq }));
vi.mock("./native-backend", () => ({
  connectNativeProviderIOSBackend: vi.fn(async () => ({
    listEncounters, recoveryScope: undefined, openEncounter: vi.fn(), dispose: disposeBackend,
  })),
}));
vi.mock("./application", () => ({
  mountProviderApplication: vi.fn((_r: unknown, host: { connect: (s: AbortSignal) => Promise<unknown> }) => {
    captured = host; return async () => undefined;
  }),
}));
vi.mock("./ios-host", () => ({ createProviderIOSHost: vi.fn(() => ({})) }));
vi.mock("./native-plugin", () => ({
  nativeProviderPlugin: { getState: vi.fn(async () => ({ phase: "signed_out" })) },
}));
vi.mock("./recording-open", () => ({ subscribeIOSRecordingOpen: vi.fn() }));
vi.mock("./native-cancellation", () => ({ nativeScribeCancellation: () => undefined }));
vi.mock("./native-activation", () => ({ activateNativeScribe: vi.fn() }));
vi.mock("./purge-local-clinical", () => ({
  clinicalStoresFromKeys: vi.fn(() => []), purgeLocalClinicalData: vi.fn(),
}));

import { mountNativeProviderIOSApplication } from "./native-application";

describe("native-application connect stale-owner clear", () => {
  beforeEach(() => {
    captured = undefined; vi.clearAllMocks();
    sq.rememberedAccount.mockResolvedValue({});
    sq.setActiveWriteAccount.mockResolvedValue(undefined);
    listEncounters.mockResolvedValue([]);
  });

  it("setActiveWriteAccount null reject → connect throws; backend disposed", async () => {
    sq.setActiveWriteAccount.mockRejectedValue(new Error("keychain_unavailable"));
    mountNativeProviderIOSApplication({} as HTMLElement, {
      profile: "core-staging-personal-v1", uploadTarget: {} as never,
      core: { createEncounter: vi.fn(), openEncounter: vi.fn() },
    });
    await expect(captured!.connect(AbortSignal.timeout(5_000)))
      .rejects.toThrow("provider_session_unavailable");
    expect(sq.setActiveWriteAccount).toHaveBeenCalledWith({ accountId: null });
    expect(disposeBackend).toHaveBeenCalledOnce();
  });
});
