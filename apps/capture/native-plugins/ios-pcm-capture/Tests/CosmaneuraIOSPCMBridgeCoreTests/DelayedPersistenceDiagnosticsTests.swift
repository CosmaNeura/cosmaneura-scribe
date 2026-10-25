@testable import CosmaneuraIOSPCMCore
import Foundation
import Testing

/// Diagnostic reproducer only: invented PCM under explicit synthetic consent,
/// a blocked packet sink, and no OS audio, network, keychain, or live recording.
struct DelayedPersistenceDiagnosticsTests {
  @Test func nextFrameDuringPersistenceRecordsTheExistingAdmissionOverflow() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("diagnostics.json"), diagnostics = PCMStartupDiagnostics()
    diagnostics.configure(destination: file); diagnostics.record(.startRequested)
    let sink = DelayedPacketSink(), driver = DiagnosticDriver()
    let core = IOSPCMCore(permission: DiagnosticConsent(), audio: driver, sink: sink, diagnostics: diagnostics)
    let session = try core.start(configuration: PCMConfiguration(
      targetFramesPerChunk: 1_600, maximumChunks: 10, maximumInputFramesPerBuffer: 1_600))
    try await session.ready()
    defer { sink.releasePersistence() }
    let firstFrames = OwnedAudioFrames(sampleRateHz: 16_000, channels: [Array(repeating: 0, count: 1_600)])
    let first = try driver.offer(firstFrames)
    try #require(first.accepted)
    let deadline = ContinuousClock.now + .seconds(3)
    while !sink.entered && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(1)) }
    try #require(sink.entered)
    let lateFrames = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0]])
    let late = try driver.offer(lateFrames)
    #expect(!late.accepted && lateFrames.isZeroed)
    sink.releasePersistence()
    await first.waitUntilConsumed()
    while sink.terminations.isEmpty && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(1)) }
    #expect(sink.terminations == [.bufferOverflow])
    _ = try await session.stop(.discard)
    #expect(driver.releases == 1 && firstFrames.isZeroed)
    await diagnostics.flush()
    let rows = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [[String: Any]])
    #expect(rows.compactMap { $0["event"] as? String } == ["startRequested", "inputAdmissionOverflow", "pcmBufferOverflow"])
    #expect(rows.allSatisfy { Set($0.keys) == ["utc", "event", "clock", "monotonic_ns", "capture_attempt", "dropped_events"] })
    #expect(session.capturedAudioFrames == 1_600)
  }
}

private struct DiagnosticConsent: MicrophonePermissionAuthorizing {
  let allPartiesConsented = true
  let consentRecordID = UUID()
  func requestPermission(cancellation: StartupCancellation) async -> MicrophonePermission {
    allPartiesConsented && !cancellation.isCancelled ? .granted : .unavailable
  }
}
private struct DiagnosticAcknowledgement: PCMAcknowledging {
  func wait() async -> PCMAcknowledgementResult { .accepted }
  func cancel() {}
}
private final class DelayedPacketSink: PCMEmissionSink, @unchecked Sendable {
  private let condition = NSCondition()
  private var waiting = false, released = false
  private var failures: [PCMTerminationCode] = []
  var entered: Bool { condition.withLock { waiting } }
  var terminations: [PCMTerminationCode] { condition.withLock { failures } }
  func emit(_ packet: PCMEncodedPacket) throws -> any PCMAcknowledging {
    condition.lock(); waiting = true
    while !released { condition.wait() }
    condition.unlock()
    return DiagnosticAcknowledgement()
  }
  func releasePersistence() { condition.lock(); released = true; condition.broadcast(); condition.unlock() }
  func terminated(_ code: PCMTerminationCode) { condition.withLock { failures.append(code) } }
}
private final class DiagnosticDriver: PCMAudioDriving, @unchecked Sendable {
  private let lock = NSLock()
  private var callbacks: PCMAudioCallbacks?
  private var releaseCount = 0
  var releases: Int { lock.withLock { releaseCount } }
  func start(sessionID: UInt64, callbacks: PCMAudioCallbacks, cancellation: StartupCancellation) async throws {
    lock.withLock { self.callbacks = callbacks }
  }
  func offer(_ frames: OwnedAudioFrames) throws -> PCMFrameAdmission {
    try #require(lock.withLock { callbacks }).frames(frames)
  }
  func freezeInput(sessionID: UInt64) async throws { lock.withLock { callbacks = nil } }
  func release(sessionID: UInt64) async throws { lock.withLock { releaseCount += 1 } }
}
