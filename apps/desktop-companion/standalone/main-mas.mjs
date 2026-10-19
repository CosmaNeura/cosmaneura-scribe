import { app, BrowserWindow, dialog, ipcMain, protocol, screen, session } from "electron";
import { startElectronProvider } from "../src/electron-provider-host.js";
import { requireMacAppStoreRuntime } from "../src/mac-app-store.js";

// Only the build target selects this entry. Store activation is a reviewed
// compiled identity change; this cannot select a new backend or credential.
async function start() {
  requireMacAppStoreRuntime({ mas: process.mas, electron: process.versions.electron, node: process.versions.node });
  await startElectronProvider({ app, BrowserWindow, dialog, ipcMain, protocol, screen, session }, {
    open: async options => {
      const { openProvider } = await import("./provider-host.mjs");
      return openProvider(options);
    },
  });
}
void start().catch(() => {
  dialog.showErrorBox("Scribe could not open", "The Mac App Store distribution has not been approved for this application.");
  app.quit();
});
