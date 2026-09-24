import { app, safeStorage, shell } from "electron";
import { openStandaloneProvider } from "../src/standalone-provider.js";
export function openProvider({ userDataDirectory, diagnostics }) {
  return openStandaloneProvider({ packageDirectory: app.getAppPath(), userDataDirectory,
    diagnostics, protection: safeStorage, openExternal: url => shell.openExternal(url) });
}
