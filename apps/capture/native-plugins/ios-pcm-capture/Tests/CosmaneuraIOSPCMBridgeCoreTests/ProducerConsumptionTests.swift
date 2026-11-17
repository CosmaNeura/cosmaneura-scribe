@testable import CosmaneuraIOSPCMCore
import Foundation
import Testing

/// Consented invented PCM only; no OS microphone, storage or network.
@Suite(.timeLimit(.minutes(1)))
struct ProducerConsumptionTests {
  @Test func corePublishesConsumptionWithoutAReceiptWaiter() async throws {
    let audio = NonWaitingDriver(), sink = ConsumptionSink()
    let core = IOSPCMCore(permission: ConsumptionConsent(), audio: audio, sink: sink)
    let session = try core.start(configuration: PCMConfiguration(
      targetFramesPerChunk: 160_000, maximumChunks: 2,
      maximumInputFramesPerBuffer: 8_192))
    // On until/#require failure, discard so the suite does not leave a live session.
    var discardOnFailure = true
    defer {
      if discardOnFailure {
        stopProducerSession(session)
      }
    }
    try await PCMTestWait.withDeadline("producer ready") {
      try await session.ready()
    }
    for _ in 0..<6 {
      let frames = OwnedAudioFrames(sampleRateHz: 48_000,
        channels: [Array(repeating: Float(0.125), count: 8_192)])
      let receipt = try audio.offer(frames)
      try #require(receipt.accepted)
      // No driver task or copied receipt waits here. Producer completion must
      // clear the core admission and publish consumption before the next tap.
      try await PCMTestWait.until("producer receipt consumed") { receipt.isConsumed }
      try #require(frames.isZeroed)
    }
    #expect(session.capturedAudioFrames == 16_384 && sink.failures.isEmpty)
    let stopped = try await PCMTestWait.withDeadline("producer stop(.drain)") {
      try await session.stop(.drain)
    }
    discardOnFailure = false
    #expect(stopped.finalPacket?.bytes.count == 32_768)
    stopped.finalPacket?.bytes.zeroize()
  }

  @Test func invalidInputAlsoResolvesItsReceiptWithoutAWaiter() async throws {
    let audio = NonWaitingDriver(), sink = ConsumptionSink()
    let core = IOSPCMCore(permission: ConsumptionConsent(), audio: audio, sink: sink)
    let session = try core.start(configuration: PCMConfiguration(
      targetFramesPerChunk: 64, maximumChunks: 2, maximumInputFramesPerBuffer: 64))
    var discardOnFailure = true
    defer {
      if discardOnFailure {
        stopProducerSession(session)
      }
    }
    try await PCMTestWait.withDeadline("producer invalid ready") {
      try await session.ready()
    }
    let frames = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[Float.nan]])
    let receipt = try audio.offer(frames)
    try #require(receipt.accepted)
    try await PCMTestWait.until("producer invalid receipt consumed") { receipt.isConsumed }
    try #require(frames.isZeroed)
    let stopped = try await PCMTestWait.withDeadline("producer invalid stop(.drain)") {
      try await session.stop(.drain)
    }
    discardOnFailure = false
    #expect(stopped.finalPacket == nil && sink.failures == [.invalidPCM])
  }
}

/// Fire-and-forget discard used only when an until/#require path throws.
private func stopProducerSession(_ session: IOSPCMSessionHandle) {
  Task {
    _ = try? await PCMTestWait.withDeadline("producer cleanup session.stop(.discard)") {
      try await session.stop(.discard)
    }
  }
}

private struct ConsumptionConsent: MicrophonePermissionAuthorizing {
  let allPartiesConsented = true
  let consentRecordID = UUID()
  func requestPermission(cancellation: StartupCancellation) async -> MicrophonePermission {
    allPartiesConsented && !cancellation.isCancelled ? .granted : .unavailable
  }
}

private final class NonWaitingDriver: PCMAudioDriving, @unchecked Sendable {
  private let lock = NSLock()
  private var callbacks: PCMAudioCallbacks?
  func start(sessionID: UInt64, callbacks: PCMAudioCallbacks,
    cancellation: StartupCancellation) async throws {
    lock.withLock { self.callbacks = callbacks }
  }
  func offer(_ frames: OwnedAudioFrames) throws -> PCMFrameAdmission {
    try #require(lock.withLock { callbacks }).frames(frames)
  }
  func freezeInput(sessionID: UInt64) async throws { lock.withLock { callbacks = nil } }
  func release(sessionID: UInt64) async throws {}
}

private final class ConsumptionSink: PCMEmissionSink, @unchecked Sendable {
  private let lock = NSLock()
  private var terminations: [PCMTerminationCode] = []
  var failures: [PCMTerminationCode] { lock.withLock { terminations } }
  func emit(_ packet: PCMEncodedPacket) throws -> any PCMAcknowledging {
    struct Ack: PCMAcknowledging {
      func wait() async -> PCMAcknowledgementResult { .accepted }
      func cancel() {}
    }
    return Ack()
  }
  func terminated(_ code: PCMTerminationCode) { lock.withLock { terminations.append(code) } }
}
