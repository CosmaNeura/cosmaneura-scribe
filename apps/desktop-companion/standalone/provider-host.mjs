import { app, safeStorage, shell } from "electron";
import { openStandaloneProvider } from "../src/standalone-provider.js";
export function openProvider({ userDataDirectory }) {
  return openStandaloneProvider({ packageDirectory: app.getAppPath(), userDataDirectory,
    protection: safeStorage, openExternal: url => shell.openExternal(url) });
}
