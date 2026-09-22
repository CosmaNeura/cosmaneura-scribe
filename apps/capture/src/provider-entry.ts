import "./capture-app";
import type { CaptureApp } from "./capture-app";
import type { ProviderCaptureBinding } from "./provider-binding";
import "./styles.css";

/** Mount the retained recorder, with review after upload, in the authorized host. */
export function mountProviderCapture(root: HTMLElement, binding: ProviderCaptureBinding): () => void {
  const app = document.createElement("cosmaneura-capture") as CaptureApp;
  app.bindProvider(binding);
  root.replaceChildren(app);
  return () => app.remove();
}

export type { ProviderCaptureBinding } from "./provider-binding";
export { NativeCreatorReviewJournal } from "../../review-ui/src/native-review-journal";
export { mountProviderWorkspace } from "./provider/workspace";
export type { ProviderWorkspaceHost, AuthorizedProviderEncounter, ProviderEncounter,
  ProviderRecorderResources } from "./provider/workspace";
export { NativeProviderWorkspaceJournal } from "./provider/workspace-journal";
export type { ProviderWorkspaceJournal, JournalSnapshot, ProviderProgress } from "./provider/workspace-journal";
export type { AuthorizedCoreRequest, CoreCaptureScope } from "./provider/core-client";
export { createProviderIOSCaptureSource } from "./provider/ios-capture-source";
export { createProviderIOSHost } from "./provider/ios-host";
export type { ProviderIOSBackend, AuthorizedProviderIOSMount } from "./provider/ios-host";
export { connectNativeProviderIOSBackend } from "./provider/native-backend";
export type { NativeProviderBackend, NativeProviderOptions } from "./provider/native-backend";
