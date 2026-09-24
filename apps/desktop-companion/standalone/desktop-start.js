/* global document, window */
import { mountDesktopProviderApplication } from "./provider-capture.js";

const root = document.getElementById("scribe-provider");
try {
  if (!root || !window.scribeProvider || !window.scribeRecorder) throw new Error("Host unavailable");
  mountDesktopProviderApplication(root, window.scribeProvider, window.scribeRecorder);
} catch {
  if (root) root.textContent = "Scribe could not open this workspace. Close and reopen the application.";
}
