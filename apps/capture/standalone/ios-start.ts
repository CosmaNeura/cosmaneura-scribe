import { nativeProviderPlugin as native } from "../src/provider/native-plugin";
import { mountProviderStartup } from "../src/provider/startup";

const root = document.getElementById("app");
if (!root) throw new Error("Provider root is unavailable.");
const dispose = mountProviderStartup(root, {
  configuration: () => native.getProviderConfiguration(),
  // Start the local native read before parsing the recording/review bundle.
  // Both must finish successfully before the existing application can mount.
  application: () => import("./ios-workspace"),
});
window.addEventListener("pagehide", () => { void dispose().catch(() => undefined); }, { once: true });
