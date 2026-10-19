import { describe, expect, it } from "vitest";
import { requireMacAppStoreRuntime } from "./mac-app-store.js";

describe("dormant Mac App Store runtime", () => {
  it("rejects the matching MAS runtime until compiled Apple custody is approved", () => {
    expect(() => requireMacAppStoreRuntime({ mas: true, electron: "44.4.3", node: "24.19.0" })).toThrow("mac_app_store_distribution_unavailable");
  });
  it("never accepts the direct runtime or environment values as a distribution switch", () => {
    expect(() => requireMacAppStoreRuntime({ electron: "44.4.3", node: "24.19.0" })).toThrow();
    expect(() => requireMacAppStoreRuntime({ mas: false, electron: "44.4.3", node: "24.19.0" })).toThrow();
  });
  it("rejects mismatched Electron and Node versions", () => {
    expect(() => requireMacAppStoreRuntime({ mas: true, electron: "45.0.0", node: "24.19.0" })).toThrow();
    expect(() => requireMacAppStoreRuntime({ mas: true, electron: "44.4.3", node: "22.0.0" })).toThrow();
  });
});
