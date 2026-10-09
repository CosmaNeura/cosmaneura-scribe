import Foundation
import Testing

@testable import CosmaneuraIOSAVFoundationDriver
@testable import CosmaneuraIOSPCMCore

struct InterruptedTailAdmissionTests {
  @Test(arguments: [AppleAudioSystemEvent.permissionRevoked, .captureFailed, nil])
  func hardFailureOrTimeoutDoesNotWaitForAnAdmittedCallback(
    _ hard: AppleAudioSystemEvent?
  ) async throws {
    let system = PendingSystem()
    let pending = PendingReceipt()
    let events = EventReceipt()
    let driver = AVFoundationPCMDriver(
      system: system, foreground: SyntheticForeground(), lifecycle: .nativeEncrypted)
    try await driver.start(sessionID: 1, callbacks: PCMAudioCallbacks(
      frames: { frames in
        PCMFrameAdmission(accepted: true, completion: Task {
          await pending.wait()
          frames.zeroize()
        }, release: {})
      }, event: { events.record($0) }, invalidate: { events.invalidate($0) }),
      cancellation: StartupCancellation())
    let frames = OwnedAudioFrames(sampleRateHz: 16_000, channels: [[0.25]])
    system.offer(frames)
    let clock = ContinuousClock(), started = ContinuousClock.now
    system.emit(.routeChanged)
    if let hard { system.emit(hard) }
    while events.count == 0 && clock.now - started < .seconds(3) {
      try await Task.sleep(for: .milliseconds(2))
    }
    #expect(events.count == 1)
    #expect(events.invalidations == 1)
    #expect(!events.sawBenign)
    // Deliberately release the driver before its admitted frame receipt. A hard
    // invalidation/timeout must wake the benign waiter and permit physical stop.
    try await driver.freezeInput(sessionID: 1)
    try await driver.release(sessionID: 1)
    #expect(clock.now - started < .seconds(4))
    #expect(system.releases == 1)
    #expect(!frames.isZeroed)
    await pending.release()
  }
}

private actor PendingReceipt {
  private var released = false
  private var waiter: CheckedContinuation<Void, Never>?
  func wait() async {
    if released { return }
    await withCheckedContinuation { waiter = $0 }
  }
  func release() { released = true; waiter?.resume(); waiter = nil }
}
private final class EventReceipt: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [PCMAudioEvent] = []
  private var failures = 0
  var count: Int { lock.withLock { values.count } }
  var invalidations: Int { lock.withLock { failures } }
  var sawBenign: Bool {
    lock.withLock { values.contains { value in
      switch value { case .routeChanged, .interruption: true; default: false }
    } }
  }
  func record(_ value: PCMAudioEvent) { lock.withLock { values.append(value) } }
  func invalidate(_ value: PCMAudioEvent) { lock.withLock { failures += 1 } }
}
private struct SyntheticForeground: AppleApplicationForegroundProviding {
  func isForegroundActive() async -> Bool { true }
}
private final class PendingSystem: AppleAudioSystem, @unchecked Sendable {
  private var event: (@Sendable (AppleAudioSystemEvent) -> Void)?
  private var frames: (@Sendable (OwnedAudioFrames) -> Void)?
  private(set) var releases = 0
  func setEventHandler(_ handler: @escaping @Sendable (AppleAudioSystemEvent) -> Void) {
    event = handler
  }
  func clearEventHandler() { event = nil }
  func emit(_ value: AppleAudioSystemEvent) { event?(value) }
  func offer(_ value: OwnedAudioFrames) { frames?(value) }
  func configureAndActivate(profile: AppleAudioSessionProfile) throws {}
  func installInputTap(frameCapacity: UInt32,
    handler: @escaping @Sendable (OwnedAudioFrames) -> Void) throws { frames = handler }
  func startEngine() throws {}
  func freezeInput() throws { frames = nil }
  func deactivate() throws { releases += 1 }
}
