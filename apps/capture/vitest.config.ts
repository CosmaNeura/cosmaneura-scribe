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
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary"],
      thresholds: { statements: 65, branches: 60, functions: 70, lines: 70 },
    },
  },
});
