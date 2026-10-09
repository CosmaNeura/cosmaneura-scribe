import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary"],
      thresholds: { statements: 28, branches: 29, functions: 39, lines: 31 },
    },
  },
});
