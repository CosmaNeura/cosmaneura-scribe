import { expect, it } from "vitest";
import { requireMacAppStoreXpcRuntime } from "./mac-app-store-xpc.js";

it("rejects direct Electron and mismatched vendor runtimes", () => {
  for (const runtime of [
    { electron: "44.4.3", node: "24.19.0" },
    { mas: false, electron: "44.4.3", node: "24.19.0" },
    { mas: true, electron: "44.4.2", node: "24.19.0" },
    { mas: true, electron: "44.4.3", node: "25.0.0" },
  ]) expect(() => requireMacAppStoreXpcRuntime(runtime)).toThrow("mac_app_store_xpc_distribution_unavailable");
});
it("reaches the separately validated native boundary with the official MAS runtime", () => {
  expect(() => requireMacAppStoreXpcRuntime({ mas: true, electron: "44.4.3", node: "24.19.0" })).not.toThrow();
});
