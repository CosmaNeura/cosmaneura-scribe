import "../src/styles.css";
import { nativeProviderPlugin as native } from "../src/provider/native-plugin";
import { mountNativeProviderIOSApplication } from "../src/provider/native-application";
import { HttpCiphertextUploadTarget } from "../src/bff/upload-target";

async function start(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("Provider root is unavailable.");
  const configuration = await native.getProviderConfiguration();
  if (!configuration.enabled) { root.textContent = "Scribe is not enabled for this build."; return; }
  if (configuration.coreOrigin !== "https://staging-app.cosmaneura.com"
    || configuration.uploadOrigins.length !== 1
    || !/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net$/u.test(configuration.uploadOrigins[0]!)) throw new Error("Provider configuration is unavailable.");
  const dispose = mountNativeProviderIOSApplication(root, {
    uploadTarget: new HttpCiphertextUploadTarget(configuration.uploadOrigins, fetch, "azure_block_blob"),
    core: {
      createEncounter: signal => { signal.throwIfAborted(); return native.openProviderCore({ appointmentRef: null }); },
      openEncounter: (appointmentRef, _note, signal) => { signal.throwIfAborted(); return native.openProviderCore({ appointmentRef }); },
    },
  });
  window.addEventListener("pagehide", () => { void dispose().catch(() => undefined); }, { once: true });
}
void start().catch(() => {
  const root = document.getElementById("app");
  if (root) root.textContent = "Scribe could not open. Close the app and try again.";
});
