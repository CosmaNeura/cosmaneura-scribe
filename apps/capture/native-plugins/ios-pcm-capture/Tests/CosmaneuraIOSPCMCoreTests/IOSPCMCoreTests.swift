import Foundation
import XCTest

@testable import CosmaneuraIOSPCMCore

final class IOSPCMCoreTests: XCTestCase, @unchecked Sendable {
  func testAreaWeightedV1MatchesCommittedWebGoldenAcrossPushBoundaries() throws {
    let input = decodeFloat32LE(
      "000080bf000040bf000000bf000080be000000000000803e0000003f0000403f"
        + "0000803f0000403f0000003f0000803e00000000000080be000000bf000040bf"
        + "000080bf000000bf000000000000003f0000803f00000000"
    )
    var resampler = try AreaWeightedPCM16Resampler(
      sourceRate: 44_100,
      targetRate: 16_000,
      maximumOutputFrames: input.count
    )
    var output: [Int16] = []
    var offset = 0
    for count in [1, 4, 2, 7, 8] {
      output += try resampler.push(Array(input[offset..<(offset + count)]))
      offset += count
    }
    output += try resampler.finish()
    XCTAssertEqual(encodePCM16LE(output).hex, "2c9daef4304c4c5c400273aa1fda0040")
  }

  func testImmediateHandleCancelsPendingPermissionWithoutStartingAudio() async throws {
    let permission = LatePermission()
    let harness = try Harness(permission: permission)
    let session = try harness.core.start(configuration: harness.configuration)
    try await waitUntil { permission.isWaiting }

    let result = try await session.stop(.discard)
    XCTAssertNil(result.finalPacket)
    await assertFailure(.startupCancelled) { try await session.ready() }
    permission.resolve(.granted)
    XCTAssertEqual(harness.audio.startCalls, 0)
    XCTAssertEqual(harness.audio.freezeCalls, 1)
    XCTAssertEqual(harness.audio.releaseCalls, 1)
  }

  func testImmediateHandleCancelsPendingAudioStart() async throws {
    let startGate = ManualGate<Void>()
    let audio = FakeAudioDriver(startGate: startGate)
    let harness = try Harness(audio: audio)
    let session = try harness.core.start(configuration: harness.configuration)
    try await waitUntil { audio.startCalls == 1 }

    _ = try await session.stop(.discard)
    await assertFailure(.startupCancelled) { try await session.ready() }
    startGate.resolve(())
    XCTAssertEqual(audio.freezeCalls, 1)
    XCTAssertEqual(audio.releaseCalls, 1)
  }

  func testMonotonicSequenceBackpressureAndOwnedBufferZeroization() async throws {
    let harness = try Harness(targetFrames: 2, maximumInputFrames: 2)
    let session = try await harness.readySession()
    let first = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0.5, -0.5]])
    await harness.audio.emitLatest(first)

    XCTAssertEqual(harness.sink.sequences, [0])
    XCTAssertEqual(harness.sink.snapshots[0], [0x00, 0x40, 0x00, 0xc0])
    XCTAssertTrue(first.isZeroed)
    XCTAssertTrue(harness.sink.retainedPackets[0].isZeroed)

    let second = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0.25, -0.25]])
    await harness.audio.emitLatest(second)
    XCTAssertEqual(harness.sink.sequences, [0])
    harness.sink.accept(0)
    try await waitUntil { harness.sink.sequences == [0, 1] }
    XCTAssertEqual(harness.sink.snapshots[1], [0x00, 0x20, 0x00, 0xe0])
    XCTAssertTrue(second.isZeroed)
    XCTAssertTrue(harness.sink.retainedPackets[1].isZeroed)
    harness.sink.accept(1)
    _ = try await session.stop(.drain)
  }

  func testStereoDownmixCanCrossAChunkBoundaryWithoutExtraPacketBuffering() async throws {
    let harness = try Harness(targetFrames: 2, maximumInputFrames: 2)
    let session = try await harness.readySession()
    await harness.audio.emitLatest(OwnedAudioFrames(sampleRateHz: 16_000, channels: [[1], [-1]]))
    await harness.audio.emitLatest(
      OwnedAudioFrames(
        sampleRateHz: 16_000,
        channels: [[1, -1], [-1, 1]]
      ))
    XCTAssertEqual(harness.sink.snapshots, [[0, 0, 0, 0]])
    harness.sink.accept(0)
    let result = try await session.stop(.drain)
    XCTAssertEqual(result.finalPacket?.bytes.testingCopy(), [0, 0])
    result.finalPacket?.bytes.zeroize()
  }

  func testThirdPacketWorthOfAudioOverflowsAndFailsSafe() async throws {
    let harness = try Harness(targetFrames: 2, maximumInputFrames: 2)
    let session = try await harness.readySession()
    await harness.audio.emitLatest(OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0, 0]]))
    await harness.audio.emitLatest(OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0, 0]]))
    let overflow = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0]])
    await harness.audio.emitLatest(overflow)

    try await waitUntil { harness.audio.releaseCalls == 1 }
    XCTAssertEqual(harness.sink.terminations, [.bufferOverflow])
    XCTAssertTrue(overflow.isZeroed)
    XCTAssertTrue(harness.sink.acknowledgements[0].wasCancelled)
    _ = session
  }

  func testSynchronousAdmissionRejectsAStressBurstAndClearsEveryBuffer() async throws {
    let harness = try Harness(targetFrames: 4, maximumInputFrames: 4)
    let session = try await harness.readySession()
    let first = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0]])
    let receipt = harness.audio.offerLatest(first)
    let rejected = (0..<100).map { _ in
      OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0]])
    }
    let decisions = rejected.map { harness.audio.offerLatest($0) }

    XCTAssertTrue(receipt.accepted)
    XCTAssertTrue(decisions.allSatisfy { !$0.accepted })
    XCTAssertTrue(rejected.allSatisfy(\.isZeroed))
    await receipt.waitUntilConsumed()
    try await waitUntil { harness.audio.releaseCalls == 1 }
    XCTAssertTrue(first.isZeroed)
    XCTAssertEqual(harness.sink.terminations, [.bufferOverflow])
    _ = session
  }

  func testDrainFreezesWaitsForFullAckAndReturnsOnePartial() async throws {
    let harness = try Harness(targetFrames: 4, maximumInputFrames: 4)
    let session = try await harness.readySession()
    await harness.audio.emitLatest(
      OwnedAudioFrames(
        sampleRateHz: 16_000,
        channels: [[0, 0, 0, 0]]
      ))
    await harness.audio.emitLatest(OwnedAudioFrames(sampleRateHz: 16_000, channels: [[1]]))

    let stop = Task { try await session.stop(.drain) }
    try await waitUntil { harness.audio.freezeCalls == 1 }
    XCTAssertEqual(harness.audio.releaseCalls, 0)
    harness.sink.accept(0)
    let result = try await stop.value

    XCTAssertEqual(result.finalPacket?.sequenceNumber, 1)
    XCTAssertEqual(result.finalPacket?.bytes.testingCopy(), [0xff, 0x7f])
    XCTAssertEqual(harness.audio.releaseCalls, 1)
    result.finalPacket?.bytes.zeroize()
    XCTAssertTrue(result.finalPacket?.bytes.isZeroed == true)
  }

  func testDiscardSupersedesDrainAndLaterDrainCannotReverseIt() async throws {
    let freezeGate = ManualGate<Void>()
    let audio = FakeAudioDriver(freezeGate: freezeGate)
    let harness = try Harness(audio: audio)
    let session = try await harness.readySession()
    await audio.emitLatest(OwnedAudioFrames(sampleRateHz: 16_000, channels: [[1]]))

    let drain = Task { try await session.stop(.drain) }
    try await waitUntil { audio.freezeCalls == 1 }
    let discard = Task { try await session.stop(.discard) }
    let lateDrain = Task { try await session.stop(.drain) }
    freezeGate.resolve(())

    let results = try await [drain.value, discard.value, lateDrain.value]
    XCTAssertTrue(results.allSatisfy { $0.finalPacket == nil })
    XCTAssertTrue(harness.sink.sequences.isEmpty)
  }

  func testLifecycleEventDuringDrainSupersedesItWithDiscard() async throws {
    let harness = try Harness(targetFrames: 1, maximumInputFrames: 1)
    let session = try await harness.readySession()
    await harness.audio.emitLatest(OwnedAudioFrames(sampleRateHz: 16_000, channels: [[1]]))
    let drain = Task { try await session.stop(.drain) }
    try await waitUntil { harness.audio.freezeCalls == 1 }

    await harness.audio.eventLatest(.backgrounded)
    let result = try await drain.value
    XCTAssertNil(result.finalPacket)
    XCTAssertEqual(harness.sink.terminations, [.backgrounded])
    XCTAssertTrue(harness.sink.acknowledgements[0].wasCancelled)
  }

  func testConcurrentDiscardSupersedesDrainWaitingForAcknowledgement() async throws {
    let harness = try Harness(targetFrames: 1, maximumInputFrames: 1)
    let session = try await harness.readySession()
    await harness.audio.emitLatest(OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0]]))
    let drain = Task { try await session.stop(.drain) }
    try await waitUntil { harness.audio.freezeCalls == 1 }
    let discard = Task { try await session.stop(.discard) }

    let drained = try await drain.value
    XCTAssertNil(drained.finalPacket)
    let discarded = try await discard.value
    XCTAssertNil(discarded.finalPacket)
    XCTAssertTrue(harness.sink.acknowledgements[0].wasCancelled)
  }

  func testDiscardClearsPartialAndReturnsNothing() async throws {
    let harness = try Harness(targetFrames: 4, maximumInputFrames: 4)
    let session = try await harness.readySession()
    let partial = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0.2, -0.2]])
    await harness.audio.emitLatest(partial)

    let result = try await session.stop(.discard)
    XCTAssertNil(result.finalPacket)
    XCTAssertTrue(partial.isZeroed)
    XCTAssertTrue(harness.sink.sequences.isEmpty)
  }

  func testLifecycleAfterFailedDrainReleasePermanentlyDiscards() async throws {
    let audio = FakeAudioDriver(releaseFailures: 1)
    let harness = try Harness(audio: audio)
    let session = try await harness.readySession()
    let partial = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[1]])
    await audio.emitLatest(partial)

    await assertFailure(.stopFailed) { _ = try await session.stop(.drain) }
    XCTAssertThrowsError(try harness.core.start(configuration: harness.configuration)) {
      XCTAssertEqual(($0 as? PCMFailure)?.code, .stopFailed)
    }
    await audio.eventLatest(.routeChanged)
    let discarded = try await session.stop(.drain)
    XCTAssertNil(discarded.finalPacket)
    XCTAssertTrue(partial.isZeroed)
    XCTAssertTrue(harness.sink.sequences.isEmpty)
    XCTAssertEqual(harness.sink.terminations, [.routeChanged])
    XCTAssertEqual(audio.releaseCalls, 2)
    let replacement = try harness.core.start(configuration: harness.configuration)
    try await replacement.ready()
    _ = try await replacement.stop(.discard)
  }

  func testLifecycleAfterFailedDrainFreezePermanentlyDiscards() async throws {
    let audio = FakeAudioDriver(freezeFailures: 1)
    let harness = try Harness(audio: audio)
    let session = try await harness.readySession()
    let full = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0, 0, 0, 0]])
    let partial = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[1]])
    await audio.emitLatest(full)
    await audio.emitLatest(partial)

    await assertFailure(.stopFailed) { _ = try await session.stop(.drain) }
    XCTAssertThrowsError(try harness.core.start(configuration: harness.configuration)) {
      XCTAssertEqual(($0 as? PCMFailure)?.code, .stopFailed)
    }
    await audio.eventLatest(.backgrounded)
    let discarded = try await session.stop(.drain)
    XCTAssertNil(discarded.finalPacket)
    XCTAssertTrue(full.isZeroed)
    XCTAssertTrue(partial.isZeroed)
    XCTAssertTrue(harness.sink.acknowledgements[0].wasCancelled)
    XCTAssertEqual(harness.sink.terminations, [.backgrounded])
    XCTAssertEqual(audio.freezeCalls, 2)
    XCTAssertEqual(audio.releaseCalls, 1)
    let replacement = try harness.core.start(configuration: harness.configuration)
    try await replacement.ready()
    _ = try await replacement.stop(.discard)
  }

  func testStaleCallbacksAreInertAndClearTransferredAudio() async throws {
    let harness = try Harness(targetFrames: 2, maximumInputFrames: 2)
    let first = try await harness.readySession()
    _ = try await first.stop(.discard)
    let second = try await harness.readySession()
    let stale = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[1, 1]])

    await harness.audio.emitRetained(index: 0, frames: stale)
    XCTAssertTrue(stale.isZeroed)
    XCTAssertTrue(harness.sink.sequences.isEmpty)
    _ = try await second.stop(.discard)
  }

  func testInvalidOrOversizedInputUsesFixedCodeAndFailsSafe() async throws {
    let harness = try Harness(targetFrames: 4, maximumInputFrames: 2)
    let session = try await harness.readySession()
    let invalid = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0, 0, 0]])
    await harness.audio.emitLatest(invalid)

    try await waitUntil { harness.audio.releaseCalls == 1 }
    XCTAssertEqual(harness.sink.terminations, [.invalidPCM])
    XCTAssertTrue(invalid.isZeroed)
    _ = session
  }

  func testSourceRateChangeAndNonfiniteResamplerInputFailBeforePartialMutation() async throws {
    var resampler = try AreaWeightedPCM16Resampler(
      sourceRate: 16_000,
      targetRate: 16_000,
      maximumOutputFrames: 2
    )
    XCTAssertThrowsError(try resampler.push([0, .nan]))
    XCTAssertEqual(try resampler.push([1]), [32_767])

    let harness = try Harness()
    let session = try await harness.readySession()
    await harness.audio.emitLatest(OwnedAudioFrames(sampleRateHz: 48_000, channels: [[0]]))
    let changed = OwnedAudioFrames(sampleRateHz: 44_100, channels: [[0]])
    await harness.audio.emitLatest(changed)
    try await waitUntil { harness.audio.releaseCalls == 1 }
    XCTAssertTrue(changed.isZeroed)
    XCTAssertEqual(harness.sink.terminations, [.invalidPCM])
    _ = session
  }

  func testLifecycleEventsFailSafeWithOnlyBoundedCodes() async throws {
    let cases: [(PCMAudioEvent, PCMTerminationCode)] = [
      (.interruption, .interruption),
      (.routeChanged, .routeChanged),
      (.backgrounded, .backgrounded),
      (.permissionRevoked, .permissionRevoked),
      (.captureFailed, .captureFailed),
    ]
    for (event, expected) in cases {
      let harness = try Harness()
      let session = try await harness.readySession()
      await harness.audio.eventLatest(event)
      try await waitUntil { harness.audio.releaseCalls == 1 }
      XCTAssertEqual(harness.sink.terminations, [expected])
      _ = session
    }
  }

  func testHeartbeatRefreshMakesOldTimerStaleAndExpiryDiscards() async throws {
    let clock = ManualClock()
    let harness = try Harness(clock: clock)
    let session = try await harness.readySession()
    try await waitUntil { clock.waiterCount == 1 }
    await session.heartbeat()
    try await waitUntil { clock.waiterCount == 2 }
    clock.fire(index: 0)
    await Task.yield()
    XCTAssertTrue(harness.sink.terminations.isEmpty)
    clock.fire(index: 1)
    try await waitUntil { harness.audio.releaseCalls == 1 }
    XCTAssertEqual(harness.sink.terminations, [.heartbeatExpired])
  }

  func testSinkFailureStopsAndDoesNotExposeUnboundedErrorDetail() async throws {
    let harness = try Harness(targetFrames: 2, maximumInputFrames: 2)
    let session = try await harness.readySession()
    await harness.audio.emitLatest(OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0, 0]]))
    let stop = Task { try await session.stop(.drain) }
    try await waitUntil { harness.audio.freezeCalls == 1 }
    harness.sink.fail(0)

    let result = try await stop.value
    XCTAssertNil(result.finalPacket)
    XCTAssertEqual(harness.audio.releaseCalls, 1)
    XCTAssertEqual(harness.sink.terminations, [.sinkFailed])
    _ = session
  }
}

private struct GrantedPermission: MicrophonePermissionAuthorizing {
  func requestPermission(cancellation: StartupCancellation) async -> MicrophonePermission {
    cancellation.isCancelled ? .unavailable : .granted
  }
}

private final class LatePermission: MicrophonePermissionAuthorizing, @unchecked Sendable {
  private let gate = ManualGate<MicrophonePermission>()
  var isWaiting: Bool { gate.isWaiting }

  func requestPermission(cancellation: StartupCancellation) async -> MicrophonePermission {
    await gate.wait()
  }

  func resolve(_ value: MicrophonePermission) { gate.resolve(value) }
}

private enum FakeDriverError: Error { case failed }

private final class FakeAudioDriver: PCMAudioDriving, @unchecked Sendable {
  private let lock = NSLock()
  private let startGate: ManualGate<Void>?
  private let freezeGate: ManualGate<Void>?
  private var callbacks: [PCMAudioCallbacks] = []
  private var remainingFreezeFailures: Int
  private var remainingReleaseFailures: Int
  private var starts = 0
  private var freezes = 0
  private var releases = 0

  init(
    startGate: ManualGate<Void>? = nil,
    freezeGate: ManualGate<Void>? = nil,
    freezeFailures: Int = 0,
    releaseFailures: Int = 0
  ) {
    self.startGate = startGate
    self.freezeGate = freezeGate
    remainingFreezeFailures = freezeFailures
    remainingReleaseFailures = releaseFailures
  }

  var startCalls: Int { lock.withLock { starts } }
  var freezeCalls: Int { lock.withLock { freezes } }
  var releaseCalls: Int { lock.withLock { releases } }

  func start(
    sessionID: UInt64,
    callbacks: PCMAudioCallbacks,
    cancellation: StartupCancellation
  ) async throws {
    lock.withLock {
      starts += 1
      self.callbacks.append(callbacks)
    }
    if let startGate { await startGate.wait() }
    if cancellation.isCancelled { throw FakeDriverError.failed }
  }

  func freezeInput(sessionID: UInt64) async throws {
    let fail = lock.withLock {
      freezes += 1
      guard remainingFreezeFailures > 0 else { return false }
      remainingFreezeFailures -= 1
      return true
    }
    if let freezeGate { await freezeGate.wait() }
    if fail { throw FakeDriverError.failed }
  }

  func release(sessionID: UInt64) async throws {
    let fail = lock.withLock {
      releases += 1
      guard remainingReleaseFailures > 0 else { return false }
      remainingReleaseFailures -= 1
      return true
    }
    if fail { throw FakeDriverError.failed }
  }

  func emitLatest(_ frames: OwnedAudioFrames) async {
    let admission = offerLatest(frames)
    await admission.waitUntilConsumed()
  }

  func offerLatest(_ frames: OwnedAudioFrames) -> PCMFrameAdmission {
    guard let callback = lock.withLock({ callbacks.last }) else {
      frames.zeroize()
      return PCMFrameAdmission(accepted: false)
    }
    return callback.frames(frames)
  }

  func emitRetained(index: Int, frames: OwnedAudioFrames) async {
    guard
      let callback = lock.withLock({ callbacks.indices.contains(index) ? callbacks[index] : nil })
    else {
      frames.zeroize()
      return
    }
    let admission = callback.frames(frames)
    await admission.waitUntilConsumed()
  }

  func eventLatest(_ event: PCMAudioEvent) async {
    guard let callback = lock.withLock({ callbacks.last }) else { return }
    await callback.event(event)
  }
}

private final class ManualGate<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Value, Never>?
  private var stored: Value?
  private var waiting = false

  var isWaiting: Bool { lock.withLock { waiting } }

  func wait() async -> Value {
    await withCheckedContinuation { continuation in
      let value = lock.withLock { () -> Value? in
        if let stored {
          self.stored = nil
          return stored
        }
        waiting = true
        self.continuation = continuation
        return nil
      }
      if let value { continuation.resume(returning: value) }
    }
  }

  func resolve(_ value: Value) {
    let waiter = lock.withLock { () -> CheckedContinuation<Value, Never>? in
      waiting = false
      guard let continuation else {
        stored = value
        return nil
      }
      self.continuation = nil
      return continuation
    }
    waiter?.resume(returning: value)
  }
}

private final class ManualAcknowledgement: PCMAcknowledging, @unchecked Sendable {
  private let lock = NSLock()
  private var result: PCMAcknowledgementResult?
  private var waiters: [CheckedContinuation<PCMAcknowledgementResult, Never>] = []
  private var cancelled = false

  var wasCancelled: Bool { lock.withLock { cancelled } }

  func wait() async -> PCMAcknowledgementResult {
    if let existing = lock.withLock({ result }) { return existing }
    return await withCheckedContinuation { continuation in
      let existing = lock.withLock { () -> PCMAcknowledgementResult? in
        if let result { return result }
        waiters.append(continuation)
        return nil
      }
      if let existing { continuation.resume(returning: existing) }
    }
  }

  func cancel() {
    lock.withLock { cancelled = true }
    complete(.accepted)
  }

  func complete(_ value: PCMAcknowledgementResult) {
    let pending = lock.withLock { () -> [CheckedContinuation<PCMAcknowledgementResult, Never>] in
      guard result == nil else { return [] }
      result = value
      defer { waiters.removeAll(keepingCapacity: false) }
      return waiters
    }
    for waiter in pending { waiter.resume(returning: value) }
  }
}

private final class FakeSink: PCMEmissionSink, @unchecked Sendable {
  private let lock = NSLock()
  private var sequenceStorage: [UInt64] = []
  private var snapshotStorage: [[UInt8]] = []
  private var packetStorage: [OwnedPCMBytes] = []
  private var acknowledgementStorage: [ManualAcknowledgement] = []
  private var terminationStorage: [PCMTerminationCode] = []

  var sequences: [UInt64] { lock.withLock { sequenceStorage } }
  var snapshots: [[UInt8]] { lock.withLock { snapshotStorage } }
  var retainedPackets: [OwnedPCMBytes] { lock.withLock { packetStorage } }
  var acknowledgements: [ManualAcknowledgement] { lock.withLock { acknowledgementStorage } }
  var terminations: [PCMTerminationCode] { lock.withLock { terminationStorage } }

  func emit(_ packet: PCMEncodedPacket) throws -> any PCMAcknowledging {
    let acknowledgement = ManualAcknowledgement()
    lock.withLock {
      sequenceStorage.append(packet.sequenceNumber)
      snapshotStorage.append(packet.bytes.testingCopy())
      packetStorage.append(packet.bytes)
      acknowledgementStorage.append(acknowledgement)
    }
    return acknowledgement
  }

  func terminated(_ code: PCMTerminationCode) {
    lock.withLock { terminationStorage.append(code) }
  }

  func accept(_ index: Int) { acknowledgements[index].complete(.accepted) }
  func fail(_ index: Int) { acknowledgements[index].complete(.failed) }
}

private final class ManualClock: PCMClock, @unchecked Sendable {
  private let lock = NSLock()
  private var waiters: [CheckedContinuation<Void, Error>?] = []

  var waiterCount: Int { lock.withLock { waiters.count } }

  func sleep(nanoseconds: UInt64) async throws {
    try await withCheckedThrowingContinuation { continuation in
      lock.withLock { waiters.append(continuation) }
    }
  }

  func fire(index: Int) {
    let waiter = lock.withLock { () -> CheckedContinuation<Void, Error>? in
      guard waiters.indices.contains(index) else { return nil }
      let result = waiters[index]
      waiters[index] = nil
      return result
    }
    waiter?.resume()
  }
}

private struct Harness {
  let audio: FakeAudioDriver
  let sink: FakeSink
  let core: IOSPCMCore
  let configuration: PCMConfiguration

  init(
    permission: any MicrophonePermissionAuthorizing = GrantedPermission(),
    audio: FakeAudioDriver = FakeAudioDriver(),
    clock: any PCMClock = ManualClock(),
    targetFrames: Int = 4,
    maximumInputFrames: Int = 4
  ) throws {
    self.audio = audio
    sink = FakeSink()
    core = IOSPCMCore(permission: permission, audio: audio, sink: sink, clock: clock)
    configuration = try PCMConfiguration(
      targetFramesPerChunk: targetFrames,
      maximumChunks: 4,
      maximumInputFramesPerBuffer: maximumInputFrames,
      heartbeatTimeoutNanoseconds: 1
    )
  }

  func readySession() async throws -> IOSPCMSessionHandle {
    let session = try core.start(configuration: configuration)
    try await session.ready()
    return session
  }
}

private func assertFailure(
  _ expected: PCMErrorCode,
  operation: () async throws -> Void
) async {
  do {
    try await operation()
    XCTFail("expected \(expected.rawValue)")
  } catch {
    XCTAssertEqual((error as? PCMFailure)?.code, expected)
  }
}

private struct WaitTimeout: Error {}

private func waitUntil(_ predicate: @escaping @Sendable () -> Bool) async throws {
  for _ in 0..<500 {
    if predicate() { return }
    await Task.yield()
    try await Task.sleep(nanoseconds: 100_000)
  }
  throw WaitTimeout()
}

private func decodeFloat32LE(_ hex: String) -> [Float] {
  let bytes = hex.bytes
  return stride(from: 0, to: bytes.count, by: 4).map { offset in
    let bits =
      UInt32(bytes[offset])
      | UInt32(bytes[offset + 1]) << 8
      | UInt32(bytes[offset + 2]) << 16
      | UInt32(bytes[offset + 3]) << 24
    return Float(bitPattern: bits)
  }
}

private func encodePCM16LE(_ samples: [Int16]) -> [UInt8] {
  samples.flatMap { sample in
    let bits = UInt16(bitPattern: sample)
    return [UInt8(truncatingIfNeeded: bits), UInt8(truncatingIfNeeded: bits >> 8)]
  }
}

extension String {
  fileprivate var bytes: [UInt8] {
    stride(from: 0, to: count, by: 2).map { offset in
      let start = index(startIndex, offsetBy: offset)
      let end = index(start, offsetBy: 2)
      return UInt8(self[start..<end], radix: 16)!
    }
  }
}

extension Array where Element == UInt8 {
  fileprivate var hex: String { map { String(format: "%02x", $0) }.joined() }
}
