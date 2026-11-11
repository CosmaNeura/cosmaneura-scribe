import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, screen, session } from "electron";
import { registerPackagedAppScheme, startElectronProvider } from "../src/electron-provider-host.js";
import { MacAppStoreSingletonTemp, prepareMacAppStoreUserData, requireMacAppStoreXpcRuntime } from "../src/mac-app-store-xpc.js";
import { recordRejectedStoreAcquisition, StoreBootstrapDiagnostics } from "../src/store-bootstrap-diagnostics.js";
import { installPublicMacPresentation } from "../src/public-app-release.js";
import { shouldRetryStoreLaunch, STORE_LAUNCH_FAILURE } from "../src/store-launch-recovery.js";

installPublicMacPresentation(app, Menu, "Apple distribution");

// Only the build target selects this entry. This entry requires the official
// MAS runtime and independently sandboxed private XPC services. No backend or
// credential is selected by this entry.
async function start(bootstrap) {
  requireMacAppStoreXpcRuntime({ mas: process.mas, electron: process.versions.electron, node: process.versions.node });
  bootstrap.enter(18);
  MacAppStoreSingletonTemp.requireNoInheritedOverride();
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
  bootstrap.enter(18);
  const singletonTemp = await MacAppStoreSingletonTemp.prepare(app.getPath("temp"));
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
  }, "Cosmaneura Scribe Store", stage => bootstrap.enter(stage), singletonTemp);
}

async function run() {
  for (;;) {
    const bootstrap = new StoreBootstrapDiagnostics();
    try {
      await start(bootstrap);
      return;
    } catch {
      await bootstrap.failed();
      const result = await dialog.showMessageBox({
        type: "error",
        message: STORE_LAUNCH_FAILURE.message,
        detail: STORE_LAUNCH_FAILURE.detail,
        buttons: [...STORE_LAUNCH_FAILURE.buttons],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (!shouldRetryStoreLaunch(result.response)) {
        app.quit();
        return;
      }
    }
  }
}
void run();
