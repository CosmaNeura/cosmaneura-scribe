import CosmaneuraIOSAVFoundationDriver
import Foundation
import XCTest

@testable import CosmaneuraIOSPCMBridgeCore
@testable import CosmaneuraIOSPCMCore

final class IOSPCMBridgeCoreTests: XCTestCase, @unchecked Sendable {
  func testPublicCodesExactlyMatchDormantTypeScriptBoundary() {
    XCTAssertEqual(
      [
        IOSPCMBridgeStartErrorCode.permissionDenied.rawValue,
        IOSPCMBridgeStartErrorCode.permissionRestricted.rawValue,
        IOSPCMBridgeStartErrorCode.microphoneUnavailable.rawValue,
        IOSPCMBridgeStartErrorCode.notForeground.rawValue,
        IOSPCMBridgeStartErrorCode.startFailed.rawValue,
      ],
      [
        "ios_microphone_permission_denied",
        "ios_microphone_permission_restricted",
        "ios_microphone_unavailable",
        "ios_capture_not_foreground",
        "ios_capture_start_failed",
      ]
    )
    XCTAssertEqual(
      [
        IOSPCMBridgeInterruptionCode.audioSessionInterrupted.rawValue,
        IOSPCMBridgeInterruptionCode.audioRouteChanged.rawValue,
        IOSPCMBridgeInterruptionCode.captureBackgrounded.rawValue,
      ],
      [
        "ios_audio_session_interrupted",
        "ios_audio_route_changed",
        "ios_capture_backgrounded",
      ]
    )
    XCTAssertEqual(
      [
        IOSPCMBridgeTerminalErrorCode.microphonePermissionRevoked.rawValue,
        IOSPCMBridgeTerminalErrorCode.captureStalled.rawValue,
        IOSPCMBridgeTerminalErrorCode.captureFailed.rawValue,
      ],
      [
        "ios_microphone_permission_revoked",
        "ios_capture_stalled",
        "ios_capture_failed",
      ]
    )
    XCTAssertEqual(IOSPCMBridgeErrorCode.captureFailed.rawValue, "ios_capture_failed")
    XCTAssertEqual(IOSPCMBridgeErrorCode.stopFailed.rawValue, "ios_capture_stop_failed")
  }

  func testBeginReturnsOpaqueOwnershipBeforePermissionReadinessAndStopCancelsIt() async throws {
    let permission = WaitingPermission()
    let harness = BridgeHarness(permission: permission)

    let token = try harness.bridge.begin(configuration: harness.configuration)
    let readiness = Task { try await harness.bridge.ready(token) }
    XCTAssertEqual(token.rawValue, "1.fixed")
    try await waitUntil { permission.isWaiting }

    let stopped = try await harness.bridge.stop(token, mode: .discard)
    XCTAssertNil(stopped.finalPacket)
    await assertStartFailure(.startFailed) { try await readiness.value }
    XCTAssertEqual(harness.audio.startCalls, 0)
    XCTAssertEqual(harness.audio.releaseCalls, 1)
  }

  func testAppStateAndPermissionFailuresUseOnlyContractCodes() async throws {
    let background = BridgeHarness(foreground: FixedForeground(false))
    let state = await background.bridge.appState()
    XCTAssertEqual(state, .background)

    for (permission, expected) in [
      (MicrophonePermission.denied, IOSPCMBridgeStartErrorCode.permissionDenied),
      (.restricted, .permissionRestricted),
      (.unavailable, .microphoneUnavailable),
    ] {
      let harness = BridgeHarness(permission: FixedPermission(permission))
      let token = try harness.bridge.begin(configuration: harness.configuration)
      await assertStartFailure(expected) { try await harness.bridge.ready(token) }
    }
  }

  func testPacketReplayAcknowledgementBackpressureAndZeroization() async throws {
    let harness = BridgeHarness(targetFrames: 2)
    let token = try await harness.readyToken()
    let firstFrames = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0.5, -0.5]])
    let firstReceipt = harness.audio.offerLatest(firstFrames)
    await firstReceipt.waitUntilConsumed()
    try await waitUntil { harness.events.packetCount == 1 }

    let packet = try XCTUnwrap(harness.events.packets.first)
    XCTAssertEqual(harness.events.packetSnapshots, [[0x00, 0x40, 0x00, 0xc0]])
    XCTAssertFalse(packet.bytes.isZeroized)
    XCTAssertEqual(
      harness.bridge.replayPendingPacket(token, sequenceNumber: 0),
      .replayed
    )
    XCTAssertEqual(harness.events.packetCount, 2)
    XCTAssertEqual(harness.events.packets[0] === harness.events.packets[1], true)

    let second = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0.25, -0.25]])
    let secondReceipt = harness.audio.offerLatest(second)
    await secondReceipt.waitUntilConsumed()
    XCTAssertEqual(harness.events.packetCount, 2)

    XCTAssertEqual(harness.bridge.acknowledge(token, sequenceNumber: 0), .accepted)
    try await waitUntil { harness.events.packetCount == 3 }
    XCTAssertTrue(packet.bytes.isZeroized)
    XCTAssertEqual(harness.bridge.acknowledge(token, sequenceNumber: 0), .replayed)
    XCTAssertEqual(
      harness.bridge.replayPendingPacket(token, sequenceNumber: 0),
      .alreadyAcknowledged
    )
    XCTAssertEqual(harness.bridge.acknowledge(token, sequenceNumber: 1), .accepted)
    _ = try await harness.bridge.stop(token, mode: .discard)
    XCTAssertTrue(firstFrames.isZeroed)
    XCTAssertTrue(second.isZeroed)
  }

  func testConcurrentAcknowledgementsHaveOneWinnerAndClearBytes() async throws {
    let harness = BridgeHarness(targetFrames: 1)
    let token = try await harness.readyToken()
    await harness.audio.emitLatest(
      OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0.25]])
    )
    let packet = try XCTUnwrap(harness.events.packets.first)

    let results = await withTaskGroup(
      of: IOSPCMBridgeAcknowledgementResult.self,
      returning: [IOSPCMBridgeAcknowledgementResult].self
    ) { group in
      for _ in 0..<16 {
        group.addTask { harness.bridge.acknowledge(token, sequenceNumber: 0) }
      }
      var values: [IOSPCMBridgeAcknowledgementResult] = []
      for await value in group { values.append(value) }
      return values
    }

    XCTAssertEqual(results.filter { $0 == .accepted }.count, 1)
    XCTAssertEqual(results.filter { $0 == .replayed }.count, 15)
    XCTAssertTrue(packet.bytes.isZeroized)
    _ = try await harness.bridge.stop(token, mode: .discard)
  }

  func testAcknowledgementRacingRetirementIsAcceptedOrStaleNeverReplayed() async throws {
    let harness = BridgeHarness(targetFrames: 1)
    for _ in 0..<24 {
      let token = try await harness.readyToken()
      await harness.audio.emitLatest(
        OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0.25]])
      )
      let packet = try XCTUnwrap(harness.events.packets.last)
      let acknowledgement = Task {
        harness.bridge.acknowledge(token, sequenceNumber: 0)
      }
      let retirement = Task {
        try await harness.bridge.stop(token, mode: .discard)
      }
      let acknowledged = await acknowledgement.value
      _ = try await retirement.value
      XCTAssertTrue(acknowledged == .accepted || acknowledged == .stale)
      XCTAssertNotEqual(acknowledged, .replayed)
      XCTAssertTrue(packet.bytes.isZeroized)
    }
  }

  func testReplayLeaseDefersAckZeroizationUntilPublicationReturns() async throws {
    let events = RecordingEvents(blockPacketNumber: 2)
    let harness = BridgeHarness(events: events, targetFrames: 1)
    let token = try await harness.readyToken()
    await harness.audio.emitLatest(
      OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0.5]])
    )
    let packet = try XCTUnwrap(events.packets.first)

    let replay = Task {
      harness.bridge.replayPendingPacket(token, sequenceNumber: 0)
    }
    try await waitUntil { events.isPacketBlocked }
    XCTAssertEqual(harness.bridge.acknowledge(token, sequenceNumber: 0), .accepted)
    XCTAssertFalse(packet.bytes.isZeroized)
    events.releaseBlockedPacket()
    let replayed = await replay.value
    XCTAssertEqual(replayed, .replayed)
    try await waitUntil { packet.bytes.isZeroized }
    _ = try await harness.bridge.stop(token, mode: .discard)
  }

  func testRetirementDuringReplayWinsAsStaleAfterPublisherReleases() async throws {
    let events = RecordingEvents(blockPacketNumber: 2)
    let harness = BridgeHarness(events: events, targetFrames: 1)
    let token = try await harness.readyToken()
    await harness.audio.emitLatest(
      OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0.5]])
    )
    let packet = try XCTUnwrap(events.packets.first)

    let replay = Task {
      harness.bridge.replayPendingPacket(token, sequenceNumber: 0)
    }
    try await waitUntil { events.isPacketBlocked }
    let retirement = Task { try await harness.bridge.stop(token, mode: .discard) }
    try await waitUntil { harness.audio.freezeCalls == 1 }
    XCTAssertFalse(packet.bytes.isZeroized)
    events.releaseBlockedPacket()

    let replayed = await replay.value
    XCTAssertEqual(replayed, .stale)
    _ = try await retirement.value
    XCTAssertTrue(packet.bytes.isZeroized)
  }

  func testDiscardCancelsPendingPacketAndMakesOldTokenStale() async throws {
    let harness = BridgeHarness(targetFrames: 1)
    let first = try await harness.readyToken()
    await harness.audio.emitLatest(
      OwnedAudioFrames(sampleRateHz: 16_000, channels: [[1]])
    )
    let packet = try XCTUnwrap(harness.events.packets.first)

    _ = try await harness.bridge.stop(first, mode: .discard)
    XCTAssertTrue(packet.bytes.isZeroized)
    XCTAssertEqual(harness.bridge.acknowledge(first, sequenceNumber: 0), .stale)
    XCTAssertEqual(
      harness.bridge.replayPendingPacket(first, sequenceNumber: 0),
      .stale
    )

    let second = try await harness.readyToken()
    XCTAssertEqual(second.rawValue, "2.fixed")
    XCTAssertNotEqual(first, second)
    await harness.audio.emitRetained(
      index: 0,
      frames: OwnedAudioFrames(sampleRateHz: 16_000, channels: [[1]])
    )
    XCTAssertEqual(harness.events.packetCount, 1)
    _ = try await harness.bridge.stop(second, mode: .discard)
  }

  func testFailedCloseRetainsTokenAndBlocksRestartUntilRetry() async throws {
    let audio = FakeBridgeAudioDriver(releaseFailures: 1)
    let harness = BridgeHarness(audio: audio)
    let token = try await harness.readyToken()

    await assertBridgeFailure(.stopFailed) {
      _ = try await harness.bridge.stop(token, mode: .discard)
    }
    await assertStartFailure(.startFailed) {
      _ = try harness.bridge.begin(configuration: harness.configuration)
    }

    _ = try await harness.bridge.stop(token, mode: .discard)
    let replacement = try await harness.readyToken()
    XCTAssertNotEqual(replacement, token)
    _ = try await harness.bridge.stop(replacement, mode: .discard)
  }

  func testReadinessCannotRetireTokenWhileCancelledCloseNeedsRetry() async throws {
    let permission = WaitingPermission()
    let audio = FakeBridgeAudioDriver(freezeFailures: 1)
    let harness = BridgeHarness(permission: permission, audio: audio)
    let token = try harness.bridge.begin(configuration: harness.configuration)
    let readiness = Task { try await harness.bridge.ready(token) }
    try await waitUntil { permission.isWaiting }

    await assertBridgeFailure(.stopFailed) {
      _ = try await harness.bridge.stop(token, mode: .discard)
    }
    await assertStartFailure(.startFailed) { try await readiness.value }
    await assertStartFailure(.startFailed) {
      _ = try harness.bridge.begin(configuration: harness.configuration)
    }

    _ = try await harness.bridge.stop(token, mode: .discard)
    let replacement = try harness.bridge.begin(configuration: harness.configuration)
    let replacementReadiness = Task { try await harness.bridge.ready(replacement) }
    try await waitUntil { permission.isWaiting }
    _ = try await harness.bridge.stop(replacement, mode: .discard)
    await assertStartFailure(.startFailed) { try await replacementReadiness.value }
  }

  func testStartupTerminalKeepsTokenWhenAutomaticCloseNeedsRetry() async throws {
    let startGate = ManualGate<Void>()
    let audio = FakeBridgeAudioDriver(
      startGate: startGate,
      startupEvent: .captureFailed,
      releaseFailures: 2
    )
    let harness = BridgeHarness(audio: audio)
    let token = try harness.bridge.begin(configuration: harness.configuration)
    let readiness = Task { try await harness.bridge.ready(token) }

    try await waitUntil { harness.events.terminalCodes == [.captureFailed] }
    try await waitUntil { audio.releaseCalls >= 2 }
    startGate.resolve(())
    await assertStartFailure(.startFailed) { try await readiness.value }
    await assertStartFailure(.startFailed) {
      _ = try harness.bridge.begin(configuration: harness.configuration)
    }

    try await stopEventually(harness.bridge, token: token)
    let replacement = try await harness.readyToken()
    _ = try await harness.bridge.stop(replacement, mode: .discard)
  }

  func testImmediateStartupTerminalIsNotLostAcrossRegistryBinding() async throws {
    let audio = FakeBridgeAudioDriver(startupEvent: .captureFailed)
    let harness = BridgeHarness(audio: audio)
    let token = try harness.bridge.begin(configuration: harness.configuration)

    await assertStartFailure(.startFailed) { try await harness.bridge.ready(token) }
    try await waitUntil { harness.events.terminalCodes == [.captureFailed] }
    try await waitUntil { audio.releaseCalls == 1 }
    _ = try await harness.bridge.stop(token, mode: .discard)
  }

  func testConcurrentDiscardDominatesDrainAndClearsPartial() async throws {
    let freezeGate = ManualGate<Void>()
    let audio = FakeBridgeAudioDriver(freezeGate: freezeGate)
    let harness = BridgeHarness(audio: audio, targetFrames: 4)
    let token = try await harness.readyToken()
    await audio.emitLatest(OwnedAudioFrames(sampleRateHz: 16_000, channels: [[1]]))

    let drain = Task { try await harness.bridge.stop(token, mode: .drain) }
    try await waitUntil { audio.freezeCalls == 1 }
    let discard = Task { try await harness.bridge.stop(token, mode: .discard) }
    freezeGate.resolve(())

    let drained = try await drain.value
    let discarded = try await discard.value
    XCTAssertNil(drained.finalPacket)
    XCTAssertNil(discarded.finalPacket)
  }

  func testConcurrentDiscardUpgradeConvergesWhenDrainCloseFails() async throws {
    let freezeGate = ManualGate<Void>()
    let audio = FakeBridgeAudioDriver(freezeGate: freezeGate, freezeFailures: 1)
    let harness = BridgeHarness(audio: audio, targetFrames: 4)
    let token = try await harness.readyToken()
    await audio.emitLatest(OwnedAudioFrames(sampleRateHz: 16_000, channels: [[1]]))

    let drain = Task { try await harness.bridge.stop(token, mode: .drain) }
    try await waitUntil { audio.freezeCalls == 1 }
    let discard = Task { try await harness.bridge.stop(token, mode: .discard) }
    freezeGate.resolve(())

    let results = try await [drain.value, discard.value]
    XCTAssertTrue(results.allSatisfy { $0.finalPacket == nil })
    XCTAssertEqual(audio.freezeCalls, 2)
    XCTAssertEqual(audio.releaseCalls, 1)

    let replacement = try await harness.readyToken()
    _ = try await harness.bridge.stop(replacement, mode: .discard)
  }

  func testConcurrentDrainCallersCoalesceAndOneReceivesFinalPartial() async throws {
    let freezeGate = ManualGate<Void>()
    let audio = FakeBridgeAudioDriver(freezeGate: freezeGate)
    let harness = BridgeHarness(audio: audio, targetFrames: 4)
    let token = try await harness.readyToken()
    await audio.emitLatest(OwnedAudioFrames(sampleRateHz: 16_000, channels: [[1]]))

    let first = Task { try await harness.bridge.stop(token, mode: .drain) }
    try await waitUntil { audio.freezeCalls == 1 }
    let second = Task { try await harness.bridge.stop(token, mode: .drain) }
    freezeGate.resolve(())
    let results = try await [first.value, second.value]
    let packets = results.compactMap(\.finalPacket)

    XCTAssertEqual(audio.freezeCalls, 1)
    XCTAssertEqual(audio.releaseCalls, 1)
    XCTAssertEqual(packets.count, 1)
    XCTAssertEqual(packets.first?.bytes.snapshot, [0xff, 0x7f])
    packets.first?.bytes.zeroize()
  }

  func testDrainReturnsOneOwnedPartialAndCallerCanClearIt() async throws {
    let harness = BridgeHarness(targetFrames: 4)
    let token = try await harness.readyToken()
    await harness.audio.emitLatest(
      OwnedAudioFrames(sampleRateHz: 16_000, channels: [[1]])
    )

    let result = try await harness.bridge.stop(token, mode: .drain)
    let packet = try XCTUnwrap(result.finalPacket)
    XCTAssertEqual(packet.sequenceNumber, 0)
    XCTAssertEqual(packet.bytes.snapshot, [0xff, 0x7f])
    packet.bytes.zeroize()
    XCTAssertTrue(packet.bytes.isZeroized)
  }

  func testLifecycleCodesAreExactAndAutomaticCloseAllowsNextGeneration() async throws {
    let harness = BridgeHarness()
    let token = try await harness.readyToken()
    await harness.audio.eventLatest(.permissionRevoked)

    try await waitUntil { harness.events.terminalCodes == [.microphonePermissionRevoked] }
    try await waitUntil { harness.audio.releaseCalls == 1 }
    let replacement = try await beginEventually(
      harness.bridge,
      configuration: harness.configuration
    )
    try await harness.bridge.ready(replacement)
    // Automatic close and retirement won before this old-handle retry.
    _ = try await harness.bridge.stop(token, mode: .discard)
    XCTAssertEqual(harness.events.terminalCodes, [.microphonePermissionRevoked])
    XCTAssertEqual(harness.bridge.acknowledge(token, sequenceNumber: 0), .stale)
    _ = try await harness.bridge.stop(replacement, mode: .discard)
  }

  func testExplicitStopConvergesWithAutomaticTerminalClose() async throws {
    let releaseGate = ManualGate<Void>()
    let audio = FakeBridgeAudioDriver(releaseGate: releaseGate)
    let harness = BridgeHarness(audio: audio)
    let token = try await harness.readyToken()

    await audio.eventLatest(.backgrounded)
    let explicit = Task { try await harness.bridge.stop(token, mode: .discard) }
    try await waitUntil { audio.releaseCalls == 1 }
    releaseGate.resolve(())
    _ = try await explicit.value
    XCTAssertEqual(audio.releaseCalls, 1)

    let replacement = try await harness.readyToken()
    _ = try await harness.bridge.stop(replacement, mode: .discard)
  }

  func testTransportFailureClearsPacketAndTerminatesWithBoundedCode() async throws {
    let events = RecordingEvents(failNextPacket: true)
    let harness = BridgeHarness(events: events, targetFrames: 1)
    _ = try await harness.readyToken()
    await harness.audio.emitLatest(
      OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0.5]])
    )

    try await waitUntil { events.terminalCodes == [.captureFailed] }
    let packet = try XCTUnwrap(events.packets.first)
    XCTAssertTrue(packet.bytes.isZeroized)
    try await waitUntil { harness.audio.releaseCalls == 1 }
  }

  func testInvalidConfigurationAndTokenSourceFailBeforeAudio() async {
    let harness = BridgeHarness()
    let invalid = IOSPCMBridgeConfiguration(
      encoding: "wav",
      channels: 2,
      sampleRateHz: 44_100,
      targetFramesPerChunk: 0,
      maximumChunks: 0
    )
    await assertStartFailure(.startFailed) {
      _ = try harness.bridge.begin(configuration: invalid)
    }
    XCTAssertEqual(harness.audio.startCalls, 0)

    let invalidToken = BridgeHarness(tokenSource: { "not valid" })
    await assertStartFailure(.startFailed) {
      _ = try invalidToken.bridge.begin(configuration: invalidToken.configuration)
    }
    XCTAssertEqual(invalidToken.audio.startCalls, 0)
  }
}

private struct FixedPermission: MicrophonePermissionAuthorizing {
  let value: MicrophonePermission

  init(_ value: MicrophonePermission) { self.value = value }

  func requestPermission(cancellation: StartupCancellation) async -> MicrophonePermission {
    cancellation.isCancelled ? .unavailable : value
  }
}

private final class WaitingPermission: MicrophonePermissionAuthorizing, @unchecked Sendable {
  private let lock = NSLock()
  private var waiting = false
  var isWaiting: Bool { lock.withLock { waiting } }

  func requestPermission(cancellation: StartupCancellation) async -> MicrophonePermission {
    lock.withLock { waiting = true }
    await cancellation.waitUntilCancelled()
    lock.withLock { waiting = false }
    return .unavailable
  }
}

private struct FixedForeground: AppleApplicationForegroundProviding {
  let active: Bool
  init(_ active: Bool = true) { self.active = active }
  func isForegroundActive() async -> Bool { active }
}

private enum FakeBridgeAudioError: Error { case failed }

private final class FakeBridgeAudioDriver: PCMAudioDriving, @unchecked Sendable {
  private let lock = NSLock()
  private let startGate: ManualGate<Void>?
  private let freezeGate: ManualGate<Void>?
  private let releaseGate: ManualGate<Void>?
  private var remainingStartupEvent: PCMAudioEvent?
  private var remainingFreezeFailures: Int
  private var callbacks: [PCMAudioCallbacks] = []
  private var remainingReleaseFailures: Int
  private var starts = 0
  private var freezes = 0
  private var releases = 0

  init(
    startGate: ManualGate<Void>? = nil,
    freezeGate: ManualGate<Void>? = nil,
    releaseGate: ManualGate<Void>? = nil,
    startupEvent: PCMAudioEvent? = nil,
    freezeFailures: Int = 0,
    releaseFailures: Int = 0
  ) {
    self.startGate = startGate
    self.freezeGate = freezeGate
    self.releaseGate = releaseGate
    remainingStartupEvent = startupEvent
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
    let startup = lock.withLock { () -> (event: PCMAudioEvent?, wait: Bool) in
      let wait = starts == 0 && startGate != nil
      starts += 1
      self.callbacks.append(callbacks)
      defer { remainingStartupEvent = nil }
      return (remainingStartupEvent, wait)
    }
    if let startupEvent = startup.event { await callbacks.event(startupEvent) }
    if startup.wait, let startGate { await startGate.wait() }
    if cancellation.isCancelled { throw FakeBridgeAudioError.failed }
  }

  func freezeInput(sessionID: UInt64) async throws {
    let disposition = lock.withLock { () -> (fail: Bool, wait: Bool) in
      let shouldWait = freezes == 0 && freezeGate != nil
      freezes += 1
      guard remainingFreezeFailures > 0 else { return (false, shouldWait) }
      remainingFreezeFailures -= 1
      return (true, shouldWait)
    }
    if disposition.wait, let freezeGate { await freezeGate.wait() }
    if disposition.fail { throw FakeBridgeAudioError.failed }
  }

  func release(sessionID: UInt64) async throws {
    let disposition = lock.withLock { () -> (fail: Bool, wait: Bool) in
      releases += 1
      let shouldWait = releases == 1 && releaseGate != nil
      guard remainingReleaseFailures > 0 else { return (false, shouldWait) }
      remainingReleaseFailures -= 1
      return (true, shouldWait)
    }
    if disposition.wait, let releaseGate { await releaseGate.wait() }
    if disposition.fail { throw FakeBridgeAudioError.failed }
  }

  func offerLatest(_ frames: OwnedAudioFrames) -> PCMFrameAdmission {
    guard let callback = lock.withLock({ callbacks.last }) else {
      frames.zeroize()
      preconditionFailure("missing callback")
    }
    return callback.frames(frames)
  }

  func emitLatest(_ frames: OwnedAudioFrames) async {
    await offerLatest(frames).waitUntilConsumed()
  }

  func emitRetained(index: Int, frames: OwnedAudioFrames) async {
    guard
      let callback = lock.withLock({ callbacks.indices.contains(index) ? callbacks[index] : nil })
    else {
      frames.zeroize()
      return
    }
    let receipt = callback.frames(frames)
    await receipt.waitUntilConsumed()
  }

  func eventLatest(_ event: PCMAudioEvent) async {
    guard let callback = lock.withLock({ callbacks.last }) else { return }
    await callback.event(event)
  }
}

private final class RecordingEvents: IOSPCMBridgeEventPublishing, @unchecked Sendable {
  private let lock = NSLock()
  private var eventStorage: [IOSPCMBridgeEvent] = []
  private var packetStorage: [IOSPCMBridgePacket] = []
  private var packetSnapshotStorage: [[UInt8]] = []
  private var terminalStorage: [IOSPCMBridgeTerminalErrorCode] = []
  private var failPacket: Bool
  private let blockPacketNumber: Int?
  private let packetBlock = DispatchSemaphore(value: 0)
  private var packetBlocked = false

  init(failNextPacket: Bool = false, blockPacketNumber: Int? = nil) {
    failPacket = failNextPacket
    self.blockPacketNumber = blockPacketNumber
  }

  var packetCount: Int { lock.withLock { packetStorage.count } }
  var packets: [IOSPCMBridgePacket] { lock.withLock { packetStorage } }
  var packetSnapshots: [[UInt8]] { lock.withLock { packetSnapshotStorage } }
  var terminalCodes: [IOSPCMBridgeTerminalErrorCode] { lock.withLock { terminalStorage } }
  var isPacketBlocked: Bool { lock.withLock { packetBlocked } }

  func releaseBlockedPacket() { packetBlock.signal() }

  func publish(_ event: IOSPCMBridgeEvent) throws {
    switch event {
    case .packetAvailable(let packet):
      let snapshot = packet.bytes.snapshot
      let disposition = lock.withLock { () -> (fail: Bool, block: Bool) in
        eventStorage.append(event)
        packetStorage.append(packet)
        packetSnapshotStorage.append(snapshot)
        let shouldBlock = packetStorage.count == blockPacketNumber
        if shouldBlock { packetBlocked = true }
        let shouldFail = failPacket
        failPacket = false
        return (shouldFail, shouldBlock)
      }
      if disposition.block { packetBlock.wait() }
      if disposition.fail { throw FakeBridgeAudioError.failed }
    case .terminal(_, let code):
      lock.withLock {
        eventStorage.append(event)
        terminalStorage.append(code)
      }
    case .interruption:
      lock.withLock { eventStorage.append(event) }
    }
  }
}

private final class ManualGate<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Value, Never>?
  private var stored: Value?

  func wait() async -> Value {
    await withCheckedContinuation { continuation in
      let immediate = lock.withLock { () -> Value? in
        if let stored {
          self.stored = nil
          return stored
        }
        self.continuation = continuation
        return nil
      }
      if let immediate { continuation.resume(returning: immediate) }
    }
  }

  func resolve(_ value: Value) {
    let waiter = lock.withLock { () -> CheckedContinuation<Value, Never>? in
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

private struct BridgeHarness {
  let audio: FakeBridgeAudioDriver
  let events: RecordingEvents
  let bridge: IOSPCMBridgeCore
  let configuration: IOSPCMBridgeConfiguration

  init(
    permission: any MicrophonePermissionAuthorizing = FixedPermission(.granted),
    audio: FakeBridgeAudioDriver = FakeBridgeAudioDriver(),
    foreground: any AppleApplicationForegroundProviding = FixedForeground(),
    events: RecordingEvents = RecordingEvents(),
    targetFrames: Int = 4,
    tokenSource: @escaping @Sendable () -> String = { "fixed" }
  ) {
    self.audio = audio
    self.events = events
    bridge = IOSPCMBridgeCore(
      permission: permission,
      audio: audio,
      foreground: foreground,
      events: events,
      tokenSource: tokenSource
    )
    configuration = IOSPCMBridgeConfiguration(
      encoding: PCMConfiguration.encoding,
      channels: PCMConfiguration.channels,
      sampleRateHz: PCMConfiguration.sampleRateHz,
      targetFramesPerChunk: targetFrames,
      maximumChunks: 4
    )
  }

  func readyToken() async throws -> IOSPCMBridgeSessionToken {
    let token = try bridge.begin(configuration: configuration)
    try await bridge.ready(token)
    return token
  }
}

extension IOSPCMBridgeOwnedBytes {
  fileprivate var snapshot: [UInt8] { withUnsafeBytes { Array($0) } }
}

private func assertStartFailure(
  _ expected: IOSPCMBridgeStartErrorCode,
  operation: () async throws -> Void
) async {
  do {
    try await operation()
    XCTFail("expected \(expected.rawValue)")
  } catch {
    XCTAssertEqual((error as? IOSPCMBridgeStartFailure)?.code, expected)
  }
}

private func assertBridgeFailure(
  _ expected: IOSPCMBridgeErrorCode,
  operation: () async throws -> Void
) async {
  do {
    try await operation()
    XCTFail("expected \(expected.rawValue)")
  } catch {
    XCTAssertEqual((error as? IOSPCMBridgeFailure)?.code, expected)
  }
}

private struct WaitTimeout: Error {}

private func waitUntil(_ predicate: @escaping @Sendable () -> Bool) async throws {
  for _ in 0..<1_000 {
    if predicate() { return }
    await Task.yield()
    try await Task.sleep(nanoseconds: 100_000)
  }
  throw WaitTimeout()
}

private func beginEventually(
  _ bridge: IOSPCMBridgeCore,
  configuration: IOSPCMBridgeConfiguration
) async throws -> IOSPCMBridgeSessionToken {
  for _ in 0..<1_000 {
    if let token = try? bridge.begin(configuration: configuration) { return token }
    await Task.yield()
    try await Task.sleep(nanoseconds: 100_000)
  }
  throw WaitTimeout()
}

private func stopEventually(
  _ bridge: IOSPCMBridgeCore,
  token: IOSPCMBridgeSessionToken
) async throws {
  for _ in 0..<1_000 {
    do {
      _ = try await bridge.stop(token, mode: .discard)
      return
    } catch let failure as IOSPCMBridgeFailure where failure.code == .stopFailed {
      await Task.yield()
      try await Task.sleep(nanoseconds: 100_000)
    }
  }
  throw WaitTimeout()
}
