@testable import CosmaneuraIOSPCMCore
import Foundation
import Testing

private let runID = "a0000000-0000-4000-8000-000000000001"
private let epoch: Int64 = 1_790_000_000_000

private func sourceTime(_ seconds: Int64, wallOffset: Int64 = 0) -> PCMSourceTime {
  PCMSourceTime(epochMilliseconds: epoch + seconds * 1_000 + wallOffset,
    monotonicNanoseconds: UInt64(seconds) * 1_000_000_000)
}

private func authority(maximum: Int = 2_048) throws -> PCMSourceAuthority {
  try PCMSourceAuthority(runID: runID, generation: 1,
    expiresAtMilliseconds: epoch + 900_000, hardMaximumChunks: maximum)
}

private final class AcceleratedSourceClock: PCMSourceClock, @unchecked Sendable {
  private let lock = NSLock()
  private var seconds: Int64 = 0
  func advance() { lock.withLock { seconds += 1 } }
  func now() -> PCMSourceTime { lock.withLock { sourceTime(seconds) } }
  // The test advances capture time through now(), without waiting in real time.
  // The production receive/extend paths still check both clocks on every call.
  func sleep(nanoseconds: UInt64) async throws {
    try await Task.sleep(nanoseconds: nanoseconds)
  }
}

private struct SyntheticConsent: MicrophonePermissionAuthorizing {
  let allPartiesConsented = true
  let consentRecordID = UUID()
  func requestPermission(cancellation: StartupCancellation) async -> MicrophonePermission {
    allPartiesConsented && !cancellation.isCancelled ? .granted : .unavailable
  }
}

private final class SyntheticDriver: PCMAudioDriving, @unchecked Sendable {
  private let lock = NSLock()
  private var callbacks: PCMAudioCallbacks?
  func start(sessionID: UInt64, callbacks: PCMAudioCallbacks,
    cancellation: StartupCancellation) async throws {
    guard !cancellation.isCancelled else { throw PCMFailure(.startupCancelled) }
    lock.withLock { self.callbacks = callbacks }
  }
  func offerSecond() async throws {
    let callback = try #require(lock.withLock { callbacks })
    let frames = OwnedAudioFrames(sampleRateHz: 16_000,
      channels: [Array(repeating: 0.125, count: 16_000)])
    let admitted = callback.frames(frames)
    try #require(admitted.accepted)
    await admitted.waitUntilConsumed()
    #expect(frames.isZeroed)
  }
  func freezeInput(sessionID: UInt64) async throws { lock.withLock { callbacks = nil } }
  func release(sessionID: UInt64) async throws {}
}

private struct AcceptedPacket: PCMAcknowledging {
  func wait() async -> PCMAcknowledgementResult { .accepted }
  func cancel() {}
}

private final class CountingSink: PCMEmissionSink, @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  private var totalBytes = 0
  private var failures: [PCMTerminationCode] = []
  private var closes: [PCMWindowCloseReason] = []
  func emit(_ packet: PCMEncodedPacket) throws -> any PCMAcknowledging {
    lock.withLock {
      #expect(packet.sequenceNumber == UInt64(count))
      #expect(packet.bytes.count == 320_000)
      #expect(packet.bytes.withUnsafeBytes { bytes in
        stride(from: 0, to: bytes.count, by: 2).allSatisfy {
          bytes[$0] == 0 && bytes[$0 + 1] == 16
        }
      })
      count += 1
      totalBytes += packet.bytes.count
    }
    return AcceptedPacket()
  }
  func terminated(_ code: PCMTerminationCode) { lock.withLock { failures.append(code) } }
  func windowClosed(_ reason: PCMWindowCloseReason) { lock.withLock { closes.append(reason) } }
  func verify() {
    lock.withLock {
      #expect(count == 1_080)
      #expect(totalBytes == 345_600_000)
      #expect(failures.isEmpty && closes.isEmpty)
    }
  }
}

@Suite(.serialized)
struct LongSourceWindowTests {
  @Test func threeHoursOfPCMKeepContiguousPositionsAcrossShortWindows() async throws {
    let consent = SyntheticConsent(), driver = SyntheticDriver()
    let clock = AcceleratedSourceClock(), sink = CountingSink()
    let core = IOSPCMCore(permission: consent, audio: driver, sink: sink, sourceClock: clock)
    let session = try core.start(configuration: PCMConfiguration(targetFramesPerChunk: 160_000,
      maximumChunks: 90, maximumInputFramesPerBuffer: 16_000, authority: authority()))
    try await session.ready()
    var generation = 1
    // Stream all 172.8 million invented frames. Nothing accumulates the visit or
    // touches a microphone, Keychain, file, network, or installed application.
    for second in 0..<10_800 {
      if second > 0 && second.isMultiple(of: 780) {
        generation += 1
        try await session.extend(PCMSourceExtension(runID: runID, generation: generation,
          expiresAtMilliseconds: epoch + Int64(second + 900) * 1_000,
          maximumChunks: (second + 900) / 10))
      }
      if second.isMultiple(of: 10) { await session.heartbeat() }
      try await driver.offerSecond()
      clock.advance()
    }
    let stopped = try await session.stop(.drain)
    #expect(stopped.finalPacket == nil)
    sink.verify()
    await #expect(throws: PCMFailure.self) {
      try await session.extend(PCMSourceExtension(runID: runID, generation: generation + 1,
        expiresAtMilliseconds: epoch + 11_700_000, maximumChunks: 1_170))
    }
  }

  @Test func totalPositionBoundIsIndependentOfShortDeadline() throws {
    _ = try authority(maximum: 1_080)
    _ = try authority(maximum: 2_048)
    for maximum in [0, 2_049, Int.max] {
      #expect(throws: PCMFailure.self) { try authority(maximum: maximum) }
    }
    let future = try PCMSourceAuthority(runID: runID, generation: 1,
      expiresAtMilliseconds: epoch + 10_800_000, hardMaximumChunks: 2_048)
    #expect(throws: PCMFailure.self) {
      try PCMSourceWindow(authority: future, maximumChunks: 1_080, now: sourceTime(0))
    }
  }

  @Test func renewalMustStayOnSameLiveRunAndAdvanceExactlyOneGeneration() throws {
    let original = try PCMSourceWindow(authority: authority(), maximumChunks: 90, now: sourceTime(0))
    let valid = PCMSourceExtension(runID: runID, generation: 2,
      expiresAtMilliseconds: epoch + 1_680_000, maximumChunks: 168)
    var window = original
    try window.extend(valid, now: sourceTime(780))
    try window.extend(valid, now: sourceTime(781)) // Exact replay does not enlarge time.
    #expect(window.maximumChunks == 168 && window.authority.generation == 2)
    for invalid in [
      PCMSourceExtension(runID: UUID().uuidString.lowercased(), generation: 2,
        expiresAtMilliseconds: valid.expiresAtMilliseconds, maximumChunks: 168),
      PCMSourceExtension(runID: runID, generation: 3,
        expiresAtMilliseconds: valid.expiresAtMilliseconds, maximumChunks: 168),
      PCMSourceExtension(runID: runID, generation: 1,
        expiresAtMilliseconds: valid.expiresAtMilliseconds, maximumChunks: 168),
      PCMSourceExtension(runID: runID, generation: 2,
        expiresAtMilliseconds: epoch + 900_000, maximumChunks: 168),
      PCMSourceExtension(runID: runID, generation: 2,
        expiresAtMilliseconds: valid.expiresAtMilliseconds, maximumChunks: 89),
      PCMSourceExtension(runID: runID, generation: 2,
        expiresAtMilliseconds: valid.expiresAtMilliseconds, maximumChunks: 2_049),
      PCMSourceExtension(runID: runID, generation: 2,
        expiresAtMilliseconds: epoch + 1_686_000, maximumChunks: 168),
    ] {
      var unchanged = original
      #expect(throws: PCMFailure.self) { try unchanged.extend(invalid, now: sourceTime(780)) }
      #expect(unchanged.maximumChunks == 90 && unchanged.authority.generation == 1)
    }
    for expired in [sourceTime(900), sourceTime(900, wallOffset: -300_000),
      sourceTime(780, wallOffset: 120_000)] {
      var closed = original
      #expect(closed.remainingNanoseconds(expired) == 0)
      #expect(throws: PCMFailure.self) { try closed.extend(valid, now: expired) }
    }
    #expect(window.remainingNanoseconds(sourceTime(1_680, wallOffset: -600_000)) == 0)
  }
}
