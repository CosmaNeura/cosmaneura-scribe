import { app, BrowserWindow, dialog, ipcMain, protocol, screen, session } from "electron";
import { registerPackagedAppScheme, startElectronProvider } from "../src/electron-provider-host.js";
import { prepareMacAppStoreUserData, requireMacAppStoreXpcRuntime } from "../src/mac-app-store-xpc.js";
import { recordRejectedStoreAcquisition, StoreBootstrapDiagnostics } from "../src/store-bootstrap-diagnostics.js";

const bootstrap = new StoreBootstrapDiagnostics();

// Only the build target selects this entry. This entry requires the official
// MAS runtime and independently sandboxed private XPC services. No backend or
// credential is selected by this entry.
async function start() {
  requireMacAppStoreXpcRuntime({ mas: process.mas, electron: process.versions.electron, node: process.versions.node });
  // Electron requires this once, before readiness can advance during path I/O.
  bootstrap.enter(11);
  registerPackagedAppScheme(protocol);
  // The Store parent uses its isolated Mach/group identity and retains its own
  // durable records/preferences. Never open the direct app's userData.
  bootstrap.enter(2);
  const appData = app.getPath("appData");
  bootstrap.enter(3);
  const storeUserData = await prepareMacAppStoreUserData(appData);
  bootstrap.bindValidatedDirectory(storeUserData);
  bootstrap.enter(4);
  app.setPath("userData", storeUserData);
  bootstrap.enter(5);
  await startElectronProvider({ app, BrowserWindow, dialog, ipcMain, protocol, screen, session }, {
    open: async options => recordRejectedStoreAcquisition(bootstrap, async () => {
      bootstrap.enter(6);
      const { openProvider } = await import("./provider-host.mjs");
      bootstrap.enter(7);
      const owner = await openProvider({ ...options, diagnostics: (event, milliseconds, reason) => {
        bootstrap.observeBridge(event, reason);
        options.diagnostics?.(event, milliseconds, reason);
      } });
      bootstrap.enter(8);
      return owner;
    }),
  }, "Cosmaneura Scribe Store", stage => bootstrap.enter(stage));
}
void start().catch(async () => {
  await bootstrap.failed();
  dialog.showErrorBox("Scribe could not open", "The Mac App Store runtime or its private native services are unavailable.");
  app.quit();
});
