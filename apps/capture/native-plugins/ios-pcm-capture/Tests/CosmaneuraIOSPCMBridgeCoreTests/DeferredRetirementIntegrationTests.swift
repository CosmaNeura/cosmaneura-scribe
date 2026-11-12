import Foundation
import Testing

@testable import CosmaneuraIOSAVFoundationDriver
@testable import CosmaneuraIOSPCMCore

/// Guards the driver's deferredRetirement pass-through into DriverCallbackGate.
/// Revert kill: make AVFoundationPCMDriver ignore deferredRetirement (always nil).
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
    let retired = SyncLatch()
    let retirementCalls = CallCounter()
    let system = DeferredProbeSystem()
    let sink = ProbeEmissionSink()
    let driver = AVFoundationPCMDriver(
      system: system,
      foreground: ProbeForeground(),
      lifecycle: .nativeEncrypted,
      diagnostics: diagnostics,
      deferredRetirement: { complete in
        retirementCalls.increment()
        await retire.wait()
        complete()
        await retired.open()
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
    try await session.ready()
    defer {
      retire.open()
      retired.open()
      stopSession(session, mode: .discard)
    }

    var expectedFrames = 0
    for _ in 0..<3 {
      expectedFrames += 32
      let frames = OwnedAudioFrames(
        sampleRateHz: 16_000,
        channels: [Array(repeating: Float(0.125), count: 32)]
      )
      system.offer(frames)
      let deadline = ContinuousClock.now + .seconds(2)
      while session.capturedAudioFrames < expectedFrames && ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(1))
      }
      try #require(session.capturedAudioFrames == expectedFrames)
      #expect(frames.isZeroed)
    }

    #expect(sink.failures.isEmpty)
    // Must observe the injected seam; ignoring deferredRetirement leaves this at 0.
    try await waitForCalls(retirementCalls, atLeast: 3)
    retire.open()
    await retired.wait()
    let stopped = try await session.stop(.drain)
    #expect(stopped.finalPacket?.bytes.count == 192)
    stopped.finalPacket?.bytes.zeroize()
    await diagnostics.flush()
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
    let retirementCalls = CallCounter()
    let system = DeferredProbeSystem()
    let sink = ProbeEmissionSink(emitHold: secondConsumeHold)
    let driver = AVFoundationPCMDriver(
      system: system,
      foreground: ProbeForeground(),
      lifecycle: .nativeEncrypted,
      diagnostics: diagnostics,
      deferredRetirement: { complete in
        retirementCalls.increment()
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
    try await session.ready()
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
    let firstDeadline = ContinuousClock.now + .seconds(2)
    while session.capturedAudioFrames < 32 && ContinuousClock.now < firstDeadline {
      try await Task.sleep(for: .milliseconds(1))
    }
    try #require(session.capturedAudioFrames == 32 && first.isZeroed)
    try await waitForCalls(retirementCalls, atLeast: 1)

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
    let holding = await secondConsumeHold.waitUntilHolding()
    try #require(holding)
    system.offer(third)
    #expect(third.isZeroed)

    let failDeadline = ContinuousClock.now + .seconds(3)
    while sink.failures.isEmpty && ContinuousClock.now < failDeadline {
      try await Task.sleep(for: .milliseconds(1))
    }
    #expect(!sink.failures.isEmpty)
    secondConsumeHold.open()
    retire.open()
    _ = try? await session.stop(.discard)
    await diagnostics.flush()
    let rows = try #require(
      JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [[String: Any]]
    )
    #expect(rows.filter { $0["event"] as? String == "driverAdmissionOverflow" }.count == 1)
  }
}

private func waitForCalls(
  _ counter: CallCounter, atLeast: Int, timeout: Duration = .seconds(2)
) async throws {
  let deadline = ContinuousClock.now + timeout
  while counter.count < atLeast && ContinuousClock.now < deadline {
    try await Task.sleep(for: .milliseconds(1))
  }
  try #require(counter.count >= atLeast)
}

private func stopSession(_ session: IOSPCMSessionHandle, mode: PCMStopMode) {
  let done = DispatchSemaphore(value: 0)
  Task {
    _ = try? await session.stop(mode)
    done.signal()
  }
  _ = done.wait(timeout: .now() + .seconds(5))
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
/// consumption for that full chunk. Open from every exit path.
private final class EmitHold: @unchecked Sendable {
  private let lock = NSLock()
  private var armed = false
  private var opened = false
  private let entered = DispatchSemaphore(value: 0)
  private let release = DispatchSemaphore(value: 0)

  func arm() {
    lock.withLock {
      armed = true
      opened = false
    }
  }

  func holdIfArmed() {
    let shouldHold = lock.withLock { armed && !opened }
    guard shouldHold else { return }
    entered.signal()
    _ = release.wait(timeout: .now() + .seconds(5))
  }

  func waitUntilHolding(timeoutSeconds: Int = 2) async -> Bool {
    return await withCheckedContinuation { continuation in
      DispatchQueue.global().async {
        let result = self.entered.wait(timeout: .now() + .seconds(timeoutSeconds))
        continuation.resume(returning: result == .success)
      }
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
