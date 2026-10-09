import { app, safeStorage, shell } from "electron";
import { openStandaloneProvider } from "../src/standalone-provider.js";
export function openProvider({ userDataDirectory, diagnostics, recordingWindow }) {
  return openStandaloneProvider({ packageDirectory: app.getAppPath(), userDataDirectory,
    diagnostics, recordingWindow, protection: safeStorage, openExternal: url => shell.openExternal(url) });
}
