import Foundation
import Testing
@testable import CosmaneuraIOSPCMCore
@testable import CosmaneuraIOSAVFoundationDriver

@Suite(.timeLimit(.minutes(1)))
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

  /// Guards confirm-after-successful-freeze ordering. Revert kill: move
  /// confirmInputFrozen ahead of a freezeInput that can still fail.
  @Test func notificationDuringFailedFreezeDestroysTail() async throws {
    let result = try await runNativeStop(.configurationChanged, failFirstFreeze: true,
      freezeNotification: .configurationChanged)
    #expect(result.bytes == nil && !result.failures.isEmpty
      && result.failures.allSatisfy { $0 == .captureFailed })
  }

  @Test func cleanRetryAfterFailedFreezePreservesTail() async throws {
    let result = try await runNativeStop(nil, failFirstFreeze: true)
    #expect(result.bytes == 64 && result.failures.isEmpty)
  }

  @Test func notificationAfterSuccessfulFreezeRetryIsSwallowed() async throws {
    let result = try await runNativeStop(.configurationChanged, failFirstFreeze: true)
    #expect(result.bytes == 64 && result.failures.isEmpty)
  }

  /// Guards inputFrozen reset on activate. Revert kill: delete inputFrozen = false
  /// in DriverCallbackGate.activate.
  @Test func secondSessionActiveConfigurationChangeFailsClosedWithoutTail() async throws {
    // Explicit synthetic consent; invented 32-frame PCM. No OS audio, network or storage.
    let consent = ProbeConsent()
    try #require(consent.allPartiesConsented)
    let system = StopProbeSystem(nil)
    let sink = StopProbeSink()
    let driver = AVFoundationPCMDriver(
      system: system, foreground: ProbeForeground(), lifecycle: .nativeEncrypted)
    let core = IOSPCMCore(permission: consent, audio: driver, sink: sink)

    let firstAuthority = try PCMSourceAuthority(
      runID: UUID().uuidString.lowercased(), generation: 1,
      expiresAtMilliseconds: Int64(Date().timeIntervalSince1970 * 1000) + 60_000,
      hardMaximumChunks: 2)
    let first = try core.start(configuration: PCMConfiguration(
      targetFramesPerChunk: 64, maximumChunks: 2, maximumInputFramesPerBuffer: 64,
      authority: firstAuthority, preserveInterruptedTail: true))
    try await first.ready()
    let firstFrames = OwnedAudioFrames(
      sampleRateHz: 16_000, channels: [Array(repeating: Float(0.125), count: 32)])
    system.offer(firstFrames)
    try await PCMTestWait.until("second-session first capture") {
      first.capturedAudioFrames == 32 && firstFrames.isZeroed
    }
    let firstStopped = try await PCMTestWait.withDeadline("second-session first stop") {
      try await first.stop(.drain)
    }
    #expect(firstStopped.finalPacket?.bytes.count == 64)
    firstStopped.finalPacket?.bytes.zeroize()
    #expect(sink.failures.isEmpty)

    let secondAuthority = try PCMSourceAuthority(
      runID: UUID().uuidString.lowercased(), generation: 1,
      expiresAtMilliseconds: Int64(Date().timeIntervalSince1970 * 1000) + 60_000,
      hardMaximumChunks: 2)
    let second = try core.start(configuration: PCMConfiguration(
      targetFramesPerChunk: 64, maximumChunks: 2, maximumInputFramesPerBuffer: 64,
      authority: secondAuthority, preserveInterruptedTail: true))
    try await second.ready()
    let secondFrames = OwnedAudioFrames(
      sampleRateHz: 16_000, channels: [Array(repeating: Float(0.125), count: 32)])
    system.offer(secondFrames)
    try await PCMTestWait.until("second-session second capture") {
      second.capturedAudioFrames == 32 && secondFrames.isZeroed
    }

    system.emit(.configurationChanged)
    try await PCMTestWait.until("second-session captureFailed") { !sink.failures.isEmpty }
    #expect(sink.failures == [.captureFailed])
    let secondStopped = try await PCMTestWait.withDeadline("second-session second stop") {
      try await second.stop(.drain)
    }
    #expect(secondStopped.finalPacket == nil)
  }
}

/// Guards confirmInputFrozen generation matching. Revert kill: remove the
/// generation guard inside confirmInputFrozen.
@Suite(.timeLimit(.minutes(1)))
struct DriverCallbackGateGenerationTests {
  @Test func confirmInputFrozenWithStaleGenerationIsNoOp() async throws {
    let consent = (allPartiesConsented: true, recordID: UUID())
    try #require(consent.allPartiesConsented)
    let failures = GateFailures()
    let gate = DriverCallbackGate(continueInBackground: true, diagnostics: PCMStartupDiagnostics())
    gate.activate(generation: 1, callbacks: PCMAudioCallbacks(
      frames: { frames in
        frames.zeroize()
        return PCMFrameAdmission(accepted: false)
      },
      event: { failures.record($0) },
      invalidate: { failures.invalidate($0) }
    ))
    try #require(gate.arm(generation: 1))
    gate.freezeFrames(generation: 1)
    // Stale confirmation must not arm preservation for this generation.
    gate.confirmInputFrozen(generation: 99)
    gate.receive(event: .configurationChanged, generation: 1)
    try await PCMTestWait.until("stale-generation captureFailed") { failures.count > 0 }
    #expect(failures.count == 1 && failures.invalidations == 1)
    #expect(failures.last == .captureFailed)
    gate.freezeFrames(generation: 1)
    if let terminal = gate.retireAdmission(generation: 1) {
      try await PCMTestWait.withDeadline("stale-generation retireAdmission") { await terminal.value }
    }
  }
}

private func runNativeStop(_ notification: AppleAudioSystemEvent?, beforeStop: Bool = false,
  failFirstDeactivation: Bool = false, retryNotification: AppleAudioSystemEvent? = nil,
  failFirstFreeze: Bool = false, freezeNotification: AppleAudioSystemEvent? = nil) async throws
  -> (bytes: Int?, failures: [PCMTerminationCode]) {
  // Explicit synthetic consent; invented32-frame PCM. No OS audio, network or storage.
  let consent = ProbeConsent()
  try #require(consent.allPartiesConsented)
  let system = StopProbeSystem(beforeStop ? nil : notification,
    failFirstDeactivation: failFirstDeactivation, retryNotification: retryNotification,
    failFirstFreeze: failFirstFreeze, freezeNotification: freezeNotification)
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
  try await PCMTestWait.until("native-stop capture") {
    session.capturedAudioFrames == 32 && frames.isZeroed
  }
  if beforeStop, let notification { system.emit(notification) }
  if failFirstDeactivation || failFirstFreeze {
    do {
      _ = try await PCMTestWait.withDeadline("native-stop failed first stop") {
        try await session.stop(.drain)
      }
      Issue.record("Failed freeze/deactivation must not confirm physical release")
    } catch let failure as PCMFailure {
      #expect(failure.code == .stopFailed)
    } catch is PCMTestWait.TimeoutError {
      Issue.record("Failed freeze/deactivation stop timed out")
    }
    if failFirstFreeze {
      #expect(system.sequence == ["freeze"])
    } else {
      #expect(system.sequence == ["freeze", "deactivate"])
    }
    #expect(throws: PCMFailure.self) {
      try core.start(configuration: PCMConfiguration(targetFramesPerChunk: 64,
        maximumChunks: 2, maximumInputFramesPerBuffer: 64))
    }
  }
  // A freeze that already delivered a hard notification leaves capture failed;
  // retrying stop must not invent a preserved tail.
  if failFirstFreeze, freezeNotification != nil {
    let stopped = try await PCMTestWait.withDeadline("native-stop failed-freeze retry") {
      try await session.stop(.drain)
    }
    #expect(stopped.finalPacket == nil)
    return (nil, sink.failures)
  }
  let stopped = try await PCMTestWait.withDeadline("native-stop final drain") {
    try await session.stop(.drain)
  }
  let bytes = stopped.finalPacket?.bytes.count
  stopped.finalPacket?.bytes.zeroize()
  if failFirstFreeze {
    #expect(system.sequence == ["freeze", "freeze", "deactivate", "clear"])
  } else {
    #expect(system.sequence == (failFirstDeactivation
      ? ["freeze", "deactivate", "deactivate", "clear"] : ["freeze", "deactivate", "clear"]))
  }
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
  private let failFirstFreeze: Bool
  private let freezeNotification: AppleAudioSystemEvent?
  private var deactivations = 0
  private var freezes = 0
  init(_ notification: AppleAudioSystemEvent?, failFirstDeactivation: Bool = false,
    retryNotification: AppleAudioSystemEvent? = nil, failFirstFreeze: Bool = false,
    freezeNotification: AppleAudioSystemEvent? = nil) {
    self.notification = notification
    self.failFirstDeactivation = failFirstDeactivation
    self.retryNotification = retryNotification
    self.failFirstFreeze = failFirstFreeze
    self.freezeNotification = freezeNotification
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
  func freezeInput() throws {
    let outcome = lock.withLock { () -> ((@Sendable (AppleAudioSystemEvent) -> Void)?, AppleAudioSystemEvent?, Bool) in
      operations.append("freeze")
      freezes += 1
      let shouldFail = failFirstFreeze && freezes == 1
      if shouldFail {
        return (event, freezeNotification, true)
      }
      frames = nil
      return (nil, nil, false)
    }
    if let notification = outcome.1 { outcome.0?(notification) }
    if outcome.2 { throw AVFoundationDriverError.operationFailed }
  }
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

private final class GateFailures: @unchecked Sendable {
  private let lock = NSLock()
  private var events: [PCMAudioEvent] = []
  private var invalidated = 0
  var count: Int { lock.withLock { events.count } }
  var invalidations: Int { lock.withLock { invalidated } }
  var last: PCMAudioEvent? { lock.withLock { events.last } }
  func record(_ event: PCMAudioEvent) { lock.withLock { events.append(event) } }
  func invalidate(_ event: PCMAudioEvent) { lock.withLock { invalidated += 1 } }
}
