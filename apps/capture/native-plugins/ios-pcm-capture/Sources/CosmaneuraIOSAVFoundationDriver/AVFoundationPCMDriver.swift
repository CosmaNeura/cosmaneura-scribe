import CosmaneuraIOSPCMCore
import Foundation

public enum AppleMicrophonePermissionState: Equatable, Sendable {
  case notDetermined
  case granted
  case denied
  case restricted
  case unavailable
}

public protocol AppleMicrophonePermissionProviding: Sendable {
  func currentPermission() -> AppleMicrophonePermissionState
  func requestPermission() async -> AppleMicrophonePermissionState
}

/// Converts the complete Apple permission domain to the core's bounded domain.
/// Cancellation wins locally even if a provider callback arrives late.
public struct AVFoundationMicrophonePermissionAdapter:
  MicrophonePermissionAuthorizing, Sendable
{
  private let provider: any AppleMicrophonePermissionProviding

  public init(provider: any AppleMicrophonePermissionProviding) {
    self.provider = provider
  }

  public func requestPermission(
    cancellation: StartupCancellation
  ) async -> MicrophonePermission {
    if cancellation.isCancelled { return .unavailable }
    let current = provider.currentPermission()
    guard current == .notDetermined else { return Self.map(current) }

    let first = PermissionFirstResult()
    Task.detached { [provider] in
      first.resolve(Self.map(await provider.requestPermission()))
    }
    Task.detached {
      await cancellation.waitUntilCancelled()
      first.resolve(.unavailable)
    }
    return await first.wait()
  }

  private static func map(
    _ state: AppleMicrophonePermissionState
  ) -> MicrophonePermission {
    switch state {
    case .granted: .granted
    case .denied: .denied
    case .restricted: .restricted
    case .notDetermined, .unavailable: .unavailable
    }
  }
}

public enum AppleAudioSystemEvent: Equatable, Sendable {
  case configurationChanged
  case interruptionBegan
  case routeChanged
  case mediaServicesLost
  case mediaServicesReset
  case backgrounded
  case permissionRevoked
  case captureFailed
}

public enum AppleAudioSessionProfile: Sendable {
  /// Foreground-only speakerphone speech: play-and-record, voice-chat mode,
  /// default speaker, and Bluetooth hands-free input. It grants no background
  /// execution and does not mix capture with other audio.
  case foregroundTwoPartySpeech
}

public protocol AppleApplicationForegroundProviding: Sendable {
  func isForegroundActive() async -> Bool
}

/// Injectable boundary around AVAudioSession, AVAudioEngine, and lifecycle
/// notifications. Implementations must not log native error or audio detail.
public protocol AppleAudioSystem: Sendable {
  func setEventHandler(
    _ handler: @escaping @Sendable (AppleAudioSystemEvent) -> Void
  )
  func clearEventHandler()
  func configureAndActivate(profile: AppleAudioSessionProfile) throws
  func installInputTap(
    frameCapacity: UInt32,
    handler: @escaping @Sendable (OwnedAudioFrames) -> Void
  ) throws
  func startEngine() throws
  func freezeInput() throws
  func deactivate() throws
}

public enum AVFoundationDriverError: Error, Sendable {
  case operationFailed
}

/// Serialized live driver for the reviewed PCM core. Native failures are
/// deliberately collapsed to one bounded error; the core owns public mapping.
public actor AVFoundationPCMDriver: PCMAudioDriving {
  private enum Phase: Equatable {
    case starting
    case active
    case startFailed
    case freezeFailed
    case frozen
    case releaseFailed
    case releasing
  }

  private struct Session {
    let id: UInt64
    let generation: UInt64
    var phase: Phase
  }

  private let system: any AppleAudioSystem
  private let foreground: any AppleApplicationForegroundProviding
  private let callbackGate = DriverCallbackGate()
  private let frameCapacity: UInt32
  private var session: Session?
  private var releaseWaiters: [CheckedContinuation<Bool, Never>] = []
  private var lastReleasedSessionID: UInt64?
  private var nextGeneration: UInt64 = 0

  public init(
    system: any AppleAudioSystem,
    foreground: any AppleApplicationForegroundProviding,
    frameCapacity: UInt32 = 4_096
  ) {
    self.system = system
    self.foreground = foreground
    self.frameCapacity = min(
      max(frameCapacity, 1),
      UInt32(PCMConfiguration.maximumFramesPerInputBuffer)
    )
  }

  public func start(
    sessionID: UInt64,
    callbacks: PCMAudioCallbacks,
    cancellation: StartupCancellation
  ) async throws {
    guard session == nil, nextGeneration < UInt64.max else {
      throw AVFoundationDriverError.operationFailed
    }
    nextGeneration += 1
    let generation = nextGeneration
    session = Session(id: sessionID, generation: generation, phase: .starting)
    callbackGate.activate(generation: generation, callbacks: callbacks)
    system.setEventHandler { [callbackGate] event in
      callbackGate.receive(event: event, generation: generation)
    }

    do {
      try validateStarting(sessionID, generation, cancellation)
      let activeBeforeActivation = await foreground.isForegroundActive()
      try validateStarting(sessionID, generation, cancellation)
      guard activeBeforeActivation else {
        throw AVFoundationDriverError.operationFailed
      }
      try checkStartupEvents(generation)
      try system.configureAndActivate(profile: .foregroundTwoPartySpeech)
      try validateStarting(sessionID, generation, cancellation)
      try checkStartupEvents(generation)
      try system.installInputTap(frameCapacity: frameCapacity) { [callbackGate] frames in
        callbackGate.receive(frames: frames, generation: generation)
      }
      try validateStarting(sessionID, generation, cancellation)
      try checkStartupEvents(generation)
      try system.startEngine()
      try validateStarting(sessionID, generation, cancellation)
      let activeBeforeArming = await foreground.isForegroundActive()
      try validateStarting(sessionID, generation, cancellation)
      guard activeBeforeArming else {
        throw AVFoundationDriverError.operationFailed
      }
      guard callbackGate.arm(generation: generation) else {
        throw AVFoundationDriverError.operationFailed
      }
      session?.phase = .active
    } catch {
      callbackGate.freezeFrames(generation: generation)
      markStartFailed(sessionID: sessionID, generation: generation)
      throw AVFoundationDriverError.operationFailed
    }
  }

  public func freezeInput(sessionID: UInt64) async throws {
    guard var current = session else {
      if lastReleasedSessionID == sessionID { return }
      throw AVFoundationDriverError.operationFailed
    }
    guard current.id == sessionID else {
      throw AVFoundationDriverError.operationFailed
    }
    if current.phase == .frozen || current.phase == .releaseFailed
      || current.phase == .releasing
    {
      return
    }

    callbackGate.freezeFrames(generation: current.generation)
    do {
      try system.freezeInput()
      current.phase = .frozen
      session = current
    } catch {
      current.phase = .freezeFailed
      session = current
      throw AVFoundationDriverError.operationFailed
    }
  }

  public func release(sessionID: UInt64) async throws {
    guard var current = session else {
      if lastReleasedSessionID == sessionID { return }
      throw AVFoundationDriverError.operationFailed
    }
    guard current.id == sessionID,
      current.phase == .frozen || current.phase == .releaseFailed
        || current.phase == .releasing
    else { throw AVFoundationDriverError.operationFailed }

    if current.phase == .releasing {
      let succeeded = await withCheckedContinuation { releaseWaiters.append($0) }
      guard succeeded, lastReleasedSessionID == sessionID else {
        throw AVFoundationDriverError.operationFailed
      }
      return
    }

    do {
      try system.deactivate()
    } catch {
      current.phase = .releaseFailed
      session = current
      throw AVFoundationDriverError.operationFailed
    }
    current.phase = .releasing
    session = current
    let delivery = callbackGate.retireAdmission(generation: current.generation)
    system.clearEventHandler()
    await delivery?.value
    guard let retained = session,
      retained.id == sessionID,
      retained.generation == current.generation,
      retained.phase == .releasing
    else {
      finishReleaseWaiters(succeeded: false)
      throw AVFoundationDriverError.operationFailed
    }
    session = nil
    lastReleasedSessionID = sessionID
    finishReleaseWaiters(succeeded: true)
  }

  private func validateStarting(
    _ sessionID: UInt64,
    _ generation: UInt64,
    _ cancellation: StartupCancellation
  ) throws {
    guard let current = session,
      current.id == sessionID,
      current.generation == generation,
      current.phase == .starting,
      !cancellation.isCancelled
    else { throw AVFoundationDriverError.operationFailed }
  }

  private func markStartFailed(sessionID: UInt64, generation: UInt64) {
    guard var current = session,
      current.id == sessionID,
      current.generation == generation,
      current.phase == .starting
    else { return }
    current.phase = .startFailed
    session = current
  }

  private func checkStartupEvents(_ generation: UInt64) throws {
    if !callbackGate.startupIsClear(generation: generation) {
      throw AVFoundationDriverError.operationFailed
    }
  }

  private func finishReleaseWaiters(succeeded: Bool) {
    let waiters = releaseWaiters
    releaseWaiters.removeAll(keepingCapacity: false)
    for waiter in waiters { waiter.resume(returning: succeeded) }
  }

  func releaseWaiterCountForTesting() -> Int { releaseWaiters.count }
}

private final class PermissionFirstResult: @unchecked Sendable {
  private let lock = NSLock()
  private var result: MicrophonePermission?
  private var waiter: CheckedContinuation<MicrophonePermission, Never>?

  func resolve(_ value: MicrophonePermission) {
    let continuation = lock.withLock { () -> CheckedContinuation<MicrophonePermission, Never>? in
      guard result == nil else { return nil }
      result = value
      let pending = waiter
      waiter = nil
      return pending
    }
    continuation?.resume(returning: value)
  }

  func wait() async -> MicrophonePermission {
    if let value = lock.withLock({ result }) { return value }
    return await withCheckedContinuation { continuation in
      let value = lock.withLock { () -> MicrophonePermission? in
        if let result { return result }
        waiter = continuation
        return nil
      }
      if let value { continuation.resume(returning: value) }
    }
  }
}

private final class DriverCallbackGate: @unchecked Sendable {
  private enum FrameDecision {
    case offer(PCMAudioCallbacks)
    case reject
    case overflow
  }

  private let lock = NSLock()
  private var generation: UInt64?
  private var callbacks: PCMAudioCallbacks?
  private var framesOpen = false
  private var frameOutstanding = false
  private var eventsArmed = false
  private var startupFailed = false
  private var terminalEventSent = false
  private var terminalDelivery: Task<Void, Never>?

  func activate(generation: UInt64, callbacks: PCMAudioCallbacks) {
    lock.withLock {
      self.generation = generation
      self.callbacks = callbacks
      framesOpen = false
      frameOutstanding = false
      eventsArmed = false
      startupFailed = false
      terminalEventSent = false
      terminalDelivery = nil
    }
  }

  func startupIsClear(generation: UInt64) -> Bool {
    lock.withLock { self.generation == generation && !startupFailed }
  }

  func arm(generation: UInt64) -> Bool {
    lock.withLock {
      guard self.generation == generation, !startupFailed else { return false }
      eventsArmed = true
      framesOpen = true
      return true
    }
  }

  func freezeFrames(generation: UInt64) {
    lock.withLock {
      guard self.generation == generation else { return }
      framesOpen = false
    }
  }

  func retireAdmission(generation: UInt64) -> Task<Void, Never>? {
    lock.withLock {
      guard self.generation == generation else { return nil }
      framesOpen = false
      callbacks = nil
      self.generation = nil
      let delivery = terminalDelivery
      terminalDelivery = nil
      return delivery
    }
  }

  func receive(frames: OwnedAudioFrames, generation: UInt64) {
    let decision = lock.withLock { () -> FrameDecision in
      guard self.generation == generation, framesOpen, let callbacks else {
        return .reject
      }
      guard !frameOutstanding else {
        framesOpen = false
        if !terminalEventSent {
          terminalEventSent = true
          terminalDelivery = Task { await callbacks.event(.captureFailed) }
        }
        return .overflow
      }
      frameOutstanding = true
      return .offer(callbacks)
    }

    switch decision {
    case .reject:
      frames.zeroize()
    case .overflow:
      frames.zeroize()
    case .offer(let callbacks):
      let admission = callbacks.frames(frames)
      guard admission.accepted else {
        frames.zeroize()
        completeFrame(generation: generation)
        return
      }
      Task { [weak self] in
        await admission.waitUntilConsumed()
        self?.completeFrame(generation: generation)
      }
    }
  }

  func receive(event: AppleAudioSystemEvent, generation: UInt64) {
    let mapped = Self.map(event)
    lock.withLock {
      guard self.generation == generation, !terminalEventSent,
        let storedCallbacks = callbacks
      else { return }
      guard eventsArmed else {
        if event == .configurationChanged { return }
        startupFailed = true
        terminalEventSent = true
        return
      }
      terminalEventSent = true
      framesOpen = false
      terminalDelivery = Task { await storedCallbacks.event(mapped) }
    }
  }

  private func completeFrame(generation: UInt64) {
    lock.withLock {
      guard self.generation == generation else { return }
      frameOutstanding = false
    }
  }

  private static func map(_ event: AppleAudioSystemEvent) -> PCMAudioEvent {
    switch event {
    case .interruptionBegan: .interruption
    case .configurationChanged, .routeChanged: .routeChanged
    case .backgrounded: .backgrounded
    case .permissionRevoked: .permissionRevoked
    case .mediaServicesLost, .mediaServicesReset, .captureFailed: .captureFailed
    }
  }
}
