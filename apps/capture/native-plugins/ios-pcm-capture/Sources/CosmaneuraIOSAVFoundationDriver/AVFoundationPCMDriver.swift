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

public enum AppleAudioSessionProfile: Equatable, Sendable {
  /// Foreground recording in measurement mode with an explicitly selected input.
  /// It grants no background execution and does not mix with other audio.
  case foregroundTwoPartySpeech
  /// Same speech input profile, owned by a native encrypted recorder. The host
  /// must provide audio background mode and native authority/watchdog renewal.
  case nativeEncryptedSpeech
}

public enum AppleRecordingLifecycle: Equatable, Sendable {
  case foregroundOnly
  /// Native code only. Never expose this choice through the PCM JavaScript API.
  case nativeEncrypted
}

public enum AppleMicrophoneInput: String, Sendable {
  case builtIn = "built_in"
  case bluetooth
  case external
}

/// Next-start preference only. Changing it never activates or reroutes audio.
/// The bridge serializes selection against process-wide capture ownership.
public final class AppleMicrophoneInputPreference: @unchecked Sendable {
  private let lock = NSLock()
  private var input: AppleMicrophoneInput = .builtIn
  private var uid: String?

  public init() {}
  public var selected: AppleMicrophoneInput { lock.withLock { input } }
  public var selectedUID: String? { lock.withLock { uid } }
  public func select(_ value: AppleMicrophoneInput, uid: String? = nil) {
    lock.withLock { input = value; self.uid = uid }
  }
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
  private let callbackGate: DriverCallbackGate
  private let profile: AppleAudioSessionProfile
  private let frameCapacity: UInt32
  private var session: Session?
  private var releaseWaiters: [CheckedContinuation<Bool, Never>] = []
  private var lastReleasedSessionID: UInt64?
  private var nextGeneration: UInt64 = 0

  public init(
    system: any AppleAudioSystem,
    foreground: any AppleApplicationForegroundProviding,
    frameCapacity: UInt32 = 4_096,
    lifecycle: AppleRecordingLifecycle = .foregroundOnly,
    diagnostics: PCMStartupDiagnostics = .shared
  ) {
    self.system = system
    self.foreground = foreground
    callbackGate = DriverCallbackGate(continueInBackground: lifecycle == .nativeEncrypted, diagnostics: diagnostics)
    profile = lifecycle == .nativeEncrypted ? .nativeEncryptedSpeech : .foregroundTwoPartySpeech
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
    PCMStartupDiagnostics.shared.record(.driverStarting)
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
      try system.configureAndActivate(profile: profile)
      PCMStartupDiagnostics.shared.record(.sessionActivated)
      try validateStarting(sessionID, generation, cancellation)
      try checkStartupEvents(generation)
      try system.installInputTap(frameCapacity: frameCapacity) { [callbackGate] frames in
        callbackGate.receive(frames: frames, generation: generation)
      }
      PCMStartupDiagnostics.shared.record(.tapInstalled)
      try validateStarting(sessionID, generation, cancellation)
      try checkStartupEvents(generation)
      try system.startEngine()
      PCMStartupDiagnostics.shared.record(.engineStarted)
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
      PCMStartupDiagnostics.shared.record(.driverArmed)
    } catch {
      PCMStartupDiagnostics.shared.record(.driverRejected)
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
      PCMStartupDiagnostics.shared.record(.inputFrozen)
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
    PCMStartupDiagnostics.shared.record(.driverReleased)
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

final class DriverCallbackGate: @unchecked Sendable {
  // Internal deterministic seam: tests can hold an already-consumed receipt's
  // retirement, matching a delayed awaiting task. Production supplies nil.
  typealias DeferredRetirement = @Sendable (@escaping @Sendable () -> Void) async -> Void
  private enum FrameDecision {
    case offer(PCMAudioCallbacks, UInt64)
    case reject
    case overflow
  }

  private let lock = NSLock()
  private let continueInBackground: Bool
  private let diagnostics: PCMStartupDiagnostics
  private var generation: UInt64?
  private var callbacks: PCMAudioCallbacks?
  private var framesOpen = false
  private var frameOutstanding = false
  private var frameReceipt: PCMFrameAdmission?
  private var frameToken: UInt64 = 0
  private var eventsArmed = false
  private var startupFailed = false
  private var terminalEventSent = false
  private var hardEventSent = false
  private var frameWaiters: [CheckedContinuation<Bool, Never>] = []
  private var terminalDelivery: Task<Void, Never>?
  private let deferredRetirement: DeferredRetirement?

  init(continueInBackground: Bool, diagnostics: PCMStartupDiagnostics,
    deferredRetirement: DeferredRetirement? = nil) {
    self.continueInBackground = continueInBackground
    self.diagnostics = diagnostics
    self.deferredRetirement = deferredRetirement
  }

  func activate(generation: UInt64, callbacks: PCMAudioCallbacks) {
    lock.withLock {
      self.generation = generation
      self.callbacks = callbacks
      framesOpen = false
      frameOutstanding = false
      frameReceipt = nil
      frameToken = 0
      eventsArmed = false
      startupFailed = false
      terminalEventSent = false
      hardEventSent = false
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
    let retired = lock.withLock { () -> (Task<Void, Never>?, [CheckedContinuation<Bool, Never>]) in
      guard self.generation == generation else { return (nil, []) }
      framesOpen = false
      callbacks = nil
      self.generation = nil
      frameReceipt = nil
      let delivery = terminalDelivery
      terminalDelivery = nil
      defer { frameWaiters.removeAll() }
      return (delivery, frameWaiters)
    }
    for waiter in retired.1 { waiter.resume(returning: false) }
    return retired.0
  }

  func receive(frames: OwnedAudioFrames, generation: UInt64) {
    let decision = lock.withLock { () -> FrameDecision in
      guard self.generation == generation, framesOpen, let callbacks else {
        return .reject
      }
      // The core may have consumed the buffer before this driver's awaiting
      // task is scheduled again. That completed receipt is not backpressure.
      // An actually unconsumed buffer still closes capture without queuing.
      guard (!frameOutstanding || frameReceipt?.isConsumed == true),
        frameToken < UInt64.max else {
        framesOpen = false
        if !terminalEventSent {
          diagnostics.record(.driverAdmissionOverflow)
          terminalEventSent = true
          hardEventSent = true
          callbacks.invalidate?(.captureFailed)
          terminalDelivery = Task { await callbacks.event(.captureFailed) }
        }
        return .overflow
      }
      frameToken += 1
      frameOutstanding = true
      frameReceipt = nil
      return .offer(callbacks, frameToken)
    }

    switch decision {
    case .reject:
      frames.zeroize()
    case .overflow:
      frames.zeroize()
    case .offer(let callbacks, let token):
      let admission = callbacks.frames(frames)
      guard admission.accepted else {
        frames.zeroize()
        completeFrame(generation: generation, token: token)
        return
      }
      lock.withLock {
        guard self.generation == generation, frameToken == token else { return }
        frameReceipt = admission
      }
      Task { [weak self] in
        await admission.waitUntilConsumed()
        if let deferred = self?.deferredRetirement {
          await deferred { [weak self] in self?.completeFrame(generation: generation, token: token) }
        } else {
          self?.completeFrame(generation: generation, token: token)
        }
      }
    }
  }

  func receive(event: AppleAudioSystemEvent, generation: UInt64) {
    let mapped = Self.map(event)
    let benign = event == .routeChanged || event == .interruptionBegan
    lock.withLock {
      guard self.generation == generation, let storedCallbacks = callbacks else { return }
      guard eventsArmed else {
        if event == .configurationChanged { return }
        startupFailed = true
        terminalEventSent = true
        return
      }
      if event == .backgrounded && continueInBackground { return }
      // Only the native encrypted graph opts into preservation. Its hard events
      // still override a prior benign event; a stopped source never reopens.
      let preserve = continueInBackground && storedCallbacks.invalidate != nil
      let deliveryEvent: PCMAudioEvent = preserve && event == .configurationChanged ? .captureFailed : mapped
      if terminalEventSent && (!preserve || benign || hardEventSent) { return }
      terminalEventSent = true
      framesOpen = false
      if !benign {
        hardEventSent = true
        // Lock order is driver admission → native sink → queue store. The
        // native invalidator only fences the sink; it must never call back into
        // the driver. Sink observers schedule an actor task after releasing the
        // sink lock, so no reverse acquisition exists in the native graph.
        storedCallbacks.invalidate?(deliveryEvent)
        for waiter in frameWaiters { waiter.resume(returning: false) }
        frameWaiters.removeAll()
      }
      terminalDelivery = Task { [weak self] in
        // Keep the one already-admitted callback ahead of a benign close, while
        // rejecting every later callback. Hard invalidation never waits for it.
        if preserve && benign {
          guard await self?.waitForFrame(generation: generation) == true else { return }
        }
        await storedCallbacks.event(deliveryEvent)
      }
    }
  }

  private func waitForFrame(generation: UInt64) async -> Bool {
    await withCheckedContinuation { continuation in
      let immediate = lock.withLock { () -> Bool? in
        guard self.generation == generation, !hardEventSent else { return false }
        guard frameOutstanding else { return true }
        frameWaiters.append(continuation)
        return nil
      }
      if let immediate { continuation.resume(returning: immediate) }
      else {
        // Do not leave the microphone waiting indefinitely on an admitted
        // callback. Timeout is a hard failure, so partial audio is discarded.
        Task { [weak self] in
          try? await Task.sleep(for: .seconds(2))
          self?.expireFrameWait(generation: generation)
        }
      }
    }
  }

  private func expireFrameWait(generation: UInt64) {
    let pending = lock.withLock {
      self.generation == generation && frameOutstanding && !frameWaiters.isEmpty
    }
    if pending { receive(event: .captureFailed, generation: generation) }
  }

  private func completeFrame(generation: UInt64, token: UInt64) {
    let waiters = lock.withLock { () -> [CheckedContinuation<Bool, Never>] in
      // A delayed completion cannot retire a newer, still unconsumed buffer.
      guard self.generation == generation, frameToken == token else { return [] }
      frameOutstanding = false
      frameReceipt = nil
      defer { frameWaiters.removeAll() }
      return frameWaiters
    }
    for waiter in waiters { waiter.resume(returning: true) }
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
