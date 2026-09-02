import Foundation
import XCTest

@testable import CosmaneuraIOSAVFoundationDriver
@testable import CosmaneuraIOSPCMCore

final class AVFoundationPCMDriverTests: XCTestCase, @unchecked Sendable {
  func testLiveTapUsesInputNodeOutputBusFormat() throws {
    let packageRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let sourceURL =
      packageRoot
      .appendingPathComponent("Sources")
      .appendingPathComponent("CosmaneuraIOSAVFoundationDriver")
      .appendingPathComponent("LiveAVFoundationSystem.swift")
    let source = try String(contentsOf: sourceURL, encoding: .utf8)

    XCTAssertTrue(source.contains("input.outputFormat(forBus: 0)"))
    XCTAssertTrue(source.contains("format: source"))
    XCTAssertFalse(source.contains("input.inputFormat(forBus: 0)"))
    XCTAssertFalse(source.contains("let format = AVAudioFormat("))
    let marker = try XCTUnwrap(
      source.range(of: "forName: .AVAudioEngineConfigurationChange")
    )
    XCTAssertTrue(source[marker.lowerBound...].prefix(180).contains("emit(.captureFailed)"))
  }

  func testLiveLifecycleObserverTreatsInactiveAsForegroundLoss() throws {
    let packageRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let sourceURL =
      packageRoot
      .appendingPathComponent("Sources")
      .appendingPathComponent("CosmaneuraIOSAVFoundationDriver")
      .appendingPathComponent("LiveAVFoundationSystem.swift")
    let source = try String(contentsOf: sourceURL, encoding: .utf8)

    let inactive = try XCTUnwrap(
      source.range(of: "forName: UIApplication.willResignActiveNotification")
    )
    XCTAssertTrue(source[inactive.lowerBound...].prefix(180).contains("emit(.backgrounded)"))
    XCTAssertTrue(source.contains("forName: UIApplication.didEnterBackgroundNotification"))
    XCTAssertTrue(source.contains("forName: UIApplication.didBecomeActiveNotification"))
  }

  func testPermissionAdapterMapsEveryBoundedState() async {
    let cases: [(AppleMicrophonePermissionState, String)] = [
      (.granted, "granted"),
      (.denied, "denied"),
      (.restricted, "restricted"),
      (.unavailable, "unavailable"),
    ]
    for (state, expected) in cases {
      let adapter = AVFoundationMicrophonePermissionAdapter(
        provider: FakePermissionProvider(current: state)
      )
      let result = await adapter.requestPermission(cancellation: StartupCancellation())
      XCTAssertEqual(permissionKey(result), expected)
    }

    let requested = AVFoundationMicrophonePermissionAdapter(
      provider: FakePermissionProvider(current: .notDetermined, requested: .restricted)
    )
    let result = await requested.requestPermission(cancellation: StartupCancellation())
    XCTAssertEqual(permissionKey(result), "restricted")
  }

  func testPermissionCancellationSettlesBeforeLateProvider() async throws {
    let provider = LatePermissionProvider()
    let adapter = AVFoundationMicrophonePermissionAdapter(provider: provider)
    let cancellation = StartupCancellation()
    let pending = Task { await adapter.requestPermission(cancellation: cancellation) }
    try await waitUntil { provider.isWaiting }

    cancellation.cancel()
    let result = await pending.value
    XCTAssertEqual(permissionKey(result), "unavailable")
    provider.resolve(.granted)
  }

  func testStartUsesForegroundSpeechProfileAndCleanupIsIdempotent() async throws {
    let system = FakeAudioSystem()
    let driver = makeDriver(system)
    try await driver.start(
      sessionID: 7,
      callbacks: CallbackRecorder().callbacks(),
      cancellation: StartupCancellation()
    )
    XCTAssertEqual(system.operations, [.setHandler, .configure, .install(4_096), .start])

    try await driver.freezeInput(sessionID: 7)
    try await driver.freezeInput(sessionID: 7)
    try await driver.release(sessionID: 7)
    try await driver.release(sessionID: 7)
    XCTAssertEqual(system.freezeCalls, 1)
    XCTAssertEqual(system.deactivateCalls, 1)
    XCTAssertEqual(system.clearHandlerCalls, 1)
  }

  func testCancellationDuringConfigurationLeavesRetryableCleanup() async throws {
    let system = FakeAudioSystem()
    let cancellation = StartupCancellation()
    system.onConfigure = { cancellation.cancel() }
    let driver = makeDriver(system)

    await assertDriverFailure {
      try await driver.start(
        sessionID: 1,
        callbacks: CallbackRecorder().callbacks(),
        cancellation: cancellation
      )
    }
    XCTAssertEqual(system.installCalls, 0)
    XCTAssertEqual(system.startCalls, 0)
    try await driver.freezeInput(sessionID: 1)
    try await driver.release(sessionID: 1)

    system.onConfigure = nil
    try await driver.start(
      sessionID: 2,
      callbacks: CallbackRecorder().callbacks(),
      cancellation: StartupCancellation()
    )
    try await driver.freezeInput(sessionID: 2)
    try await driver.release(sessionID: 2)
  }

  func testInitiallyInactiveApplicationFailsBeforeAudioActivation() async throws {
    let system = FakeAudioSystem()
    let driver = makeDriver(system, foreground: StaticForeground(active: false))

    await assertDriverFailure {
      try await driver.start(
        sessionID: 1,
        callbacks: CallbackRecorder().callbacks(),
        cancellation: StartupCancellation()
      )
    }
    XCTAssertEqual(system.configureCalls, 0)
    XCTAssertEqual(system.installCalls, 0)
    try await driver.freezeInput(sessionID: 1)
    try await driver.release(sessionID: 1)
  }

  func testBackgroundTransitionBeforeArmingFailsClosed() async throws {
    let system = FakeAudioSystem()
    let foreground = SequencedForeground([.value(true), .value(false)])
    let driver = makeDriver(system, foreground: foreground)

    await assertDriverFailure {
      try await driver.start(
        sessionID: 1,
        callbacks: CallbackRecorder().callbacks(),
        cancellation: StartupCancellation()
      )
    }
    XCTAssertEqual(system.configureCalls, 1)
    XCTAssertEqual(system.installCalls, 1)
    XCTAssertEqual(system.startCalls, 1)
    let rejected = OwnedAudioFrames(sampleRateHz: 48_000, channels: [[0.1]])
    system.emitFrame(rejected)
    XCTAssertTrue(rejected.isZeroed)
    try await driver.freezeInput(sessionID: 1)
    try await driver.release(sessionID: 1)
  }

  func testSuspendedStartupCannotCorruptReplacementGeneration() async throws {
    let firstCheck = ManualGate<Bool>()
    let foreground = SequencedForeground([
      .gate(firstCheck), .value(true), .value(true),
    ])
    let system = FakeAudioSystem()
    let driver = makeDriver(system, foreground: foreground)
    let first = Task {
      try await driver.start(
        sessionID: 1,
        callbacks: CallbackRecorder().callbacks(),
        cancellation: StartupCancellation()
      )
    }
    try await waitUntil { foreground.checkCount == 1 }
    try await driver.freezeInput(sessionID: 1)
    try await driver.release(sessionID: 1)
    try await driver.start(
      sessionID: 2,
      callbacks: CallbackRecorder().callbacks(),
      cancellation: StartupCancellation()
    )

    firstCheck.resolve(true)
    await assertDriverFailure { try await first.value }
    try await driver.freezeInput(sessionID: 2)
    try await driver.release(sessionID: 2)
  }

  func testConfigureRouteNotificationIsIgnoredUntilEventsAreArmed() async throws {
    let recorder = CallbackRecorder()
    let system = FakeAudioSystem()
    system.onConfigure = { system.emitEvent(.configurationChanged) }
    let driver = makeDriver(system)

    try await driver.start(
      sessionID: 1,
      callbacks: recorder.callbacks(),
      cancellation: StartupCancellation()
    )
    XCTAssertTrue(recorder.eventKeys.isEmpty)
    system.emitEvent(.configurationChanged)
    try await waitUntil { recorder.eventKeys == ["routeChanged"] }
    try await driver.freezeInput(sessionID: 1)
    try await driver.release(sessionID: 1)
  }

  func testGenuineLifecycleOrEngineLossDuringConfigureFailsStartup() async throws {
    for event in [AppleAudioSystemEvent.backgrounded, .captureFailed] {
      let system = FakeAudioSystem()
      system.onConfigure = { system.emitEvent(event) }
      let driver = makeDriver(system)

      await assertDriverFailure {
        try await driver.start(
          sessionID: 1,
          callbacks: CallbackRecorder().callbacks(),
          cancellation: StartupCancellation()
        )
      }
      XCTAssertEqual(system.installCalls, 0)
      XCTAssertEqual(system.startCalls, 0)
      try await driver.freezeInput(sessionID: 1)
      try await driver.release(sessionID: 1)
    }
  }

  func testSecondFrameFailsClosedWithoutQueuingTransferredAudio() async throws {
    let receipt = ManualGate<Void>()
    let eventGate = ManualGate<Void>()
    let recorder = CallbackRecorder(receipt: receipt, eventGate: eventGate)
    let system = FakeAudioSystem()
    let driver = makeDriver(system)
    try await driver.start(
      sessionID: 1,
      callbacks: recorder.callbacks(acceptFrames: true),
      cancellation: StartupCancellation()
    )
    let first = OwnedAudioFrames(sampleRateHz: 48_000, channels: [[0.1]])
    let overflow = OwnedAudioFrames(sampleRateHz: 48_000, channels: [[0.2]])
    let afterOverflow = OwnedAudioFrames(sampleRateHz: 48_000, channels: [[0.3]])

    system.emitFrame(first)
    system.emitFrame(overflow)
    system.emitFrame(afterOverflow)
    try await waitUntil { recorder.eventStartCount == 1 }

    XCTAssertEqual(recorder.frameCount, 1)
    XCTAssertTrue(first.isZeroed)
    XCTAssertTrue(overflow.isZeroed)
    XCTAssertTrue(afterOverflow.isZeroed)
    receipt.resolve(())
    try await driver.freezeInput(sessionID: 1)
    let completion = CompletionFlag()
    let release = Task {
      defer { completion.finish() }
      try await driver.release(sessionID: 1)
    }
    try await waitUntil { system.deactivateCalls == 1 }
    XCTAssertFalse(completion.isFinished)
    eventGate.resolve(())
    try await release.value
    XCTAssertEqual(recorder.eventKeys, ["captureFailed"])
  }

  func testNativeEventsMapToFixedCoreEventsOnce() async throws {
    let cases: [(AppleAudioSystemEvent, String)] = [
      (.interruptionBegan, "interruption"),
      (.routeChanged, "routeChanged"),
      (.mediaServicesLost, "captureFailed"),
      (.mediaServicesReset, "captureFailed"),
      (.backgrounded, "backgrounded"),
      (.permissionRevoked, "permissionRevoked"),
      (.captureFailed, "captureFailed"),
    ]
    for (offset, item) in cases.enumerated() {
      let recorder = CallbackRecorder()
      let system = FakeAudioSystem()
      let driver = makeDriver(system)
      let sessionID = UInt64(offset + 1)
      try await driver.start(
        sessionID: sessionID,
        callbacks: recorder.callbacks(),
        cancellation: StartupCancellation()
      )

      system.emitEvent(item.0)
      system.emitEvent(.captureFailed)
      try await waitUntil { recorder.eventKeys.count == 1 }
      XCTAssertEqual(recorder.eventKeys, [item.1])
      try await driver.freezeInput(sessionID: sessionID)
      try await driver.release(sessionID: sessionID)
    }
  }

  func testOverlappingResignBackgroundAndInterruptionDeliverOneTerminalEvent() async throws {
    let eventGate = ManualGate<Void>()
    let recorder = CallbackRecorder(eventGate: eventGate)
    let system = FakeAudioSystem()
    let driver = makeDriver(system)
    try await driver.start(
      sessionID: 1,
      callbacks: recorder.callbacks(),
      cancellation: StartupCancellation()
    )

    system.emitEvent(.backgrounded)
    try await waitUntil { recorder.eventStartCount == 1 }
    system.emitEvent(.backgrounded)
    system.emitEvent(.interruptionBegan)
    system.emitEvent(.backgrounded)
    await Task.yield()
    XCTAssertEqual(recorder.eventStartCount, 1)

    try await driver.freezeInput(sessionID: 1)
    let completion = CompletionFlag()
    let release = Task {
      defer { completion.finish() }
      try await driver.release(sessionID: 1)
    }
    try await waitUntil { system.deactivateCalls == 1 }
    XCTAssertFalse(completion.isFinished)

    eventGate.resolve(())
    try await release.value
    XCTAssertEqual(recorder.eventKeys, ["backgrounded"])
    try await driver.freezeInput(sessionID: 1)
    try await driver.release(sessionID: 1)
    XCTAssertEqual(system.freezeCalls, 1)
    XCTAssertEqual(system.deactivateCalls, 1)
    XCTAssertEqual(system.clearHandlerCalls, 1)
  }

  func testStaleTapAndNotificationCallbacksAreInert() async throws {
    let firstRecorder = CallbackRecorder()
    let secondRecorder = CallbackRecorder()
    let system = FakeAudioSystem()
    let driver = makeDriver(system)
    try await driver.start(
      sessionID: 1,
      callbacks: firstRecorder.callbacks(),
      cancellation: StartupCancellation()
    )
    try await driver.freezeInput(sessionID: 1)
    try await driver.release(sessionID: 1)
    try await driver.start(
      sessionID: 2,
      callbacks: secondRecorder.callbacks(),
      cancellation: StartupCancellation()
    )

    let stale = OwnedAudioFrames(sampleRateHz: 48_000, channels: [[0.1]])
    system.emitFrame(stale, handlerIndex: 0)
    system.emitEvent(.routeChanged, handlerIndex: 0)
    await Task.yield()
    XCTAssertTrue(stale.isZeroed)
    XCTAssertEqual(firstRecorder.frameCount, 0)
    XCTAssertTrue(firstRecorder.eventKeys.isEmpty)
    XCTAssertTrue(secondRecorder.eventKeys.isEmpty)
    try await driver.freezeInput(sessionID: 2)
    try await driver.release(sessionID: 2)
  }

  func testFreezeAndReleaseFailuresRetainOwnershipUntilRetry() async throws {
    let recorder = CallbackRecorder()
    let system = FakeAudioSystem(freezeFailures: 1, deactivateFailures: 1)
    let driver = makeDriver(system)
    try await driver.start(
      sessionID: 1,
      callbacks: recorder.callbacks(),
      cancellation: StartupCancellation()
    )

    await assertDriverFailure { try await driver.freezeInput(sessionID: 1) }
    let rejected = OwnedAudioFrames(sampleRateHz: 48_000, channels: [[0.1]])
    system.emitFrame(rejected)
    XCTAssertTrue(rejected.isZeroed)
    await assertDriverFailure {
      try await driver.start(
        sessionID: 2,
        callbacks: CallbackRecorder().callbacks(),
        cancellation: StartupCancellation()
      )
    }

    try await driver.freezeInput(sessionID: 1)
    await assertDriverFailure { try await driver.release(sessionID: 1) }
    system.emitEvent(.backgrounded)
    try await waitUntil { recorder.eventKeys == ["backgrounded"] }
    try await driver.release(sessionID: 1)
    try await driver.freezeInput(sessionID: 1)
    try await driver.release(sessionID: 1)

    try await driver.start(
      sessionID: 2,
      callbacks: CallbackRecorder().callbacks(),
      cancellation: StartupCancellation()
    )
    try await driver.freezeInput(sessionID: 2)
    try await driver.release(sessionID: 2)
    XCTAssertEqual(system.freezeCalls, 3)
    XCTAssertEqual(system.deactivateCalls, 3)
  }

  func testReleaseWaitsForAlreadyAcceptedTerminalDelivery() async throws {
    let eventGate = ManualGate<Void>()
    let recorder = CallbackRecorder(eventGate: eventGate)
    let system = FakeAudioSystem()
    let driver = makeDriver(system)
    try await driver.start(
      sessionID: 1,
      callbacks: recorder.callbacks(),
      cancellation: StartupCancellation()
    )
    system.emitEvent(.backgrounded)
    try await waitUntil { recorder.eventStartCount == 1 }
    try await driver.freezeInput(sessionID: 1)

    let completion = CompletionFlag()
    let release = Task {
      defer { completion.finish() }
      try await driver.release(sessionID: 1)
    }
    try await waitUntil { system.deactivateCalls == 1 }
    await Task.yield()
    XCTAssertFalse(completion.isFinished)
    eventGate.resolve(())
    try await release.value
    XCTAssertTrue(completion.isFinished)
    XCTAssertEqual(recorder.eventKeys, ["backgrounded"])
  }

  func testReleaseTracksEventEmittedSynchronouslyByDeactivate() async throws {
    let eventGate = ManualGate<Void>()
    let recorder = CallbackRecorder(eventGate: eventGate)
    let system = FakeAudioSystem()
    system.onDeactivate = { system.emitEvent(.routeChanged) }
    let driver = makeDriver(system)
    try await driver.start(
      sessionID: 1,
      callbacks: recorder.callbacks(),
      cancellation: StartupCancellation()
    )
    try await driver.freezeInput(sessionID: 1)

    let completion = CompletionFlag()
    let release = Task {
      defer { completion.finish() }
      try await driver.release(sessionID: 1)
    }
    try await waitUntil { recorder.eventStartCount == 1 }
    XCTAssertFalse(completion.isFinished)
    eventGate.resolve(())
    try await release.value
    XCTAssertEqual(recorder.eventKeys, ["routeChanged"])
  }

  func testConcurrentReleaseWaitsForFullFinalizationBeforeRestart() async throws {
    let eventGate = ManualGate<Void>()
    let recorder = CallbackRecorder(eventGate: eventGate)
    let system = FakeAudioSystem()
    let driver = makeDriver(system)
    try await driver.start(
      sessionID: 1,
      callbacks: recorder.callbacks(),
      cancellation: StartupCancellation()
    )
    system.emitEvent(.backgrounded)
    try await waitUntil { recorder.eventStartCount == 1 }
    try await driver.freezeInput(sessionID: 1)

    let first = Task { try await driver.release(sessionID: 1) }
    try await waitUntil { system.deactivateCalls == 1 }
    let secondCompletion = CompletionFlag()
    let second = Task {
      defer { secondCompletion.finish() }
      try await driver.release(sessionID: 1)
    }
    try await waitUntilAsync { await driver.releaseWaiterCountForTesting() == 1 }
    XCTAssertFalse(secondCompletion.isFinished)

    eventGate.resolve(())
    try await second.value
    try await driver.start(
      sessionID: 2,
      callbacks: CallbackRecorder().callbacks(),
      cancellation: StartupCancellation()
    )
    try await first.value
    try await driver.freezeInput(sessionID: 2)
    try await driver.release(sessionID: 2)
  }
}

private final class FakePermissionProvider:
  AppleMicrophonePermissionProviding, @unchecked Sendable
{
  let current: AppleMicrophonePermissionState
  let requested: AppleMicrophonePermissionState

  init(
    current: AppleMicrophonePermissionState,
    requested: AppleMicrophonePermissionState = .granted
  ) {
    self.current = current
    self.requested = requested
  }

  func currentPermission() -> AppleMicrophonePermissionState { current }
  func requestPermission() async -> AppleMicrophonePermissionState { requested }
}

private final class LatePermissionProvider:
  AppleMicrophonePermissionProviding, @unchecked Sendable
{
  private let gate = ManualGate<AppleMicrophonePermissionState>()
  var isWaiting: Bool { gate.isWaiting }

  func currentPermission() -> AppleMicrophonePermissionState { .notDetermined }
  func requestPermission() async -> AppleMicrophonePermissionState { await gate.wait() }
  func resolve(_ value: AppleMicrophonePermissionState) { gate.resolve(value) }
}

private struct StaticForeground: AppleApplicationForegroundProviding {
  let active: Bool
  func isForegroundActive() async -> Bool { active }
}

private enum ForegroundResponse: Sendable {
  case value(Bool)
  case gate(ManualGate<Bool>)
}

private final class SequencedForeground:
  AppleApplicationForegroundProviding, @unchecked Sendable
{
  private let lock = NSLock()
  private var responses: [ForegroundResponse]
  private var checks = 0

  init(_ responses: [ForegroundResponse]) { self.responses = responses }

  var checkCount: Int { lock.withLock { checks } }

  func isForegroundActive() async -> Bool {
    let response = lock.withLock { () -> ForegroundResponse? in
      checks += 1
      return responses.isEmpty ? nil : responses.removeFirst()
    }
    switch response {
    case .value(let active): return active
    case .gate(let gate): return await gate.wait()
    case nil: return false
    }
  }
}

private func makeDriver(
  _ system: any AppleAudioSystem,
  foreground: any AppleApplicationForegroundProviding = StaticForeground(active: true)
) -> AVFoundationPCMDriver {
  AVFoundationPCMDriver(system: system, foreground: foreground)
}

private final class CallbackRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private let receipt: ManualGate<Void>?
  private let eventGate: ManualGate<Void>?
  private var frames = 0
  private var events: [String] = []
  private var eventStarts = 0

  init(
    receipt: ManualGate<Void>? = nil,
    eventGate: ManualGate<Void>? = nil
  ) {
    self.receipt = receipt
    self.eventGate = eventGate
  }

  var frameCount: Int { lock.withLock { frames } }
  var eventKeys: [String] { lock.withLock { events } }
  var eventStartCount: Int { lock.withLock { eventStarts } }

  func callbacks(acceptFrames: Bool = false) -> PCMAudioCallbacks {
    PCMAudioCallbacks(
      frames: { [self] audio in
        lock.withLock { frames += 1 }
        audio.zeroize()
        guard acceptFrames, let receipt else {
          return PCMFrameAdmission(accepted: false)
        }
        return PCMFrameAdmission(
          accepted: true,
          completion: Task { await receipt.wait() }
        )
      },
      event: { [self] event in
        lock.withLock { eventStarts += 1 }
        if let eventGate { await eventGate.wait() }
        lock.withLock { events.append(eventKey(event)) }
      }
    )
  }
}

private final class FakeAudioSystem: AppleAudioSystem, @unchecked Sendable {
  enum Operation: Equatable {
    case setHandler
    case clearHandler
    case configure
    case install(UInt32)
    case start
    case freeze
    case deactivate
  }

  private let lock = NSLock()
  private var operationStorage: [Operation] = []
  private var eventHandlers: [(@Sendable (AppleAudioSystemEvent) -> Void)] = []
  private var frameHandlers: [(@Sendable (OwnedAudioFrames) -> Void)] = []
  private var currentEventHandler: (@Sendable (AppleAudioSystemEvent) -> Void)?
  private var remainingFreezeFailures: Int
  private var remainingDeactivateFailures: Int
  var onConfigure: (@Sendable () -> Void)?
  var onDeactivate: (@Sendable () -> Void)?

  init(freezeFailures: Int = 0, deactivateFailures: Int = 0) {
    remainingFreezeFailures = freezeFailures
    remainingDeactivateFailures = deactivateFailures
  }

  var operations: [Operation] { lock.withLock { operationStorage } }
  var configureCalls: Int { operations.filter { $0 == .configure }.count }
  var installCalls: Int {
    operations.filter { if case .install = $0 { true } else { false } }.count
  }
  var startCalls: Int { operations.filter { $0 == .start }.count }
  var freezeCalls: Int { operations.filter { $0 == .freeze }.count }
  var deactivateCalls: Int { operations.filter { $0 == .deactivate }.count }
  var clearHandlerCalls: Int { operations.filter { $0 == .clearHandler }.count }

  func setEventHandler(
    _ handler: @escaping @Sendable (AppleAudioSystemEvent) -> Void
  ) {
    lock.withLock {
      operationStorage.append(.setHandler)
      currentEventHandler = handler
      eventHandlers.append(handler)
    }
  }

  func clearEventHandler() {
    lock.withLock {
      operationStorage.append(.clearHandler)
      currentEventHandler = nil
    }
  }

  func configureAndActivate(profile: AppleAudioSessionProfile) throws {
    lock.withLock { operationStorage.append(.configure) }
    onConfigure?()
  }

  func installInputTap(
    frameCapacity: UInt32,
    handler: @escaping @Sendable (OwnedAudioFrames) -> Void
  ) throws {
    lock.withLock {
      operationStorage.append(.install(frameCapacity))
      frameHandlers.append(handler)
    }
  }

  func startEngine() throws { lock.withLock { operationStorage.append(.start) } }

  func freezeInput() throws {
    let fail = lock.withLock {
      operationStorage.append(.freeze)
      guard remainingFreezeFailures > 0 else { return false }
      remainingFreezeFailures -= 1
      return true
    }
    if fail { throw AVFoundationDriverError.operationFailed }
  }

  func deactivate() throws {
    let fail = lock.withLock {
      operationStorage.append(.deactivate)
      guard remainingDeactivateFailures > 0 else { return false }
      remainingDeactivateFailures -= 1
      return true
    }
    onDeactivate?()
    if fail { throw AVFoundationDriverError.operationFailed }
  }

  func emitFrame(_ frames: OwnedAudioFrames, handlerIndex: Int? = nil) {
    let handler = lock.withLock { () -> (@Sendable (OwnedAudioFrames) -> Void)? in
      if let handlerIndex {
        return frameHandlers.indices.contains(handlerIndex) ? frameHandlers[handlerIndex] : nil
      }
      return frameHandlers.last
    }
    guard let handler else {
      frames.zeroize()
      return
    }
    handler(frames)
  }

  func emitEvent(_ event: AppleAudioSystemEvent, handlerIndex: Int? = nil) {
    let handler = lock.withLock { () -> (@Sendable (AppleAudioSystemEvent) -> Void)? in
      if let handlerIndex {
        return eventHandlers.indices.contains(handlerIndex) ? eventHandlers[handlerIndex] : nil
      }
      return currentEventHandler
    }
    handler?(event)
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

private final class CompletionFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var finished = false

  var isFinished: Bool { lock.withLock { finished } }
  func finish() { lock.withLock { finished = true } }
}

private func assertDriverFailure(
  _ operation: () async throws -> Void
) async {
  do {
    try await operation()
    XCTFail("expected bounded driver failure")
  } catch {
    XCTAssertTrue(error is AVFoundationDriverError)
  }
}

private func waitUntil(_ predicate: @escaping @Sendable () -> Bool) async throws {
  for _ in 0..<500 {
    if predicate() { return }
    await Task.yield()
    try await Task.sleep(nanoseconds: 100_000)
  }
  throw WaitTimeout()
}

private func waitUntilAsync(
  _ predicate: @escaping @Sendable () async -> Bool
) async throws {
  for _ in 0..<500 {
    if await predicate() { return }
    await Task.yield()
    try await Task.sleep(nanoseconds: 100_000)
  }
  throw WaitTimeout()
}

private struct WaitTimeout: Error {}

private func permissionKey(_ value: MicrophonePermission) -> String {
  switch value {
  case .granted: "granted"
  case .denied: "denied"
  case .restricted: "restricted"
  case .unavailable: "unavailable"
  }
}

private func eventKey(_ value: PCMAudioEvent) -> String {
  switch value {
  case .interruption: "interruption"
  case .routeChanged: "routeChanged"
  case .backgrounded: "backgrounded"
  case .permissionRevoked: "permissionRevoked"
  case .captureFailed: "captureFailed"
  }
}
