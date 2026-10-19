import { app, BrowserWindow, dialog, ipcMain, protocol, screen, session } from "electron";
import { startElectronProvider } from "../src/electron-provider-host.js";
import { requireMacAppStoreXpcRuntime } from "../src/mac-app-store-xpc.js";

// Only the build target selects this entry. This entry requires the official
// MAS runtime and independently sandboxed private XPC services. No backend or
// credential is selected by this entry.
async function start() {
  requireMacAppStoreXpcRuntime({ mas: process.mas, electron: process.versions.electron, node: process.versions.node });
  await startElectronProvider({ app, BrowserWindow, dialog, ipcMain, protocol, screen, session }, {
    open: async options => {
      const { openProvider } = await import("./provider-host.mjs");
      return openProvider(options);
    },
  });
}
void start().catch(() => {
  dialog.showErrorBox("Scribe could not open", "The Mac App Store runtime or its private native services are unavailable.");
  app.quit();
});
