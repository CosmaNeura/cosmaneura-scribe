export default {
  test: {
    clearMocks: true,
    environment: "node",
    include: ["test-tools/desktop-readiness.benchmark.mjs"],
    passWithNoTests: false,
    restoreMocks: true,
  },
};
