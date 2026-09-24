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
