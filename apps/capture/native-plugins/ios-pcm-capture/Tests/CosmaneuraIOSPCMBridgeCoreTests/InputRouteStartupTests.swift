import Foundation
import Testing

@testable import CosmaneuraIOSAVFoundationDriver
@testable import CosmaneuraIOSPCMCore

struct InputRouteStartupTests {
  @Test func repeatedPauseResumeAcceptsActivationRoutesBeforeInputSelection() async throws {
    let system = RouteSystem()
    let events = CapturedEvents()
    let driver = AVFoundationPCMDriver(system: system, foreground: Foreground())
    for sessionID in UInt64(1)...3 {
      try await driver.start(
        sessionID: sessionID, callbacks: events.callbacks, cancellation: StartupCancellation()
      )
      #expect(system.tapInstalled)
      try await driver.freezeInput(sessionID: sessionID)
      try await driver.release(sessionID: sessionID)
      #expect(!system.tapInstalled)
    }
    #expect(events.count == 0)
  }

  @Test func failedSelectionStillPreventsTapAndDoesNotLeaveConfigurationOpen() async throws {
    let system = RouteSystem(selectedInputAvailable: false)
    let driver = AVFoundationPCMDriver(system: system, foreground: Foreground())
    await #expect(throws: AVFoundationDriverError.self) {
      try await driver.start(
        sessionID: 1, callbacks: CapturedEvents().callbacks, cancellation: StartupCancellation()
      )
    }
    #expect(!system.tapInstalled)
    #expect(system.routes.routeChange(knownConfiguration: false) == .routeChanged)
    try await driver.freezeInput(sessionID: 1)
    try await driver.release(sessionID: 1)
  }

  @Test(
    arguments: [
      AppleAudioSystemEvent.interruptionBegan, .mediaServicesLost, .mediaServicesReset,
      .backgrounded, .permissionRevoked, .captureFailed,
    ], [AppleRecordingLifecycle.foregroundOnly, .nativeEncrypted])
  func activationStillRejectsNonRouteInterruptions(
    _ event: AppleAudioSystemEvent, lifecycle: AppleRecordingLifecycle
  ) async throws {
    let system = RouteSystem(activationEvent: event)
    let driver = AVFoundationPCMDriver(
      system: system, foreground: Foreground(), lifecycle: lifecycle)
    await #expect(throws: AVFoundationDriverError.self) {
      try await driver.start(
        sessionID: 1, callbacks: CapturedEvents().callbacks, cancellation: StartupCancellation()
      )
    }
    #expect(!system.tapInstalled)
    try await driver.freezeInput(sessionID: 1)
    try await driver.release(sessionID: 1)
  }

  @Test(arguments: [AppleRecordingLifecycle.foregroundOnly, .nativeEncrypted])
  func onlyArmedNativeEncryptionAllowsBackground(_ lifecycle: AppleRecordingLifecycle) async throws
  {
    let system = RouteSystem()
    let events = CapturedEvents()
    let driver = AVFoundationPCMDriver(
      system: system, foreground: Foreground(), lifecycle: lifecycle)
    try await driver.start(
      sessionID: 1, callbacks: events.callbacks, cancellation: StartupCancellation())
    system.emit(.backgrounded)
    try await driver.freezeInput(sessionID: 1)
    try await driver.release(sessionID: 1)
    #expect(events.count == (lifecycle == .nativeEncrypted ? 0 : 1))
  }

  @Test func routeChangeAfterSelectionStillRejectsStartup() async throws {
    let system = RouteSystem(changeAfterSelection: true)
    let driver = AVFoundationPCMDriver(system: system, foreground: Foreground())
    await #expect(throws: AVFoundationDriverError.self) {
      try await driver.start(
        sessionID: 1, callbacks: CapturedEvents().callbacks, cancellation: StartupCancellation()
      )
    }
    try await driver.freezeInput(sessionID: 1)
    try await driver.release(sessionID: 1)
  }

  @Test(arguments: [false, true])
  func routeChangesRemainTerminalDuringActiveCapture(knownConfiguration: Bool) async throws {
    let system = RouteSystem()
    let events = CapturedEvents()
    let driver = AVFoundationPCMDriver(system: system, foreground: Foreground())
    try await driver.start(
      sessionID: 1, callbacks: events.callbacks, cancellation: StartupCancellation()
    )
    system.emit(system.routes.routeChange(knownConfiguration: knownConfiguration))
    try await driver.freezeInput(sessionID: 1)
    try await driver.release(sessionID: 1)  // Joins terminal callback delivery.
    #expect(events.count == 1)
    #expect(events.routeChanged)
  }
}

private struct Foreground: AppleApplicationForegroundProviding {
  func isForegroundActive() async -> Bool { true }
}

private final class RouteSystem: AppleAudioSystem, @unchecked Sendable {
  let routes = AppleInputRouteEvents()
  let selectedInputAvailable: Bool
  let activationEvent: AppleAudioSystemEvent?
  let changeAfterSelection: Bool
  private(set) var tapInstalled = false
  private var handler: (@Sendable (AppleAudioSystemEvent) -> Void)?

  init(
    selectedInputAvailable: Bool = true,
    activationEvent: AppleAudioSystemEvent? = nil,
    changeAfterSelection: Bool = false
  ) {
    self.selectedInputAvailable = selectedInputAvailable
    self.activationEvent = activationEvent
    self.changeAfterSelection = changeAfterSelection
  }

  func setEventHandler(_ handler: @escaping @Sendable (AppleAudioSystemEvent) -> Void) {
    self.handler = handler
  }
  func clearEventHandler() { handler = nil }
  func emit(_ event: AppleAudioSystemEvent) { handler?(event) }
  func configureAndActivate(profile: AppleAudioSessionProfile) throws {
    try routes.withInputConfiguration {
      // Reproduce the phone trace: the route notification arrives before the
      // requested input has been selected, while activation is in progress.
      emit(routes.routeChange(knownConfiguration: false))
      if let activationEvent { emit(activationEvent) }
      guard selectedInputAvailable else { throw AVFoundationDriverError.operationFailed }
    }
  }
  func installInputTap(
    frameCapacity: UInt32, handler: @escaping @Sendable (OwnedAudioFrames) -> Void
  ) throws {
    guard selectedInputAvailable else { throw AVFoundationDriverError.operationFailed }
    tapInstalled = true
    if changeAfterSelection { emit(routes.routeChange(knownConfiguration: false)) }
  }
  func startEngine() throws {}
  func freezeInput() throws { tapInstalled = false }
  func deactivate() throws {}
}

private final class CapturedEvents: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [PCMAudioEvent] = []
  var count: Int { lock.withLock { values.count } }
  var routeChanged: Bool {
    lock.withLock { values.contains { if case .routeChanged = $0 { true } else { false } } }
  }
  var callbacks: PCMAudioCallbacks {
    PCMAudioCallbacks(
      frames: { frames in
        frames.zeroize()
        return PCMFrameAdmission(accepted: false)
      },
      event: { [self] value in lock.withLock { values.append(value) } }
    )
  }
}
