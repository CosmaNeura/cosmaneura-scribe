import Foundation
import Testing

@testable import CosmaneuraIOSAVFoundationDriver
@testable import CosmaneuraIOSPCMCore

/// Guards the driver's deferredRetirement pass-through into DriverCallbackGate.
/// Revert kill: make AVFoundationPCMDriver ignore deferredRetirement (always nil).
@Suite(.timeLimit(.minutes(1)))
struct DeferredRetirementIntegrationTests {
  @Test func heldRetirementStillAdmitsConsumedBuffersThroughRealCoreAndDriver() async throws {
    // Explicit synthetic consent; invented PCM only. No OS audio, network or PHI.
    let consent = ProbeConsent()
    try #require(consent.allPartiesConsented)
    let diagnostics = PCMStartupDiagnostics()
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(consent.consentRecordID.uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("diagnostics.json")
    diagnostics.configure(destination: path)
    diagnostics.record(.startRequested)

    let retire = SyncLatch()
    let retirementEntries = CallCounter()
    let retirementCompletions = CallCounter()
    let system = DeferredProbeSystem()
    let sink = ProbeEmissionSink()
    let driver = AVFoundationPCMDriver(
      system: system,
      foreground: ProbeForeground(),
      lifecycle: .nativeEncrypted,
      diagnostics: diagnostics,
      deferredRetirement: { complete in
        retirementEntries.increment()
        await retire.wait()
        complete()
        retirementCompletions.increment()
      }
    )
    let core = IOSPCMCore(permission: consent, audio: driver, sink: sink, diagnostics: diagnostics)
    // targetFramesPerChunk 160 > 96 offered frames, so append never fills a chunk
    // (IOSPCMCore.append/startDelivery) and prepareFinalPacket keeps the full
    // 192-byte drained tail instead of emitting three 64-byte packets.
    let authority = try PCMSourceAuthority(
      runID: UUID().uuidString.lowercased(),
      generation: 1,
      expiresAtMilliseconds: Int64(Date().timeIntervalSince1970 * 1000) + 60_000,
      hardMaximumChunks: 4
    )
    let session = try core.start(configuration: PCMConfiguration(
      targetFramesPerChunk: 160,
      maximumChunks: 4,
      maximumInputFramesPerBuffer: 32,
      authority: authority,
      preserveInterruptedTail: true
    ))
    try await PCMTestWait.withDeadline("deferred-retirement held ready") {
      try await session.ready()
    }
    // stopSession is fire-and-forget: a cleanup timeout Issue may land up to ~3s
    // late, possibly while the next test in the suite is already running.
    defer {
      retire.open()
      stopSession(session, mode: .discard)
    }

    var expectedFrames = 0
    for _ in 0..<3 {
      expectedFrames += 32
      let targetFrames = expectedFrames
      let frames = OwnedAudioFrames(
        sampleRateHz: 16_000,
        channels: [Array(repeating: Float(0.125), count: 32)]
      )
      system.offer(frames)
      try await PCMTestWait.until("capturedAudioFrames == \(targetFrames)") {
        session.capturedAudioFrames == targetFrames
      }
      try #require(frames.isZeroed)
    }

    #expect(sink.failures.isEmpty)
    // Must observe the injected seam; ignoring deferredRetirement leaves this at 0.
    // Do not assume which buffer's retirement Task arrives first.
    try await PCMTestWait.until("retirementEntries >= 3") { retirementEntries.count >= 3 }
    retire.open()
    try await PCMTestWait.until("retirementCompletions >= 3") { retirementCompletions.count >= 3 }
    let stopped = try await PCMTestWait.withDeadline("session.stop(.drain)") {
      try await session.stop(.drain)
    }
    #expect(stopped.finalPacket?.bytes.count == 192)
    stopped.finalPacket?.bytes.zeroize()
    try await PCMTestWait.withDeadline("deferred-retirement held flush") {
      await diagnostics.flush()
    }
    let rows = try #require(
      JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [[String: Any]]
    )
    #expect(rows.filter { $0["event"] as? String == "driverAdmissionOverflow" }.isEmpty)
  }

  @Test func trulyUnconsumedSecondBufferStillOverflowsThroughRealCoreAndDriver() async throws {
    // Explicit synthetic consent; invented PCM only. No OS audio, network or PHI.
    let consent = ProbeConsent()
    try #require(consent.allPartiesConsented)
    let diagnostics = PCMStartupDiagnostics()
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(consent.consentRecordID.uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("diagnostics.json")
    diagnostics.configure(destination: path)
    diagnostics.record(.startRequested)

    let retire = SyncLatch()
    let secondConsumeHold = EmitHold()
    let retirementEntries = CallCounter()
    let system = DeferredProbeSystem()
    let sink = ProbeEmissionSink(emitHold: secondConsumeHold)
    let driver = AVFoundationPCMDriver(
      system: system,
      foreground: ProbeForeground(),
      lifecycle: .nativeEncrypted,
      diagnostics: diagnostics,
      deferredRetirement: { complete in
        retirementEntries.increment()
        await retire.wait()
        complete()
      }
    )
    let core = IOSPCMCore(permission: consent, audio: driver, sink: sink, diagnostics: diagnostics)
    // Chunk size 32 makes each buffer a full sink.emit. Hold the second emit so
    // finishConsumption has not run when the third buffer arrives.
    let authority = try PCMSourceAuthority(
      runID: UUID().uuidString.lowercased(),
      generation: 1,
      expiresAtMilliseconds: Int64(Date().timeIntervalSince1970 * 1000) + 60_000,
      hardMaximumChunks: 4
    )
    let session = try core.start(configuration: PCMConfiguration(
      targetFramesPerChunk: 32,
      maximumChunks: 4,
      maximumInputFramesPerBuffer: 32,
      authority: authority,
      preserveInterruptedTail: true
    ))
    try await PCMTestWait.withDeadline("deferred-retirement overflow ready") {
      try await session.ready()
    }
    // stopSession is fire-and-forget: a cleanup timeout Issue may land up to ~3s
    // late, possibly while the next test in the suite is already running.
    defer {
      secondConsumeHold.open()
      retire.open()
      stopSession(session, mode: .discard)
    }

    // First buffer is consumed by the core while retirement stays held.
    let first = OwnedAudioFrames(
      sampleRateHz: 16_000,
      channels: [Array(repeating: Float(0.125), count: 32)]
    )
    system.offer(first)
    try await PCMTestWait.until("first buffer captured") {
      session.capturedAudioFrames == 32
    }
    try #require(first.isZeroed)
    try await PCMTestWait.until("retirementEntries >= 1") { retirementEntries.count >= 1 }

    // Arm the hold for the next full-chunk emit, then admit the second buffer.
    secondConsumeHold.arm()
    let second = OwnedAudioFrames(
      sampleRateHz: 16_000,
      channels: [Array(repeating: Float(0.125), count: 32)]
    )
    let third = OwnedAudioFrames(
      sampleRateHz: 16_000,
      channels: [Array(repeating: Float(0.25), count: 32)]
    )
    system.offer(second)
    try await secondConsumeHold.waitUntilHoldingOrFail()
    system.offer(third)
    try #require(third.isZeroed)

    try await PCMTestWait.until("overflow failure recorded") { !sink.failures.isEmpty }
    #expect(!secondConsumeHold.releaseTimedOut)
    secondConsumeHold.open()
    retire.open()
    _ = try await PCMTestWait.withDeadline("session.stop(.discard)") {
      try await session.stop(.discard)
    }
    try await PCMTestWait.withDeadline("deferred-retirement overflow flush") {
      await diagnostics.flush()
    }
    let rows = try #require(
      JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [[String: Any]]
    )
    #expect(rows.filter { $0["event"] as? String == "driverAdmissionOverflow" }.count == 1)
  }
}

/// Fire-and-forget cleanup: does not block the defer caller. A stuck stop is
/// bounded by `PCMTestWait.withDeadline` and abandoned after the Issue is
/// recorded — so that Issue can surface up to ~3s after the test returns,
/// possibly while the next test is already running.
private func stopSession(_ session: IOSPCMSessionHandle, mode: PCMStopMode) {
  Task {
    do {
      _ = try await PCMTestWait.withDeadline("cleanup session.stop") {
        try await session.stop(mode)
      }
    } catch {
      // Timeout path already recorded an Issue inside withDeadline.
    }
  }
}

private final class SyncLatch: @unchecked Sendable {
  private let lock = NSLock()
  private var opened = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  func wait() async {
    if lock.withLock({ opened }) { return }
    await withCheckedContinuation { continuation in
      let resumeNow = lock.withLock { () -> Bool in
        if opened { return true }
        waiters.append(continuation)
        return false
      }
      if resumeNow { continuation.resume() }
    }
  }
  func open() {
    let pending = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
      opened = true
      defer { waiters.removeAll() }
      return waiters
    }
    for waiter in pending { waiter.resume() }
  }
}

/// Blocks sink.emit after arm() so the core's receive defer has not yet published
/// consumption for that full chunk. Open from every exit path. A release-side
/// timeout is recorded and must fail the overflow test (not silently continue).
private final class EmitHold: @unchecked Sendable {
  private let lock = NSLock()
  private var armed = false
  private var opened = false
  private var timedOut = false
  private let entered = DispatchSemaphore(value: 0)
  private let release = DispatchSemaphore(value: 0)

  var releaseTimedOut: Bool { lock.withLock { timedOut } }

  func arm() {
    lock.withLock {
      armed = true
      opened = false
      timedOut = false
    }
  }

  func holdIfArmed() {
    let shouldHold = lock.withLock { armed && !opened }
    guard shouldHold else { return }
    entered.signal()
    if release.wait(timeout: .now() + .seconds(3)) == .timedOut {
      lock.withLock { timedOut = true }
      Issue.record("EmitHold release timed out after 3s")
    }
  }

  func waitUntilHoldingOrFail(timeoutSeconds: Int = 3) async throws {
    let held = await withCheckedContinuation { continuation in
      DispatchQueue.global().async {
        let result = self.entered.wait(timeout: .now() + .seconds(timeoutSeconds))
        continuation.resume(returning: result == .success)
      }
    }
    guard held else {
      Issue.record("Timed out after \(timeoutSeconds)s waiting for EmitHold to enter")
      throw PCMTestWait.TimeoutError(
        label: "EmitHold enter", timeout: .seconds(timeoutSeconds))
    }
  }

  func open() {
    lock.withLock {
      opened = true
      armed = false
    }
    release.signal()
  }
}

private final class CallCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  var count: Int { lock.withLock { value } }
  func increment() { lock.withLock { value += 1 } }
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

private final class DeferredProbeSystem: AppleAudioSystem, @unchecked Sendable {
  private let lock = NSLock()
  private var event: (@Sendable (AppleAudioSystemEvent) -> Void)?
  private var frames: (@Sendable (OwnedAudioFrames) -> Void)?
  func setEventHandler(_ handler: @escaping @Sendable (AppleAudioSystemEvent) -> Void) {
    lock.withLock { event = handler }
  }
  func clearEventHandler() { lock.withLock { event = nil } }
  func configureAndActivate(profile: AppleAudioSessionProfile) throws {}
  func installInputTap(
    frameCapacity: UInt32,
    handler: @escaping @Sendable (OwnedAudioFrames) -> Void
  ) throws {
    lock.withLock { frames = handler }
  }
  func startEngine() throws {}
  func offer(_ value: OwnedAudioFrames) { lock.withLock { frames }?(value) }
  func freezeInput() throws { lock.withLock { frames = nil } }
  func deactivate() throws {}
}

private final class ProbeEmissionSink: PCMEmissionSink, @unchecked Sendable {
  private let lock = NSLock()
  private var values: [PCMTerminationCode] = []
  private let emitHold: EmitHold?
  init(emitHold: EmitHold? = nil) { self.emitHold = emitHold }
  var failures: [PCMTerminationCode] { lock.withLock { values } }
  func terminated(_ code: PCMTerminationCode) { lock.withLock { values.append(code) } }
  func emit(_ packet: PCMEncodedPacket) throws -> any PCMAcknowledging {
    emitHold?.holdIfArmed()
    struct Ack: PCMAcknowledging {
      func wait() async -> PCMAcknowledgementResult { .accepted }
      func cancel() {}
    }
    return Ack()
  }
}
