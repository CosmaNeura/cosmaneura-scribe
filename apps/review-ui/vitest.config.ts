import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: false,
    restoreMocks: true,
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary"],
      thresholds: { statements: 54, branches: 54, functions: 76, lines: 57 },
    },
  },
});
