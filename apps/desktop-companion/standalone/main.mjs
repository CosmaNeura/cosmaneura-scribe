import { app, BrowserWindow, dialog, ipcMain, protocol, screen, session } from "electron";
import { startElectronProvider } from "../src/electron-provider-host.js";

// This source is bundled for the reviewed runtime. It is not a Node CLI and
// never selects a backend module, environment or executable from argv/env.
async function start() {
  if (process.versions.electron !== "44.4.3" || !process.versions.node.startsWith("24.")) throw new Error("Runtime unavailable");
  await startElectronProvider({ app, BrowserWindow, dialog, ipcMain, protocol, screen, session }, {
    open: async options => {
      const { openProvider } = await import("./provider-host.mjs");
      return openProvider(options);
    },
  });
}
void start().catch(() => {
  dialog.showErrorBox("Scribe could not open", "The installed Scribe application or its provider configuration is unavailable.");
  app.quit();
});
