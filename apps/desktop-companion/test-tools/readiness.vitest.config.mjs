export default {
  test: {
    clearMocks: true,
    environment: "node",
    include: ["test-tools/desktop-readiness.benchmark.mjs", "test-tools/desktop-readiness-native-model.test.mjs"],
    passWithNoTests: false,
    restoreMocks: true,
  },
};
