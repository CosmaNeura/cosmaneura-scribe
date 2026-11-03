import { expect, it, vi } from "vitest";
import { createDesktopProviderApplicationHost } from "../../capture/src/provider/desktop-application";
import type { DesktopProviderRequest } from "../../capture/src/provider/desktop-host-protocol";
import type { ProviderSessionState } from "../../capture/src/provider/native-plugin";
import { connectDesktopNativeBackend } from "./native-provider-backend.js";
import type { NativeProviderClient } from "./native-provider-client.js";
import { DesktopProviderWorkspaceMain, type DesktopProviderMainHost } from "./provider-workspace-main.js";

async function fixture(environment: "Staging" | "Production", fullNativeVisits: boolean,
  rewriteInfo: (value: Record<string, unknown>) => Record<string, unknown> = value => value) {
  const abort = new AbortController(), revision = crypto.randomUUID();
  const state: ProviderSessionState = { phase: "ready", revision };
  const encounter = { workspaceId: crypto.randomUUID(), appointmentRef: "appointment_01j00000000000000000000000",
    title: "Synthetic visit", detail: "" };
  const catalog = { revision, recoveryScope: crypto.randomUUID(), encounter_creation_v1: true,
    account: { email: "provider@synthetic.invalid" }, environment, encounters: [encounter],
    ...(environment === "Production" ? { existing_patient_visits_v1: true } : {}),
    ...(fullNativeVisits ? { native_visit_actions_v2: true } : {}) };
  const nativeRequest = vi.fn(async (method: string, payload: Record<string, unknown>) => {
    if (method !== "providerRequest" || payload.action !== "catalog") throw Error("No other native operation expected");
    return { status: 200, body: JSON.stringify(catalog) };
  });
  const native = { signal: abort.signal, request: nativeRequest, isReady: () => !abort.signal.aborted,
    getState: async () => state, addListener: async () => ({ remove: async () => undefined }) } as unknown as NativeProviderClient;
  const backend = await connectDesktopNativeBackend(native, { signal: abort.signal, openCore: async () => undefined,
    uploadTarget: { putCompleteEnvelope: async () => { throw Error("No upload expected"); } },
    creationRecords: async () => { throw Error("No saved record access expected during catalog"); } });
  const host: DesktopProviderMainHost = {
    session: { getState: async () => state, signIn: async () => state, signOut: async () => state,
      addListener: async () => ({ remove: async () => undefined }) },
    connect: async signal => ({ dispose: () => backend.dispose(), workspace: {
      signal, listEncounters: extra => backend.listEncounters(extra), createEncounter: extra => backend.createEncounter(extra),
      get encounterSetup() { return backend.encounterSetup; }, get account() { return backend.account; },
      openEncounter: async () => { throw Error("No encounter opening expected"); },
    } }),
  };
  const main = new DesktopProviderWorkspaceMain(host, () => { throw Error("No recorder attachment expected"); });
  await main.initialize();
  const port = { request: async (request: DesktopProviderRequest) => {
    const response = await main.request(request) as { requestId: string; ok: boolean; result: unknown };
    if (request.method === "encounter_setup" && request.payload.action === "info" && response.ok) {
      response.result = rewriteInfo(response.result as Record<string, unknown>);
    }
    return response;
  }, subscribe: (listener: (event: unknown) => void) => main.subscribe(listener) };
  const app = createDesktopProviderApplicationHost(port, {
    request: async () => { throw Error("No recorder operation expected"); }, subscribe: () => () => undefined,
  });
  await app.host.session.getState();
  const connection = await app.host.connect(abort.signal);
  return { connection, nativeRequest, backend, close: async () => { await app.dispose(); await main.dispose(); } };
}

it("loads the full Production catalog through the native backend, main and renderer without the legacy subset marker", async () => {
  const f = await fixture("Production", true);
  try {
    expect(await f.connection.workspace.listEncounters(f.connection.workspace.signal)).toHaveLength(1);
    expect(f.connection.workspace.account).toEqual({ email: "provider@synthetic.invalid", environment: "Production" });
    expect(f.connection.workspace.encounterSetup?.existingPatientOnly).toBeUndefined();
    expect(f.nativeRequest.mock.calls.map(([, value]) => value.action)).toEqual(["catalog"]);
  } finally { await f.close(); }
});

it.each(["Staging", "Production"] as const)("retains the legacy %s setup info contract", async environment => {
  const f = await fixture(environment, false, info => {
    const legacy = { ...info }; delete legacy.environment; return legacy;
  });
  try {
    expect(await f.connection.workspace.listEncounters(f.connection.workspace.signal)).toHaveLength(1);
    expect(f.connection.workspace.account?.environment).toBe(environment);
    expect(f.connection.workspace.encounterSetup?.existingPatientOnly).toBe(environment === "Production" ? true : undefined);
  } finally { await f.close(); }
});

it("rejects an explicit environment that disagrees with the already-validated Production account", async () => {
  const f = await fixture("Production", true, info => ({ ...info, environment: "Staging" }));
  try {
    await expect(f.connection.workspace.listEncounters(f.connection.workspace.signal)).rejects.toThrow();
    expect(f.connection.workspace.account).toBeUndefined();
  } finally { await f.close(); }
});
