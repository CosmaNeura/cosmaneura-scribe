import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    exclude: [
      ...configDefaults.exclude,
      "native-plugins/**",
      "android/**",
      "ios/**",
      // These suites use node:test and run through test:tools, not Vitest.
      "e2e/support/timing-reporter.test.mjs",
      "test-tools/iphone-performance/cli.test.mjs",
    ],
    passWithNoTests: false,
    restoreMocks: true,
  },
});
