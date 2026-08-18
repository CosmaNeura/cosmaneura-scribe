import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    exclude: [...configDefaults.exclude, "native-plugins/**", "android/**", "ios/**"],
    passWithNoTests: false,
    restoreMocks: true,
  },
});
