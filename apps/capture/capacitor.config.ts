import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.cosmaneura.capture",
  appName: "Cosmaneura Capture",
  webDir: "dist",
  loggingBehavior: "none",
  ios: {
    zoomEnabled: true,
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
