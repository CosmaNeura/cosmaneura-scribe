import CosmaneuraIOSPCMBridgeCore
import Foundation
import XCTest

@testable import CosmaneuraIOSPCMCapacitorTransport

final class IOSPCMCapacitorTransportTests: XCTestCase {
  func testConfigurationRequiresExactBoundedPCMContract() throws {
    XCTAssertNoThrow(try configuration())
    XCTAssertThrowsError(try configuration(encoding: "pcm_f32le"))
    XCTAssertThrowsError(try configuration(channels: 2))
    XCTAssertThrowsError(try configuration(sampleRateHz: 48_000))
    XCTAssertThrowsError(try configuration(targetFramesPerChunk: 0))
    XCTAssertThrowsError(try configuration(targetFramesPerChunk: 960_001))
    XCTAssertThrowsError(try configuration(maximumChunks: 0))
    XCTAssertThrowsError(try configuration(maximumChunks: 8_641))
  }

  func testStartReturnsOpaqueTokenAndPassesExactConfiguration() throws {
    let bridge = FakeBridge()
    let transport = IOSPCMCapacitorTransport(bridge: bridge)

    XCTAssertEqual(try transport.start(configuration: configuration()), "1.fragment_1")
    XCTAssertEqual(
      bridge.configuration,
      IOSPCMBridgeConfiguration(
        encoding: "pcm_s16le",
        channels: 1,
        sampleRateHz: 16_000,
        targetFramesPerChunk: 1_600,
        maximumChunks: 100
      )
    )
  }

  func testReadyPreservesEveryFixedStartCode() async throws {
    let cases: [(IOSPCMBridgeStartErrorCode, IOSPCMCapacitorErrorCode)] = [
      (.permissionDenied, .microphonePermissionDenied),
      (.permissionRestricted, .microphonePermissionRestricted),
      (.microphoneUnavailable, .microphoneUnavailable),
      (.notForeground, .notForeground),
      (.startFailed, .startFailed),
    ]
    for (bridgeCode, expected) in cases {
      let bridge = FakeBridge()
      bridge.readyError = IOSPCMBridgeStartFailure(bridgeCode)
      let transport = IOSPCMCapacitorTransport(bridge: bridge)
      do {
        try await transport.ready(sessionToken: "1.fragment_1")
        XCTFail("expected ready failure")
      } catch let error as IOSPCMCapacitorErrorCode {
        XCTAssertEqual(error, expected)
      }
    }

    let staleBridge = FakeBridge()
    staleBridge.readyError = IOSPCMBridgeFailure(.captureFailed)
    let staleTransport = IOSPCMCapacitorTransport(bridge: staleBridge)
    do {
      try await staleTransport.ready(sessionToken: "1.fragment_1")
      XCTFail("expected stale-token failure")
    } catch let error as IOSPCMCapacitorErrorCode {
      XCTAssertEqual(error, .captureFailed)
    }
  }

  func testRejectsMalformedTokensAndOutOfRangeSequencesBeforeBridge() throws {
    let bridge = FakeBridge()
    let transport = IOSPCMCapacitorTransport(bridge: bridge)
    for token in ["", "0.fragment", "01.fragment", "1.", "1.bad token", "1.a.b"] {
      XCTAssertThrowsError(
        try transport.acknowledge(sessionToken: token, sequenceNumber: 0)
      )
    }
    XCTAssertThrowsError(
      try transport.acknowledge(sessionToken: "1.fragment", sequenceNumber: -1)
    )
    XCTAssertThrowsError(
      try transport.acknowledge(sessionToken: "1.fragment", sequenceNumber: 8_640)
    )
    XCTAssertEqual(bridge.acknowledgeCalls, 0)
  }

  func testAcknowledgementAndReplayRemainDistinct() throws {
    let bridge = FakeBridge()
    let transport = IOSPCMCapacitorTransport(bridge: bridge)

    for (source, expected) in [
      (IOSPCMBridgeAcknowledgementResult.accepted, IOSPCMCapacitorAcknowledgement.accepted),
      (.replayed, .replayed),
      (.stale, .stale),
    ] {
      bridge.acknowledgement = source
      XCTAssertEqual(
        try transport.acknowledge(sessionToken: "1.fragment", sequenceNumber: 2),
        expected
      )
    }
    for (source, expected) in [
      (IOSPCMBridgeReplayResult.replayed, IOSPCMCapacitorReplay.replayed),
      (.alreadyAcknowledged, .alreadyAcknowledged),
      (.stale, .stale),
      (.transportFailed, .transportFailed),
    ] {
      bridge.replay = source
      XCTAssertEqual(
        try transport.replayPendingPacket(sessionToken: "1.fragment", sequenceNumber: 2),
        expected
      )
    }
  }

  func testStopPreservesModeAndFixedFailureCode() async throws {
    let bridge = FakeBridge()
    let transport = IOSPCMCapacitorTransport(bridge: bridge)

    _ = try await transport.stop(sessionToken: "1.fragment", mode: .discard)
    XCTAssertEqual(bridge.stopMode, .discard)

    bridge.stopError = IOSPCMBridgeFailure(.stopFailed)
    do {
      _ = try await transport.stop(sessionToken: "1.fragment", mode: .drain)
      XCTFail("expected stop failure")
    } catch let error as IOSPCMCapacitorErrorCode {
      XCTAssertEqual(error, .stopFailed)
    }
  }

  func testLifecycleEventsUseExactCodes() throws {
    let emitter = RecordingEmitter()
    let publisher = IOSPCMCapacitorEventPublisher(emitter: emitter)
    let token = IOSPCMBridgeSessionToken(rawValue: "2.fragment-2")

    try publisher.publish(.interruption(token, .captureBackgrounded))
    try publisher.publish(.terminal(token, .microphonePermissionRevoked))

    XCTAssertEqual(
      emitter.events,
      [
        .interruption(
          sessionToken: "2.fragment-2",
          code: "ios_capture_backgrounded"
        ),
        .terminal(
          sessionToken: "2.fragment-2",
          code: "ios_microphone_permission_revoked"
        ),
      ]
    )
  }

  func testBase64ScratchClearsItsMutableCopy() {
    var source = [UInt8](repeating: 0x41, count: 32)
    var scratch = source.withUnsafeBytes { IOSPCMBase64Scratch(copying: $0) }

    XCTAssertEqual(scratch.encodeAndClear(), Data(source).base64EncodedString())
    XCTAssertTrue(scratch.isZeroized)
    XCTAssertEqual(source, [UInt8](repeating: 0x41, count: 32))

    _ = source.withUnsafeMutableBytes {
      $0.initializeMemory(as: UInt8.self, repeating: 0)
    }
  }
}

private func configuration(
  encoding: String = "pcm_s16le",
  channels: Int = 1,
  sampleRateHz: Int = 16_000,
  targetFramesPerChunk: Int = 1_600,
  maximumChunks: Int = 100
) throws -> IOSPCMCapacitorConfiguration {
  try IOSPCMCapacitorConfiguration(
    encoding: encoding,
    channels: channels,
    sampleRateHz: sampleRateHz,
    targetFramesPerChunk: targetFramesPerChunk,
    maximumChunks: maximumChunks
  )
}

private final class RecordingEmitter: IOSPCMCapacitorEventEmitting,
  @unchecked Sendable
{
  private let lock = NSLock()
  private var storage: [IOSPCMCapacitorEvent] = []

  var events: [IOSPCMCapacitorEvent] { lock.withLock { storage } }

  func emit(_ event: IOSPCMCapacitorEvent) throws {
    lock.withLock { storage.append(event) }
  }
}

private final class FakeBridge: IOSPCMBridgeServing, @unchecked Sendable {
  var configuration: IOSPCMBridgeConfiguration?
  var readyError: Error?
  var stopError: Error?
  var stopMode: IOSPCMBridgeStopMode?
  var acknowledgement: IOSPCMBridgeAcknowledgementResult = .stale
  var replay: IOSPCMBridgeReplayResult = .stale
  var acknowledgeCalls = 0

  func appState() async -> IOSPCMBridgeAppState { .foreground }

  func begin(
    configuration: IOSPCMBridgeConfiguration
  ) throws -> IOSPCMBridgeSessionToken {
    self.configuration = configuration
    return IOSPCMBridgeSessionToken(rawValue: "1.fragment_1")
  }

  func ready(_ token: IOSPCMBridgeSessionToken) async throws {
    if let readyError { throw readyError }
  }

  func heartbeat(_ token: IOSPCMBridgeSessionToken) async throws {}

  func stopForCapacitor(
    _ token: IOSPCMBridgeSessionToken,
    mode: IOSPCMBridgeStopMode
  ) async throws -> IOSPCMBridgePacket? {
    stopMode = mode
    if let stopError { throw stopError }
    return nil
  }

  func acknowledge(
    _ token: IOSPCMBridgeSessionToken,
    sequenceNumber: UInt64
  ) -> IOSPCMBridgeAcknowledgementResult {
    acknowledgeCalls += 1
    return acknowledgement
  }

  func replayPendingPacket(
    _ token: IOSPCMBridgeSessionToken,
    sequenceNumber: UInt64
  ) -> IOSPCMBridgeReplayResult {
    replay
  }
}
