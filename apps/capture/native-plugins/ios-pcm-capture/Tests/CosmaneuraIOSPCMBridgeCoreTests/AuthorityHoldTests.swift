@testable import CosmaneuraIOSPCMCore
import Foundation
import Testing

private let runID = "b0000000-0000-4000-8000-000000000001"

private func liveAuthority(_ id: String = runID) throws -> PCMSourceAuthority {
  try PCMSourceAuthority(runID: id, generation: 1,
    expiresAtMilliseconds: Int64(Date().timeIntervalSince1970 * 1_000) + 60_000,
    hardMaximumChunks: 90)
}

private func configuration(hold: UInt64) throws -> PCMConfiguration {
  try PCMConfiguration(targetFramesPerChunk: 160_000, maximumChunks: 90,
    maximumInputFramesPerBuffer: 16_000, preserveInterruptedTail: true,
    authorityHoldNanoseconds: hold)
}

private struct SyntheticConsent: MicrophonePermissionAuthorizing {
  let allPartiesConsented = true
  let consentRecordID = UUID()
  func requestPermission(cancellation: StartupCancellation) async -> MicrophonePermission {
    cancellation.isCancelled ? .unavailable : .granted
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
  /// One invented second of constant tone; returns false once input is closed.
  @discardableResult func offerSecond() async throws -> Bool {
    guard let callback = lock.withLock({ callbacks }) else { return false }
    let frames = OwnedAudioFrames(sampleRateHz: 16_000,
      channels: [Array(repeating: 0.125, count: 16_000)])
    let admitted = callback.frames(frames)
    guard admitted.accepted else { return false }
    try await PCMTestWait.until("authority-hold buffer consumed") { admitted.isConsumed }
    return true
  }
  func freezeInput(sessionID: UInt64) async throws { lock.withLock { callbacks = nil } }
  func release(sessionID: UInt64) async throws {}
}

private struct AcceptedPacket: PCMAcknowledging {
  func wait() async -> PCMAcknowledgementResult { .accepted }
  func cancel() {}
}

private final class RecordingSink: PCMEmissionSink, @unchecked Sendable {
  private let lock = NSLock()
  private var emitted: [UInt64] = []
  private var failures: [PCMTerminationCode] = []
  func emit(_ packet: PCMEncodedPacket) throws -> any PCMAcknowledging {
    lock.withLock { emitted.append(packet.sequenceNumber) }
    return AcceptedPacket()
  }
  func terminated(_ code: PCMTerminationCode) { lock.withLock { failures.append(code) } }
  func windowClosed(_ reason: PCMWindowCloseReason) {}
  var packets: [UInt64] { lock.withLock { emitted } }
  var terminations: [PCMTerminationCode] { lock.withLock { failures } }
}

private func waitUntil(_ label: String, _ condition: @Sendable () -> Bool) async throws {
  try await PCMTestWait.until(label, timeout: .seconds(3), condition)
}

@Suite(.serialized, .timeLimit(.minutes(1)))
struct AuthorityHoldTests {
  @Test func heldAudioReachesTheSinkOnlyAfterBinding() async throws {
    let driver = SyntheticDriver(), sink = RecordingSink()
    let core = IOSPCMCore(permission: SyntheticConsent(), audio: driver, sink: sink)
    let session = try core.start(configuration: configuration(hold: 9_000_000_000))
    try await PCMTestWait.withDeadline("authority-hold ready") {
      try await session.ready()
    }
    for _ in 0..<9 { #expect(try await driver.offerSecond()) }
    #expect(sink.packets.isEmpty)
    // One stamp for bind + verify: two liveAuthority() calls can differ by 1 ms.
    let authority = try liveAuthority()
    try await session.bindAuthority(authority)
    try await session.verifySource(authority: authority, maximumChunks: 90)
    #expect(try await driver.offerSecond())
    #expect(sink.packets == [0])
    let stopped = try await PCMTestWait.withDeadline("authority-hold stop(.drain)") {
      try await session.stop(.drain)
    }
    #expect(stopped.finalPacket == nil)
    #expect(sink.terminations.isEmpty)
  }

  @Test func unboundHoldExpiryErasesTheAudio() async throws {
    let driver = SyntheticDriver(), sink = RecordingSink()
    let core = IOSPCMCore(permission: SyntheticConsent(), audio: driver, sink: sink)
    let session = try core.start(configuration: configuration(hold: 50_000_000))
    try await PCMTestWait.withDeadline("authority-hold expiry ready") {
      try await session.ready()
    }
    for _ in 0..<3 { _ = try await driver.offerSecond() }
    try await waitUntil("authority hold expiry") { !sink.terminations.isEmpty }
    #expect(sink.terminations == [.authorityHoldExpired])
    await #expect(throws: PCMFailure.self) { try await session.bindAuthority(liveAuthority()) }
    let stopped = try await PCMTestWait.withDeadline("authority-hold expiry stop") {
      try await session.stop(.drain)
    }
    #expect(stopped.finalPacket == nil)
    #expect(sink.packets.isEmpty)
  }

  @Test func stopBeforeBindingDiscardsEvenWhenDrainIsRequested() async throws {
    let driver = SyntheticDriver(), sink = RecordingSink()
    let core = IOSPCMCore(permission: SyntheticConsent(), audio: driver, sink: sink)
    let session = try core.start(configuration: configuration(hold: 9_000_000_000))
    try await PCMTestWait.withDeadline("authority-hold discard ready") {
      try await session.ready()
    }
    for _ in 0..<3 { _ = try await driver.offerSecond() }
    let stopped = try await PCMTestWait.withDeadline("authority-hold discard-via-drain stop") {
      try await session.stop(.drain)
    }
    #expect(stopped.finalPacket == nil)
    #expect(sink.packets.isEmpty)
    await #expect(throws: PCMFailure.self) { try await session.bindAuthority(liveAuthority()) }
  }

  @Test func aFullChunkCannotBeWrittenWithoutAuthority() async throws {
    let driver = SyntheticDriver(), sink = RecordingSink()
    let core = IOSPCMCore(permission: SyntheticConsent(), audio: driver, sink: sink)
    let session = try core.start(configuration: configuration(hold: 9_900_000_000))
    try await PCMTestWait.withDeadline("authority-hold overflow ready") {
      try await session.ready()
    }
    for _ in 0..<11 { _ = try await driver.offerSecond() }
    try await waitUntil("authority-hold overflow termination") { !sink.terminations.isEmpty }
    #expect(sink.packets.isEmpty)
    #expect(sink.terminations == [.bufferOverflow])
    _ = try? await PCMTestWait.withDeadline("authority-hold overflow stop") {
      try await session.stop(.discard)
    }
  }

  @Test func bindingIsOneUseAndRunIDsAreNotReused() async throws {
    let driver = SyntheticDriver(), sink = RecordingSink()
    let core = IOSPCMCore(permission: SyntheticConsent(), audio: driver, sink: sink)
    let first = try core.start(configuration: configuration(hold: 9_000_000_000))
    try await PCMTestWait.withDeadline("authority-hold one-use first ready") {
      try await first.ready()
    }
    let firstAuthority = try liveAuthority()
    try await first.bindAuthority(firstAuthority)
    await #expect(throws: PCMFailure.self) { try await first.bindAuthority(firstAuthority) }
    _ = try await first.stop(.discard)

    let second = try core.start(configuration: configuration(hold: 9_000_000_000))
    try await PCMTestWait.withDeadline("authority-hold one-use second ready") {
      try await second.ready()
    }
    let reusedAuthority = try liveAuthority()
    await #expect(throws: PCMFailure.self) {
      try await second.bindAuthority(reusedAuthority)
    }
    _ = try? await second.stop(.discard)
  }

  @Test func holdMustBeShorterThanOneChunkAndExcludesAnAuthority() throws {
    #expect(throws: PCMFailure.self) { try configuration(hold: 10_000_000_000) }
    #expect(throws: PCMFailure.self) { try configuration(hold: 0) }
    #expect(throws: PCMFailure.self) {
      try PCMConfiguration(targetFramesPerChunk: 160_000, maximumChunks: 90,
        authority: liveAuthority(), preserveInterruptedTail: true,
        authorityHoldNanoseconds: 1_000_000_000)
    }
    _ = try configuration(hold: 9_999_000_000)
  }
}
