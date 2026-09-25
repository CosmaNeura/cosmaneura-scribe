import CosmaneuraIOSAVFoundationDriver
import CosmaneuraIOSPCMCore
import Foundation

public enum IOSPCMBridgeAppState: String, Sendable {
  case foreground
  case background
}

public enum IOSPCMBridgeStartErrorCode: String, Sendable {
  case permissionDenied = "ios_microphone_permission_denied"
  case permissionRestricted = "ios_microphone_permission_restricted"
  case microphoneUnavailable = "ios_microphone_unavailable"
  case notForeground = "ios_capture_not_foreground"
  case startFailed = "ios_capture_start_failed"
}

public enum IOSPCMBridgeErrorCode: String, Sendable {
  case captureFailed = "ios_capture_failed"
  case stopFailed = "ios_capture_stop_failed"
}

public struct IOSPCMBridgeStartFailure: Error, Equatable, Sendable {
  public let code: IOSPCMBridgeStartErrorCode

  public init(_ code: IOSPCMBridgeStartErrorCode) { self.code = code }
}

public struct IOSPCMBridgeFailure: Error, Equatable, Sendable {
  public let code: IOSPCMBridgeErrorCode

  public init(_ code: IOSPCMBridgeErrorCode) { self.code = code }
}

public enum IOSPCMBridgeInterruptionCode: String, Sendable {
  case audioSessionInterrupted = "ios_audio_session_interrupted"
  case audioRouteChanged = "ios_audio_route_changed"
  case captureBackgrounded = "ios_capture_backgrounded"
}

public enum IOSPCMBridgeTerminalErrorCode: String, Sendable {
  case microphonePermissionRevoked = "ios_microphone_permission_revoked"
  case captureStalled = "ios_capture_stalled"
  case captureFailed = "ios_capture_failed"
}

public enum IOSPCMBridgeStopMode: Equatable, Sendable {
  case drain
  case discard
}

public struct IOSPCMBridgeConfiguration: Equatable, Sendable {
  public let encoding: String
  public let channels: Int
  public let sampleRateHz: Int
  public let targetFramesPerChunk: Int
  public let maximumChunks: Int
  public let authority: PCMSourceAuthority?

  public init(
    encoding: String,
    channels: Int,
    sampleRateHz: Int,
    targetFramesPerChunk: Int,
    maximumChunks: Int,
    authority: PCMSourceAuthority? = nil
  ) {
    self.encoding = encoding
    self.channels = channels
    self.sampleRateHz = sampleRateHz
    self.targetFramesPerChunk = targetFramesPerChunk
    self.maximumChunks = maximumChunks
    self.authority = authority
  }
}

public struct IOSPCMBridgeSessionToken: Hashable, Sendable {
  public let rawValue: String

  public init(rawValue: String) { self.rawValue = rawValue }
}

/// Mutable bytes owned by this bridge. Callers may inspect them only inside
/// `withUnsafeBytes`; acknowledgement or explicit zeroization clears storage.
public final class IOSPCMBridgeOwnedBytes: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [UInt8]

  fileprivate init(copying bytes: UnsafeRawBufferPointer) {
    storage = Array(bytes)
  }

  deinit { zeroize() }

  public var count: Int { lock.withLock { storage.count } }

  public func withUnsafeBytes<Result>(
    _ body: (UnsafeRawBufferPointer) throws -> Result
  ) rethrows -> Result {
    try lock.withLock { try storage.withUnsafeBytes(body) }
  }

  public func zeroize() {
    lock.withLock {
      for index in storage.indices { storage[index] = 0 }
    }
  }

  public var isZeroized: Bool {
    lock.withLock { storage.allSatisfy { $0 == 0 } }
  }
}

public final class IOSPCMBridgePacket: @unchecked Sendable {
  public let sessionToken: IOSPCMBridgeSessionToken
  public let sequenceNumber: UInt64
  public let bytes: IOSPCMBridgeOwnedBytes

  fileprivate init(
    sessionToken: IOSPCMBridgeSessionToken,
    sequenceNumber: UInt64,
    bytes: IOSPCMBridgeOwnedBytes
  ) {
    self.sessionToken = sessionToken
    self.sequenceNumber = sequenceNumber
    self.bytes = bytes
  }
}

public enum IOSPCMBridgeEvent: Sendable {
  case packetAvailable(IOSPCMBridgePacket)
  case interruption(IOSPCMBridgeSessionToken, IOSPCMBridgeInterruptionCode)
  case terminal(IOSPCMBridgeSessionToken, IOSPCMBridgeTerminalErrorCode)
  case windowClosed(IOSPCMBridgeSessionToken, PCMWindowCloseReason)
}

public protocol IOSPCMBridgeEventPublishing: Sendable {
  /// Implementations must not retain or log packet content. A future native
  /// wrapper may encode bytes during this call, then await explicit JS ack.
  func publish(_ event: IOSPCMBridgeEvent) throws
}

public enum IOSPCMBridgeAcknowledgementResult: Equatable, Sendable {
  case accepted
  case replayed
  case stale
}

public enum IOSPCMBridgeReplayResult: Equatable, Sendable {
  case replayed
  case alreadyAcknowledged
  case stale
  case transportFailed
}

public struct IOSPCMBridgeStopResult: Sendable {
  public let finalPacket: IOSPCMBridgePacket?
}

/// Synchronous token ownership plus async lifecycle operations for a future
/// Capacitor wrapper. This target is not linked into the application.
public final class IOSPCMBridgeCore: @unchecked Sendable {
  private final class SessionRecord: @unchecked Sendable {
    let ownershipID: UUID
    let token: IOSPCMBridgeSessionToken
    let generation: UInt64
    let core: IOSPCMCore
    let handle: IOSPCMSessionHandle
    let configuration: PCMConfiguration
    private let lock = NSLock()
    private var requestedMode: IOSPCMBridgeStopMode?
    private var completed = false
    private var stopTask: Task<PCMStopResult, Error>?
    private var stopTaskMode: IOSPCMBridgeStopMode?
    private var discardUpgradeTask: Task<PCMStopResult, Error>?
    private var stopPrimaryCompleted = false
    private var stopAttempt: UInt64 = 0

    init(
      ownershipID: UUID,
      token: IOSPCMBridgeSessionToken,
      generation: UInt64,
      core: IOSPCMCore,
      handle: IOSPCMSessionHandle,
      configuration: PCMConfiguration
    ) {
      self.ownershipID = ownershipID
      self.token = token
      self.generation = generation
      self.core = core
      self.handle = handle
      self.configuration = configuration
    }

    func performStop(_ mode: IOSPCMBridgeStopMode) async throws -> PCMStopResult {
      let work = lock.withLock {
        () -> (
          primary: Task<PCMStopResult, Error>,
          attempt: UInt64
        ) in
        let sessionHandle = handle
        if requestedMode == nil || mode == .discard { requestedMode = mode }
        if let stopTask {
          if mode == .discard, stopTaskMode == .drain,
            !stopPrimaryCompleted, discardUpgradeTask == nil
          {
            discardUpgradeTask = Task { try await sessionHandle.stop(.discard) }
          }
          return (stopTask, stopAttempt)
        }
        let coreMode: PCMStopMode = requestedMode == .drain ? .drain : .discard
        stopAttempt &+= 1
        let attempt = stopAttempt
        let created = Task<PCMStopResult, Error> {
          try await sessionHandle.stop(coreMode)
        }
        stopTask = created
        stopTaskMode = requestedMode
        discardUpgradeTask = nil
        stopPrimaryCompleted = false
        return (created, attempt)
      }

      let primaryResult: Result<PCMStopResult, Error>
      do {
        primaryResult = .success(try await work.primary.value)
      } catch {
        primaryResult = .failure(error)
      }

      let primaryFailed: Bool
      switch primaryResult {
      case .success: primaryFailed = false
      case .failure: primaryFailed = true
      }
      let upgrade = lock.withLock { () -> Task<PCMStopResult, Error>? in
        guard stopAttempt == work.attempt else { return nil }
        stopPrimaryCompleted = true
        if let discardUpgradeTask { return discardUpgradeTask }
        if primaryFailed {
          stopTask = nil
          stopTaskMode = nil
          stopPrimaryCompleted = false
        }
        return nil
      }
      let upgradeResult: Result<PCMStopResult, Error>?
      if let upgrade {
        do {
          upgradeResult = .success(try await upgrade.value)
        } catch {
          upgradeResult = .failure(error)
        }
      } else {
        upgradeResult = nil
      }

      switch (primaryResult, upgradeResult) {
      case (.success(let primary), .success(let upgraded)):
        upgraded.finalPacket?.bytes.zeroize()
        return primary
      case (.success(let primary), _):
        return primary
      case (.failure, .success(let upgraded)):
        return upgraded
      case (.failure(let error), .failure), (.failure(let error), nil):
        lock.withLock {
          if stopAttempt == work.attempt {
            stopTask = nil
            stopTaskMode = nil
            discardUpgradeTask = nil
            stopPrimaryCompleted = false
          }
        }
        throw error
      }
    }

    func requestDiscard() {
      lock.withLock {
        if !completed { requestedMode = .discard }
      }
    }

    func finishSuccessfully() -> (first: Bool, mode: IOSPCMBridgeStopMode) {
      lock.withLock {
        guard !completed else { return (false, requestedMode ?? .discard) }
        completed = true
        return (true, requestedMode ?? .discard)
      }
    }

    var stopWasRequested: Bool { lock.withLock { requestedMode != nil } }
  }

  private struct PendingPacket {
    let token: IOSPCMBridgeSessionToken
    let generation: UInt64
    let packet: IOSPCMBridgePacket
    let acknowledgement: BridgeAcknowledgement

    var sequenceNumber: UInt64 { packet.sequenceNumber }
  }

  private let lock = NSLock()
  private let permission: any MicrophonePermissionAuthorizing
  private let audio: any PCMAudioDriving
  private let foreground: any AppleApplicationForegroundProviding
  private let events: any IOSPCMBridgeEventPublishing
  private let clock: any PCMClock
  private let sourceClock: any PCMSourceClock
  private let signalMonitor: PCMSignalMonitor?
  private var usedRunIDs: Set<String> = []
  private let tokenSource: @Sendable () -> String
  private var nextGeneration: UInt64 = 0
  private var session: SessionRecord?
  private var lastClosedToken: IOSPCMBridgeSessionToken?
  private var pending: PendingPacket?
  private var lastAcknowledged: (token: IOSPCMBridgeSessionToken, sequence: UInt64)?

  public init(
    permission: any MicrophonePermissionAuthorizing,
    audio: any PCMAudioDriving,
    foreground: any AppleApplicationForegroundProviding,
    events: any IOSPCMBridgeEventPublishing,
    clock: any PCMClock = ContinuousPCMClock(),
    sourceClock: any PCMSourceClock = ContinuousPCMSourceClock(),
    signalMonitor: PCMSignalMonitor? = nil,
    tokenSource: @escaping @Sendable () -> String = {
      UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
  ) {
    self.permission = permission
    self.audio = audio
    self.foreground = foreground
    self.events = events
    self.clock = clock
    self.sourceClock = sourceClock
    self.signalMonitor = signalMonitor
    self.tokenSource = tokenSource
  }

  #if os(iOS)
    /// Dormant live composition. No app target imports or selects this module.
    public convenience init(events: any IOSPCMBridgeEventPublishing) {
      let foreground = LiveAppleApplicationForegroundProvider()
      let signalMonitor = PCMSignalMonitor()
      self.init(
        permission: AVFoundationMicrophonePermissionAdapter(
          provider: LiveAppleMicrophonePermissionProvider()
        ),
        audio: AVFoundationPCMDriver(
          system: LiveAppleAudioSystem(signalMonitor: signalMonitor),
          foreground: foreground
        ),
        foreground: foreground,
        events: events,
        signalMonitor: signalMonitor
      )
    }
  #endif

  public func appState() async -> IOSPCMBridgeAppState {
    await foreground.isForegroundActive() ? .foreground : .background
  }

  /// Includes every bridge instance in this native process, including pending
  /// permission/startup and failed Stop. A new WebView cannot hide an old owner.
  public func confirmCaptureIdle() -> Bool {
    CaptureProcessOwnership.shared.isIdle
  }

  /// Current recording only; no retained history or observer-owned capture action.
  public func captureSignal() -> PCMSignalMonitor.Snapshot? {
    lock.withLock {
      guard let session, !session.stopWasRequested else { return nil }
      return signalMonitor?.snapshot()
    }
  }

  /// Claims the single bridge slot and returns its opaque token before native
  /// permission or audio startup can wait.
  public func begin(
    configuration: IOSPCMBridgeConfiguration
  ) throws -> IOSPCMBridgeSessionToken {
    let coreConfiguration: PCMConfiguration
    do {
      guard configuration.encoding == PCMConfiguration.encoding,
        configuration.channels == PCMConfiguration.channels,
        configuration.sampleRateHz == PCMConfiguration.sampleRateHz
      else { throw PCMFailure(.invalidConfiguration) }
      coreConfiguration = try PCMConfiguration(
        targetFramesPerChunk: configuration.targetFramesPerChunk,
        maximumChunks: configuration.maximumChunks,
        maximumInputFramesPerBuffer: min(
          PCMConfiguration.maximumFramesPerInputBuffer,
          configuration.targetFramesPerChunk
        ),
        authority: configuration.authority
      )
    } catch {
      throw IOSPCMBridgeStartFailure(.startFailed)
    }

    // Keep this lock through handle creation and registry installation. The
    // handle may schedule readiness immediately, but every sink callback must
    // acquire this same lock before inspecting `session`, so a callback cannot
    // observe a successfully claimed token in an unbound intermediate state.
    lock.lock()
    defer { lock.unlock() }
    guard session == nil, nextGeneration < UInt64.max else {
      throw IOSPCMBridgeStartFailure(.startFailed)
    }
    if let runID = configuration.authority?.runID, usedRunIDs.contains(runID) {
      throw IOSPCMBridgeStartFailure(.startFailed)
    }
    let fragment = tokenSource()
    guard Self.validTokenFragment(fragment) else {
      throw IOSPCMBridgeStartFailure(.startFailed)
    }
    nextGeneration += 1
    let generation = nextGeneration
    let token = IOSPCMBridgeSessionToken(rawValue: "\(generation).\(fragment)")
    let sink = BridgeEmissionSink(owner: self, token: token, generation: generation)
    let core = IOSPCMCore(
      permission: permission,
      audio: audio,
      sink: sink,
      clock: clock,
      sourceClock: sourceClock,
      signalMonitor: signalMonitor
    )
    let ownershipID = CaptureProcessOwnership.shared.claim()
    do {
      signalMonitor?.reset()
      let handle = try core.start(configuration: coreConfiguration)
      if let runID = configuration.authority?.runID { usedRunIDs.insert(runID) }
      session = SessionRecord(
        ownershipID: ownershipID,
        token: token,
        generation: generation,
        core: core,
        handle: handle,
        configuration: coreConfiguration
      )
      lastAcknowledged = nil
      return token
    } catch {
      CaptureProcessOwnership.shared.release(ownershipID)
      throw IOSPCMBridgeStartFailure(.startFailed)
    }
  }

  public func ready(_ token: IOSPCMBridgeSessionToken) async throws {
    let record = try currentRecord(token)
    do {
      try await record.handle.ready()
    } catch let failure as PCMFailure {
      if failure.code != .stopFailed, !record.stopWasRequested {
        retire(record)
      }
      throw IOSPCMBridgeStartFailure(Self.mapStartFailure(failure.code))
    } catch {
      if !record.stopWasRequested { retire(record) }
      throw IOSPCMBridgeStartFailure(.startFailed)
    }
  }

  public func heartbeat(_ token: IOSPCMBridgeSessionToken) async throws {
    let record = try currentRecord(token)
    await record.handle.heartbeat()
  }

  public func extend(_ token: IOSPCMBridgeSessionToken, value: PCMSourceExtension) async throws {
    let record = try currentRecord(token)
    guard !record.stopWasRequested else { throw IOSPCMBridgeFailure(.captureFailed) }
    do {
      try await record.handle.extend(value)
      guard lock.withLock({ session === record }), !record.stopWasRequested else {
        throw IOSPCMBridgeFailure(.captureFailed)
      }
    } catch {
      throw IOSPCMBridgeFailure(.captureFailed)
    }
  }

  public func stop(
    _ token: IOSPCMBridgeSessionToken,
    mode: IOSPCMBridgeStopMode
  ) async throws -> IOSPCMBridgeStopResult {
    guard let record = try recordForStop(token) else {
      return IOSPCMBridgeStopResult(finalPacket: nil)
    }
    let result: PCMStopResult
    do {
      result = try await record.performStop(mode)
    } catch {
      throw IOSPCMBridgeFailure(.stopFailed)
    }

    let completion = record.finishSuccessfully()
    var finalPacket: IOSPCMBridgePacket?
    if completion.first {
      if completion.mode == .drain, let source = result.finalPacket {
        defer { source.bytes.zeroize() }
        guard source.sequenceNumber < UInt64(record.configuration.authority?.hardMaximumChunks
            ?? record.configuration.maximumChunks),
          source.bytes.count > 0,
          source.bytes.count < record.configuration.targetFramesPerChunk * 2,
          source.bytes.count.isMultiple(of: 2)
        else {
          retire(record)
          throw IOSPCMBridgeFailure(.captureFailed)
        }
        let bytes = source.bytes.withUnsafeBytes { IOSPCMBridgeOwnedBytes(copying: $0) }
        finalPacket = IOSPCMBridgePacket(
          sessionToken: token,
          sequenceNumber: source.sequenceNumber,
          bytes: bytes
        )
      } else {
        result.finalPacket?.bytes.zeroize()
      }
    }
    retire(record)
    return IOSPCMBridgeStopResult(finalPacket: finalPacket)
  }

  public func acknowledge(
    _ token: IOSPCMBridgeSessionToken,
    sequenceNumber: UInt64
  ) -> IOSPCMBridgeAcknowledgementResult {
    let candidate = lock.withLock { () -> BridgeAcknowledgement? in
      guard session?.token == token else { return nil }
      if let pending, pending.token == token,
        pending.sequenceNumber == sequenceNumber
      {
        return pending.acknowledgement
      }
      return nil
    }
    if let candidate {
      switch candidate.accept() {
      case .accepted: return .accepted
      case .alreadyAccepted: return .replayed
      case .failed: return .stale
      }
    }
    return lock.withLock {
      if lastAcknowledged?.token == token,
        lastAcknowledged?.sequence == sequenceNumber
      {
        return .replayed
      }
      return .stale
    }
  }

  public func replayPendingPacket(
    _ token: IOSPCMBridgeSessionToken,
    sequenceNumber: UInt64
  ) -> IOSPCMBridgeReplayResult {
    let candidate = lock.withLock { () -> PendingPacket? in
      guard session?.token == token else { return nil }
      return pending?.token == token && pending?.sequenceNumber == sequenceNumber
        ? pending : nil
    }
    guard let candidate else {
      return lock.withLock {
        if lastAcknowledged?.token == token,
          lastAcknowledged?.sequence == sequenceNumber
        {
          return .alreadyAcknowledged
        }
        return .stale
      }
    }
    switch candidate.acknowledgement.beginDelivery() {
    case .accepted: return .alreadyAcknowledged
    case .failed, .busy: return .stale
    case .started: break
    }
    do {
      try events.publish(.packetAvailable(candidate.packet))
    } catch {
      _ = candidate.acknowledgement.endDelivery()
      return .transportFailed
    }
    return candidate.acknowledgement.endDelivery() == .failed ? .stale : .replayed
  }

  private func currentRecord(
    _ token: IOSPCMBridgeSessionToken
  ) throws -> SessionRecord {
    try lock.withLock {
      guard let session, session.token == token else {
        throw IOSPCMBridgeFailure(.captureFailed)
      }
      return session
    }
  }

  private func recordForStop(
    _ token: IOSPCMBridgeSessionToken
  ) throws -> SessionRecord? {
    try lock.withLock {
      if let session, session.token == token { return session }
      if lastClosedToken == token { return nil }
      throw IOSPCMBridgeFailure(.captureFailed)
    }
  }

  fileprivate func publish(
    _ source: PCMEncodedPacket,
    token: IOSPCMBridgeSessionToken,
    generation: UInt64
  ) throws -> any PCMAcknowledging {
    let configuration = lock.withLock { () -> PCMConfiguration? in
      guard session?.token == token, session?.generation == generation else { return nil }
      return session?.configuration
    }
    guard let configuration,
      source.sequenceNumber < UInt64(configuration.authority?.hardMaximumChunks
        ?? configuration.maximumChunks),
      source.bytes.count == configuration.targetFramesPerChunk * 2
    else { throw BridgeTransportFailure.operationFailed }
    let bytes = source.bytes.withUnsafeBytes { IOSPCMBridgeOwnedBytes(copying: $0) }
    let packet = IOSPCMBridgePacket(
      sessionToken: token,
      sequenceNumber: source.sequenceNumber,
      bytes: bytes
    )
    let acknowledgement = BridgeAcknowledgement(packet: packet) {
      [weak self] acknowledgement, accepted in
      self?.settled(
        token: token,
        generation: generation,
        sequenceNumber: source.sequenceNumber,
        acknowledgement: acknowledgement,
        accepted: accepted
      )
    }
    let installed = lock.withLock { () -> Bool in
      guard session?.token == token, session?.generation == generation,
        pending == nil
      else { return false }
      pending = PendingPacket(
        token: token,
        generation: generation,
        packet: packet,
        acknowledgement: acknowledgement
      )
      return true
    }
    guard installed else {
      acknowledgement.cancel()
      throw BridgeTransportFailure.operationFailed
    }
    guard acknowledgement.beginDelivery() == .started else {
      acknowledgement.cancel()
      throw BridgeTransportFailure.operationFailed
    }
    defer { _ = acknowledgement.endDelivery() }
    do {
      try events.publish(.packetAvailable(packet))
      return acknowledgement
    } catch {
      acknowledgement.cancel()
      throw BridgeTransportFailure.operationFailed
    }
  }

  private func settled(
    token: IOSPCMBridgeSessionToken,
    generation: UInt64,
    sequenceNumber: UInt64,
    acknowledgement: BridgeAcknowledgement,
    accepted: Bool
  ) {
    lock.withLock {
      guard pending?.token == token, pending?.generation == generation,
        pending?.sequenceNumber == sequenceNumber,
        pending?.acknowledgement === acknowledgement
      else { return }
      pending = nil
      if accepted { lastAcknowledged = (token, sequenceNumber) }
    }
  }

  fileprivate func terminate(
    _ code: PCMTerminationCode,
    token: IOSPCMBridgeSessionToken,
    generation: UInt64
  ) {
    guard
      let record = lock.withLock({ () -> SessionRecord? in
        guard session?.token == token, session?.generation == generation else { return nil }
        return session
      })
    else { return }
    record.requestDiscard()

    do {
      switch code {
      case .interruption:
        try events.publish(.interruption(token, .audioSessionInterrupted))
      case .routeChanged:
        try events.publish(.interruption(token, .audioRouteChanged))
      case .backgrounded:
        try events.publish(.interruption(token, .captureBackgrounded))
      case .heartbeatExpired:
        try events.publish(.terminal(token, .captureStalled))
      case .permissionRevoked:
        try events.publish(.terminal(token, .microphonePermissionRevoked))
      case .captureFailed, .invalidPCM, .bufferOverflow, .outputLimitExceeded,
        .sinkFailed:
        try events.publish(.terminal(token, .captureFailed))
      }
    } catch {
      // A native transport failure cannot disclose its detail or reopen capture.
    }
    Task { [weak self] in await self?.closeAfterTermination(record) }
  }

  fileprivate func windowClosed(_ reason: PCMWindowCloseReason,
    token: IOSPCMBridgeSessionToken, generation: UInt64)
  {
    guard let record = lock.withLock({ () -> SessionRecord? in
      guard session?.token == token, session?.generation == generation else { return nil }
      return session
    }), !record.stopWasRequested else { return }
    do {
      try events.publish(.windowClosed(token, reason))
    } catch {
      terminate(.captureFailed, token: token, generation: generation)
    }
  }

  private func closeAfterTermination(_ record: SessionRecord) async {
    do {
      let result = try await record.performStop(.discard)
      result.finalPacket?.bytes.zeroize()
      _ = record.finishSuccessfully()
      retire(record)
    } catch {
      // The same token remains registered so an explicit stop can retry.
    }
  }

  private func retire(_ record: SessionRecord) {
    var retired = false
    let acknowledgement = lock.withLock { () -> BridgeAcknowledgement? in
      guard session === record else { return nil }
      retired = true
      session = nil
      lastClosedToken = record.token
      let acknowledgement = pending?.acknowledgement
      pending = nil
      lastAcknowledged = nil
      return acknowledgement
    }
    acknowledgement?.cancel()
    if retired { CaptureProcessOwnership.shared.release(record.ownershipID) }
  }

  private static func validTokenFragment(_ value: String) -> Bool {
    guard !value.isEmpty, value.utf8.count <= 64 else { return false }
    return value.utf8.allSatisfy {
      ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90)
        || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 95
    }
  }

  private static func mapStartFailure(
    _ code: PCMErrorCode
  ) -> IOSPCMBridgeStartErrorCode {
    switch code {
    case .permissionDenied: .permissionDenied
    case .permissionRestricted: .permissionRestricted
    case .microphoneUnavailable: .microphoneUnavailable
    default: .startFailed
    }
  }

}

private final class BridgeEmissionSink: PCMEmissionSink, @unchecked Sendable {
  private weak var owner: IOSPCMBridgeCore?
  private let token: IOSPCMBridgeSessionToken
  private let generation: UInt64

  init(
    owner: IOSPCMBridgeCore,
    token: IOSPCMBridgeSessionToken,
    generation: UInt64
  ) {
    self.owner = owner
    self.token = token
    self.generation = generation
  }

  func emit(_ packet: PCMEncodedPacket) throws -> any PCMAcknowledging {
    guard let owner else { throw BridgeTransportFailure.operationFailed }
    return try owner.publish(packet, token: token, generation: generation)
  }

  func terminated(_ code: PCMTerminationCode) {
    owner?.terminate(code, token: token, generation: generation)
  }

  func windowClosed(_ reason: PCMWindowCloseReason) {
    owner?.windowClosed(reason, token: token, generation: generation)
  }
}

private final class BridgeAcknowledgement: PCMAcknowledging, @unchecked Sendable {
  enum Acceptance {
    case accepted
    case alreadyAccepted
    case failed
  }

  enum DeliveryResult {
    case pending
    case accepted
    case failed
  }

  enum BeginDeliveryResult: Equatable {
    case started
    case accepted
    case failed
    case busy
  }

  private struct Finish {
    let result: PCMAcknowledgementResult
    let waiters: [CheckedContinuation<PCMAcknowledgementResult, Never>]
  }

  private let lock = NSLock()
  private let packet: IOSPCMBridgePacket
  private let onSettled: @Sendable (BridgeAcknowledgement, Bool) -> Void
  private var result: PCMAcknowledgementResult?
  private var waiters: [CheckedContinuation<PCMAcknowledgementResult, Never>] = []
  private var activeDeliveries = 0
  private var finalized = false

  init(
    packet: IOSPCMBridgePacket,
    onSettled: @escaping @Sendable (BridgeAcknowledgement, Bool) -> Void
  ) {
    self.packet = packet
    self.onSettled = onSettled
  }

  func beginDelivery() -> BeginDeliveryResult {
    lock.withLock {
      if let result {
        switch result {
        case .accepted: return .accepted
        case .failed: return .failed
        }
      }
      guard activeDeliveries == 0 else { return .busy }
      activeDeliveries += 1
      return .started
    }
  }

  func endDelivery() -> DeliveryResult {
    let state = lock.withLock { () -> (Finish?, DeliveryResult) in
      precondition(activeDeliveries > 0)
      activeDeliveries -= 1
      let deliveryResult: DeliveryResult
      switch result {
      case .accepted?: deliveryResult = .accepted
      case .failed?: deliveryResult = .failed
      case nil: deliveryResult = .pending
      }
      return (takeFinishIfReady(), deliveryResult)
    }
    finishNow(state.0)
    return state.1
  }

  func accept() -> Acceptance {
    switch settle(.accepted) {
    case .new: return .accepted
    case .existingAccepted: return .alreadyAccepted
    case .existingFailed: return .failed
    }
  }

  func cancel() { _ = settle(.failed) }

  func wait() async -> PCMAcknowledgementResult {
    if let result = lock.withLock({ finalized ? result : nil }) { return result }
    return await withCheckedContinuation { continuation in
      let immediate = lock.withLock { () -> PCMAcknowledgementResult? in
        if finalized, let result { return result }
        waiters.append(continuation)
        return nil
      }
      if let immediate { continuation.resume(returning: immediate) }
    }
  }

  private enum Settlement {
    case new
    case existingAccepted
    case existingFailed
  }

  private func settle(_ value: PCMAcknowledgementResult) -> Settlement {
    var settlement = Settlement.new
    let finish = lock.withLock { () -> Finish? in
      if let result {
        switch result {
        case .accepted: settlement = .existingAccepted
        case .failed: settlement = .existingFailed
        }
        return nil
      }
      result = value
      return takeFinishIfReady()
    }
    finishNow(finish)
    return settlement
  }

  private func takeFinishIfReady() -> Finish? {
    guard !finalized, activeDeliveries == 0, let result else { return nil }
    finalized = true
    defer { waiters.removeAll(keepingCapacity: false) }
    return Finish(result: result, waiters: waiters)
  }

  private func finishNow(_ finish: Finish?) {
    guard let finish else { return }
    packet.bytes.zeroize()
    let accepted: Bool
    switch finish.result {
    case .accepted: accepted = true
    case .failed: accepted = false
    }
    onSettled(self, accepted)
    for waiter in finish.waiters { waiter.resume(returning: finish.result) }
  }
}

private enum BridgeTransportFailure: Error {
  case operationFailed
}

/// Strong ownership records intentionally outlive abandoned JS/plugin handles.
/// Only verified native retirement releases them; process exit starts a new set.
private final class CaptureProcessOwnership: @unchecked Sendable {
  static let shared = CaptureProcessOwnership()
  private let lock = NSLock()
  private var owners: Set<UUID> = []

  var isIdle: Bool { lock.withLock { owners.isEmpty } }
  func claim() -> UUID {
    lock.withLock {
      let id = UUID()
      owners.insert(id)
      return id
    }
  }
  func release(_ id: UUID) { _ = lock.withLock { owners.remove(id) } }
}
