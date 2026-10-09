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
      thresholds: { statements: 69, branches: 66, functions: 70, lines: 76 },
    },
  },
});
