import CosmaneuraIOSPCMBridgeCore
import CosmaneuraIOSPCMCore
import CosmaneuraIOSAVFoundationDriver
import Foundation
import Testing

/// Invented, consented input only. No OS audio source, permission request,
/// device storage, or network service is used by these bridge-to-core tests.
private struct ConsentedSyntheticEncounter: Sendable {
  let consentRecordID = UUID()
  let allPartiesConsented = true
  let participantRegions = ["US-NY"]

  func frames(count: Int) -> OwnedAudioFrames {
    precondition(allPartiesConsented && !participantRegions.isEmpty)
    return OwnedAudioFrames(
      sampleRateHz: 48_000, channels: [Array(repeating: 0.125, count: count)])
  }
}

private struct FixturePermission: MicrophonePermissionAuthorizing {
  let encounter: ConsentedSyntheticEncounter

  func requestPermission(cancellation: StartupCancellation) async -> MicrophonePermission {
    encounter.allPartiesConsented && !cancellation.isCancelled ? .granted : .unavailable
  }
}

private struct FixtureForeground: AppleApplicationForegroundProviding {
  func isForegroundActive() async -> Bool { true }
}

private final class InjectedAudioDriver: PCMAudioDriving, @unchecked Sendable {
  private let lock = NSLock()
  private var callbacks: PCMAudioCallbacks?

  func start(sessionID: UInt64, callbacks: PCMAudioCallbacks,
    cancellation: StartupCancellation) async throws
  {
    guard !cancellation.isCancelled else { throw PCMFailure(.startupCancelled) }
    lock.withLock { self.callbacks = callbacks }
  }

  func offer(_ frames: OwnedAudioFrames) async throws {
    let current = try #require(lock.withLock { callbacks })
    let receipt = current.frames(frames)
    #expect(receipt.accepted)
    await receipt.waitUntilConsumed()
  }

  func freezeInput(sessionID: UInt64) async throws { lock.withLock { callbacks = nil } }
  func release(sessionID: UInt64) async throws {}
}

private final class FixtureEvents: IOSPCMBridgeEventPublishing, @unchecked Sendable {
  private let lock = NSLock()
  private var failures: [IOSPCMBridgeTerminalErrorCode] = []
  private var fullPackets = 0
  weak var bridge: IOSPCMBridgeCore?

  func publish(_ event: IOSPCMBridgeEvent) throws {
    switch event {
    case .terminal(_, let code): lock.withLock { failures.append(code) }
    case .packetAvailable(let packet):
      lock.withLock { fullPackets += 1 }
      // An unexpected full packet must not leave the test waiting for an ack.
      _ = bridge?.acknowledge(packet.sessionToken, sequenceNumber: packet.sequenceNumber)
    case .interruption, .windowClosed: Issue.record("Unexpected synthetic capture lifecycle event")
    }
  }

  var terminalFailures: [IOSPCMBridgeTerminalErrorCode] { lock.withLock { failures } }
  var fullPacketCount: Int { lock.withLock { fullPackets } }
}

@Suite(.serialized)
struct NativeInputFrameLimitTests {
  @Test func acceptsLargerNativeTapBufferAndDrainsResampledAudio() async throws {
    let encounter = ConsentedSyntheticEncounter()
    let audio = InjectedAudioDriver(), events = FixtureEvents()
    let bridge = IOSPCMBridgeCore(permission: FixturePermission(encounter: encounter),
      audio: audio, foreground: FixtureForeground(), events: events)
    events.bridge = bridge
    let token = try bridge.begin(configuration: configuration())
    try await bridge.ready(token)
    let frames = encounter.frames(count: 8_192)
    try await audio.offer(frames)
    let stopped = try await bridge.stop(token, mode: .drain)

    #expect(events.terminalFailures.isEmpty)
    #expect(events.fullPacketCount == 0)
    #expect(frames.isZeroed)
    #expect(stopped.finalPacket?.sequenceNumber == 0)
    // ceil(8192 * 16000 / 48000) mono PCM16 samples, including the drained tail.
    #expect(stopped.finalPacket?.bytes.count == 2_731 * 2)
    #expect(stopped.finalPacket?.bytes.withUnsafeBytes { $0.contains { $0 != 0 } } == true)
    stopped.finalPacket?.bytes.zeroize()
    #expect(stopped.finalPacket?.bytes.isZeroized == true)
    #expect(bridge.confirmCaptureIdle())
  }

  @Test func rejectsInputAboveTheExistingNativeMaximum() async throws {
    let encounter = ConsentedSyntheticEncounter()
    let audio = InjectedAudioDriver(), events = FixtureEvents()
    let bridge = IOSPCMBridgeCore(permission: FixturePermission(encounter: encounter),
      audio: audio, foreground: FixtureForeground(), events: events)
    events.bridge = bridge
    let token = try bridge.begin(configuration: configuration())
    try await bridge.ready(token)
    let frames = encounter.frames(count: PCMConfiguration.maximumFramesPerInputBuffer + 1)
    try await audio.offer(frames)
    let stopped = try await bridge.stop(token, mode: .drain)

    #expect(events.terminalFailures == [.captureFailed])
    #expect(events.fullPacketCount == 0)
    #expect(frames.isZeroed)
    #expect(stopped.finalPacket == nil)
    #expect(bridge.confirmCaptureIdle())
  }

  @Test func signalDistinguishesTapAndConversionAndResetsOnResume() async throws {
    let encounter = ConsentedSyntheticEncounter(), monitor = PCMSignalMonitor()
    let audio = InjectedAudioDriver(), events = FixtureEvents()
    let bridge = IOSPCMBridgeCore(permission: FixturePermission(encounter: encounter),
      audio: audio, foreground: FixtureForeground(), events: events, signalMonitor: monitor)
    events.bridge = bridge
    #expect(bridge.captureSignal() == nil)
    let token = try bridge.begin(configuration: configuration())
    try await bridge.ready(token)
    monitor.setRoute(.builtIn)
    // More than three seconds of exact silence is observable, never terminal.
    for _ in 0..<18 {
      let channels = [Array(repeating: Float.zero, count: 8_192)]
      monitor.recordInput(channels, sampleRateHz: 48_000)
      try await audio.offer(OwnedAudioFrames(sampleRateHz: 48_000, channels: channels))
    }
    let quiet = try #require(bridge.captureSignal())
    #expect(quiet.inputBuffers == 18 && quiet.convertedBuffers == 18)
    #expect(quiet.zeroInputMs >= 3_000)
    #expect(!quiet.inputEverNonzero && !quiet.convertedEverNonzero)
    #expect(events.terminalFailures.isEmpty)
    // Tap observation precedes conversion; it must not make the output meter move.
    monitor.recordInput([Array(repeating: 0.125, count: 8_192)], sampleRateHz: 48_000)
    #expect(bridge.captureSignal()?.inputEverNonzero == true)
    #expect(bridge.captureSignal()?.convertedEverNonzero == false)
    let frames = encounter.frames(count: 8_192)
    try await audio.offer(frames)
    let active = try #require(bridge.captureSignal())
    #expect(active.inputLevel == 0.125 && active.convertedLevel > 0.12)
    #expect(active.convertedEverNonzero && active.zeroInputMs == 0 && active.route == .builtIn)
    #expect(frames.isZeroed)
    let stopped = try await bridge.stop(token, mode: .drain)
    #expect(stopped.finalPacket?.bytes.withUnsafeBytes { $0.contains { $0 != 0 } } == true)
    stopped.finalPacket?.bytes.zeroize()
    #expect(bridge.captureSignal() == nil)
    let resumed = try bridge.begin(configuration: configuration())
    try await bridge.ready(resumed)
    #expect(bridge.captureSignal()?.inputBuffers == 0)
    #expect(bridge.captureSignal()?.convertedEverNonzero == false)
    _ = try await bridge.stop(resumed, mode: .discard)
    #expect(bridge.captureSignal() == nil)
  }

  private func configuration() -> IOSPCMBridgeConfiguration {
    IOSPCMBridgeConfiguration(encoding: PCMConfiguration.encoding,
      channels: PCMConfiguration.channels, sampleRateHz: PCMConfiguration.sampleRateHz,
      targetFramesPerChunk: 160_000, maximumChunks: 1)
  }
}
