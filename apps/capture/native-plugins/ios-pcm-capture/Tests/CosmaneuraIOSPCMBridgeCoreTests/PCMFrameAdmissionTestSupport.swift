@testable import CosmaneuraIOSPCMCore

/// Test-only admission that runs an async body then publishes consumption.
/// Production code uses `PCMFrameAdmission(accepted:release:)` from the core.
extension PCMFrameAdmission {
  init(
    consuming body: @escaping @Sendable () async -> Void,
    release: (@Sendable () -> Void)? = nil
  ) {
    self.init(accepted: true, release: release)
    let admission = self
    Task {
      await body()
      admission.finishConsumption()
    }
  }
}
