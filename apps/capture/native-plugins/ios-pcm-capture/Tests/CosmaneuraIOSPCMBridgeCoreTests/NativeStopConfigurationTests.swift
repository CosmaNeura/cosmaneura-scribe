import Foundation
import Testing
@testable import CosmaneuraIOSPCMCore
@testable import CosmaneuraIOSAVFoundationDriver

struct NativeStopConfigurationTests {
  @Test func ordinaryNativeStopPreservesPartialTail() async throws {
    let result = try await runNativeStop(nil)
    #expect(result.bytes == 64 && result.failures.isEmpty)
  }
  @Test func deactivationConfigurationNotificationMustNotDestroyAlreadyCapturedTail() async throws {
    let result = try await runNativeStop(.configurationChanged)
    #expect(result.bytes == 64 && result.failures.isEmpty)
  }
  @Test func unexpectedActiveConfigurationChangeStillDestroysTail() async throws {
    let result = try await runNativeStop(.configurationChanged, beforeStop: true)
    #expect(result.bytes == nil && !result.failures.isEmpty && result.failures.allSatisfy { $0 == .captureFailed })
  }
  @Test func realPermissionRevocationStillDestroysPendingTail() async throws {
    let result = try await runNativeStop(.permissionRevoked)
    #expect(result.bytes == nil && !result.failures.isEmpty && result.failures.allSatisfy { $0 == .permissionRevoked })
  }

  @Test(arguments: [AppleAudioSystemEvent.captureFailed, .mediaServicesLost, .mediaServicesReset])
  func realCaptureFailureAfterFreezeStillDestroysPendingTail(_ event: AppleAudioSystemEvent) async throws {
    let result = try await runNativeStop(event)
    #expect(result.bytes == nil && !result.failures.isEmpty
      && result.failures.allSatisfy { $0 == .captureFailed })
  }

  @Test func failedDeactivationRetainsOwnershipAndCanRetryWithoutLosingTail() async throws {
    let result = try await runNativeStop(.configurationChanged, failFirstDeactivation: true)
    #expect(result.bytes == 64 && result.failures.isEmpty)
  }

  @Test func permissionRevocationDuringDeactivationRetryStillDestroysTail() async throws {
    let result = try await runNativeStop(.configurationChanged, failFirstDeactivation: true,
      retryNotification: .permissionRevoked)
    #expect(result.bytes == nil && !result.failures.isEmpty
      && result.failures.allSatisfy { $0 == .permissionRevoked })
  }
}

private func runNativeStop(_ notification: AppleAudioSystemEvent?, beforeStop: Bool = false,
  failFirstDeactivation: Bool = false, retryNotification: AppleAudioSystemEvent? = nil) async throws
  -> (bytes: Int?, failures: [PCMTerminationCode]) {
  // Explicit synthetic consent; invented32-frame PCM. No OS audio, network or storage.
  let consent = ProbeConsent()
  try #require(consent.allPartiesConsented)
  let system = StopProbeSystem(beforeStop ? nil : notification,
    failFirstDeactivation: failFirstDeactivation, retryNotification: retryNotification)
  let sink = StopProbeSink()
  let driver = AVFoundationPCMDriver(system: system, foreground: ProbeForeground(), lifecycle: .nativeEncrypted)
  let core = IOSPCMCore(permission: consent, audio: driver, sink: sink)
  let authority = try PCMSourceAuthority(runID: UUID().uuidString.lowercased(), generation: 1,
    expiresAtMilliseconds: Int64(Date().timeIntervalSince1970 * 1000) + 60_000, hardMaximumChunks: 2)
  let session = try core.start(configuration: PCMConfiguration(targetFramesPerChunk: 64,
    maximumChunks: 2, maximumInputFramesPerBuffer: 64, authority: authority, preserveInterruptedTail: true))
  try await session.ready()
  let frames = OwnedAudioFrames(sampleRateHz: 16_000, channels: [Array(repeating: Float(0.125), count: 32)])
  system.offer(frames)
  let deadline = ContinuousClock.now + .seconds(2)
  while session.capturedAudioFrames != 32 && ContinuousClock.now < deadline {
    try await Task.sleep(for: .milliseconds(1))
  }
  try #require(session.capturedAudioFrames == 32 && frames.isZeroed)
  if beforeStop, let notification { system.emit(notification) }
  if failFirstDeactivation {
    do {
      _ = try await session.stop(.drain)
      Issue.record("Failed deactivation must not confirm physical release")
    } catch let failure as PCMFailure {
      #expect(failure.code == .stopFailed)
    }
    #expect(system.sequence == ["freeze", "deactivate"])
    #expect(throws: PCMFailure.self) {
      try core.start(configuration: PCMConfiguration(targetFramesPerChunk: 64,
        maximumChunks: 2, maximumInputFramesPerBuffer: 64))
    }
  }
  let stopped = try await session.stop(.drain)
  let bytes = stopped.finalPacket?.bytes.count
  stopped.finalPacket?.bytes.zeroize()
  #expect(system.sequence == (failFirstDeactivation
    ? ["freeze", "deactivate", "deactivate", "clear"] : ["freeze", "deactivate", "clear"]))
  return (bytes, sink.failures)
}
private struct ProbeConsent: MicrophonePermissionAuthorizing {
  let allPartiesConsented = true
  let consentRecordID = UUID()
  func requestPermission(cancellation: StartupCancellation) async -> MicrophonePermission {
    allPartiesConsented && !cancellation.isCancelled ? .granted : .unavailable
  }
}
private struct ProbeForeground: AppleApplicationForegroundProviding {
  func isForegroundActive() async -> Bool { true }
}
private final class StopProbeSystem: AppleAudioSystem, @unchecked Sendable {
  private let lock = NSLock()
  private var event: (@Sendable (AppleAudioSystemEvent) -> Void)?
  private var frames: (@Sendable (OwnedAudioFrames) -> Void)?
  private var operations: [String] = []
  private let notification: AppleAudioSystemEvent?
  private let failFirstDeactivation: Bool
  private let retryNotification: AppleAudioSystemEvent?
  private var deactivations = 0
  init(_ notification: AppleAudioSystemEvent?, failFirstDeactivation: Bool = false,
    retryNotification: AppleAudioSystemEvent? = nil) {
    self.notification = notification
    self.failFirstDeactivation = failFirstDeactivation
    self.retryNotification = retryNotification
  }
  var sequence: [String] { lock.withLock { operations } }
  func setEventHandler(_ handler: @escaping @Sendable (AppleAudioSystemEvent) -> Void) {
    lock.withLock { event = handler }
  }
  func clearEventHandler() { lock.withLock { operations.append("clear"); event = nil } }
  func configureAndActivate(profile: AppleAudioSessionProfile) throws {}
  func installInputTap(frameCapacity: UInt32, handler: @escaping @Sendable (OwnedAudioFrames) -> Void) throws {
    lock.withLock { frames = handler }
  }
  func startEngine() throws {}
  func offer(_ value: OwnedAudioFrames) { lock.withLock { frames }?(value) }
  func emit(_ value: AppleAudioSystemEvent) { lock.withLock { event }?(value) }
  func freezeInput() throws { lock.withLock { operations.append("freeze"); frames = nil } }
  func deactivate() throws {
    let current = lock.withLock { () -> ((@Sendable (AppleAudioSystemEvent) -> Void)?, Bool,
      AppleAudioSystemEvent?) in
      operations.append("deactivate")
      deactivations += 1
      return (event, failFirstDeactivation && deactivations == 1,
        deactivations == 1 ? notification : (retryNotification ?? notification))
    }
    if let notification = current.2 { current.0?(notification) }
    if current.1 { throw AVFoundationDriverError.operationFailed }
  }
}
private final class StopProbeSink: PCMEmissionSink, @unchecked Sendable {
  private let lock = NSLock()
  private var values: [PCMTerminationCode] = []
  var failures: [PCMTerminationCode] { lock.withLock { values } }
  func terminated(_ code: PCMTerminationCode) { lock.withLock { values.append(code) } }
  func emit(_ packet: PCMEncodedPacket) throws -> any PCMAcknowledging {
    struct Ack: PCMAcknowledging {
      func wait() async -> PCMAcknowledgementResult { .accepted }
      func cancel() {}
    }
    return Ack()
  }
}
