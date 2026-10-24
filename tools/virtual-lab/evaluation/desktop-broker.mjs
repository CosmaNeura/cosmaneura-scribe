import { createDesktopProviderApplicationHost } from "../../../apps/capture/src/provider/desktop-application.ts";

/** Concrete adapter for an already-authorized isolated DesktopProviderPort.
 * Only opens the selected completed synthetic visit; no account/login/recording creation.
 * The parent supplies ports from the actual preload, plus the independent silence result.
 */
export function createDesktopBroker({ providerPort, recorderPort, selected, readSilenceResult }) {
  return {
    executionKind: "authorized-native-core",
    async openSyntheticSession({ caseId, fixtureManifest, signal }) {
      if (caseId !== selected.caseId || selected.syntheticOnly !== true || selected.consentVerified !== true)
        throw new Error("synthetic_selection_required");
      const application = createDesktopProviderApplicationHost(providerPort, recorderPort);
      let connection;
      try {
        if ((await application.host.session.getState()).phase !== "ready") throw new Error("native_session_required");
        connection = await application.host.connect(signal);
        const mount = await connection.workspace.openEncounter(selected.appointmentRef, signal);
        return {
          ...selected, request: mount.request, scope: mount.scope, nativeSession: application.host.session,
          readSilenceResult: args => readSilenceResult({ ...args, fixtureManifest }),
          close: async () => { await connection.dispose(); await application.dispose(); },
        };
      } catch {
        if (connection) await connection.dispose();
        await application.dispose();
        throw new Error("native_synthetic_scope_unavailable");
      }
    },
  };
}
