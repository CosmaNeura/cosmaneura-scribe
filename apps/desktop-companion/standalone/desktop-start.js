/* global document, window */
import { mountDesktopProviderApplication, BETA_CONSENT_PREPARATION } from "./provider-capture.js";

const root = document.getElementById("scribe-provider");
try {
  if (!root || !window.scribeProvider || !window.scribeRecorder) throw new Error("Host unavailable");
  mountDesktopProviderApplication(root, window.scribeProvider, window.scribeRecorder, BETA_CONSENT_PREPARATION);
} catch {
  if (root) root.textContent = "Scribe could not open this workspace. Close and reopen the application.";
}

// A visible app action also works when macOS titlebar controls are out of view.
// Main owns shutdown. Renderer window.close() can bypass its close event.
const closeScribe = document.createElement("button");
closeScribe.type = "button";
closeScribe.className = "scribe-desktop-close";
closeScribe.textContent = "Close Scribe";
closeScribe.addEventListener("click", () => {
  const workspace = root?.querySelector(".provider-workspace");
  const close = () => {
    void window.scribeApplication.close().catch(() => {
      closeScribe.textContent = "Retry closing Scribe";
    });
  };
  // The current editor may defer closing for its existing unsaved-edits dialog.
  if (!workspace || workspace.dispatchEvent(new CustomEvent("scribe-desktop-close-request", {
    cancelable: true, detail: close,
  }))) close();
});
(root?.querySelector(".provider-session-header") ?? root ?? document.body).append(closeScribe);
