import Foundation

public enum PCMErrorCode: String, Error, Sendable {
  case invalidConfiguration = "ios_pcm_invalid_configuration"
  case alreadyActive = "ios_pcm_already_active"
  case startupCancelled = "ios_pcm_startup_cancelled"
  case permissionDenied = "ios_microphone_permission_denied"
  case permissionRestricted = "ios_microphone_permission_restricted"
  case microphoneUnavailable = "ios_microphone_unavailable"
  case startFailed = "ios_capture_start_failed"
  case invalidPCM = "ios_pcm_invalid_input"
  case bufferOverflow = "ios_pcm_buffer_overflow"
  case outputLimitExceeded = "ios_pcm_output_limit_exceeded"
  case sinkFailed = "ios_pcm_sink_failed"
  case stopFailed = "ios_capture_stop_failed"
}

public struct PCMFailure: Error, Equatable, Sendable {
  public let code: PCMErrorCode

  public init(_ code: PCMErrorCode) {
    self.code = code
  }
}

public enum PCMTerminationCode: String, Sendable {
  case interruption = "ios_audio_session_interrupted"
  case routeChanged = "ios_audio_route_changed"
  case backgrounded = "ios_capture_backgrounded"
  case heartbeatExpired = "ios_capture_stalled"
  case permissionRevoked = "ios_microphone_permission_revoked"
  case captureFailed = "ios_capture_failed"
  case invalidPCM = "ios_pcm_invalid_input"
  case bufferOverflow = "ios_pcm_buffer_overflow"
  case outputLimitExceeded = "ios_pcm_output_limit_exceeded"
  case sinkFailed = "ios_pcm_sink_failed"
}

public enum PCMAudioEvent: Sendable {
  case interruption
  case routeChanged
  case backgrounded
  case permissionRevoked
  case captureFailed
}

public enum MicrophonePermission: Sendable {
  case granted
  case denied
  case restricted
  case unavailable
}

public enum PCMStopMode: Equatable, Sendable {
  case drain
  case discard
}

public struct PCMConfiguration: Equatable, Sendable {
  public static let encoding = "pcm_s16le"
  public static let channels = 1
  public static let sampleRateHz = 16_000
  public static let maximumTargetFramesPerChunk = 960_000
  public static let maximumChunksPerSession = 8_640
  public static let maximumFramesPerInputBuffer = 32_768

  public let targetFramesPerChunk: Int
  public let maximumChunks: Int
  public let maximumInputFramesPerBuffer: Int
  public let heartbeatTimeoutNanoseconds: UInt64
  public let authority: PCMSourceAuthority?

  public init(
    targetFramesPerChunk: Int,
    maximumChunks: Int,
    maximumInputFramesPerBuffer: Int = 4_096,
    heartbeatTimeoutNanoseconds: UInt64 = 15_000_000_000,
    authority: PCMSourceAuthority? = nil
  ) throws {
    guard targetFramesPerChunk > 0,
      targetFramesPerChunk <= Self.maximumTargetFramesPerChunk,
      maximumChunks > 0,
      maximumChunks <= Self.maximumChunksPerSession,
      maximumInputFramesPerBuffer > 0,
      maximumInputFramesPerBuffer <= Self.maximumFramesPerInputBuffer,
      maximumInputFramesPerBuffer <= targetFramesPerChunk,
      heartbeatTimeoutNanoseconds > 0,
      targetFramesPerChunk <= Int.max / 2,
      maximumChunks <= Int.max / targetFramesPerChunk,
      authority == nil || maximumChunks <= authority!.hardMaximumChunks
    else {
      throw PCMFailure(.invalidConfiguration)
    }
    self.targetFramesPerChunk = targetFramesPerChunk
    self.maximumChunks = maximumChunks
    self.maximumInputFramesPerBuffer = maximumInputFramesPerBuffer
    self.heartbeatTimeoutNanoseconds = heartbeatTimeoutNanoseconds
    self.authority = authority
  }
}

/// A driver transfers one mutable input buffer to the core. The core clears it
/// on every path, including stale callbacks and validation failures.
public final class OwnedAudioFrames: @unchecked Sendable {
  public let sampleRateHz: Int
  private let lock = NSLock()
  private var channels: [[Float]]
  private var cleared = false

  public init(sampleRateHz: Int, channels: [[Float]]) {
    self.sampleRateHz = sampleRateHz
    self.channels = channels
  }

  deinit { zeroize() }

  func consume<Result>(_ body: (inout [[Float]]) throws -> Result) rethrows -> Result {
    lock.lock()
    defer {
      for channel in channels.indices {
        for frame in channels[channel].indices {
          channels[channel][frame] = 0
        }
      }
      cleared = true
      lock.unlock()
    }
    return try body(&channels)
  }

  public func zeroize() {
    lock.withLock {
      for channel in channels.indices {
        for frame in channels[channel].indices {
          channels[channel][frame] = 0
        }
      }
      cleared = true
    }
  }

  public var isZeroed: Bool {
    lock.withLock { cleared && channels.allSatisfy { $0.allSatisfy { $0 == 0 } } }
  }
}

/// Application-owned PCM bytes. A synchronous sink may inspect/copy them only
/// during `emit`; the core clears a full packet immediately after `emit`
/// returns. A drained partial transfers to the caller, which must clear it.
public final class OwnedPCMBytes: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [UInt8]

  init(_ storage: [UInt8]) {
    self.storage = storage
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

  public var isZeroed: Bool { lock.withLock { storage.allSatisfy { $0 == 0 } } }

  func testingCopy() -> [UInt8] { lock.withLock { storage } }
}

public struct PCMEncodedPacket: Sendable {
  public let sequenceNumber: UInt64
  public let bytes: OwnedPCMBytes
}

public struct PCMStopResult: Sendable {
  public let finalPacket: PCMEncodedPacket?
}

public enum PCMAcknowledgementResult: Sendable {
  case accepted
  case failed
}

public protocol PCMAcknowledging: Sendable {
  /// Must settle after `cancel`; a future bridge must not leave shutdown
  /// waiting on a vanished WebView.
  func wait() async -> PCMAcknowledgementResult
  func cancel()
}

public protocol PCMEmissionSink: Sendable {
  /// This call is synchronous. Implementations may copy bytes for transport
  /// but must not retain or read `packet.bytes` after returning.
  func emit(_ packet: PCMEncodedPacket) throws -> any PCMAcknowledging
  func terminated(_ code: PCMTerminationCode)
  /// Input is frozen and accepted full packets have settled. Explicit stop
  /// drains the retained partial exactly once; this callback owns no PCM bytes.
  func windowClosed(_ reason: PCMWindowCloseReason)
}

extension PCMEmissionSink {
  public func windowClosed(_ reason: PCMWindowCloseReason) {}
}

public final class StartupCancellation: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  public init() {}

  public var isCancelled: Bool { lock.withLock { cancelled } }

  public func cancel() {
    let pending: [CheckedContinuation<Void, Never>] = lock.withLock {
      guard !cancelled else { return [] }
      cancelled = true
      defer { waiters.removeAll(keepingCapacity: false) }
      return waiters
    }
    for waiter in pending { waiter.resume() }
  }

  public func waitUntilCancelled() async {
    if isCancelled { return }
    await withCheckedContinuation { continuation in
      let resumeNow = lock.withLock {
        if cancelled { return true }
        waiters.append(continuation)
        return false
      }
      if resumeNow { continuation.resume() }
    }
  }
}

public protocol MicrophonePermissionAuthorizing: Sendable {
  /// Must stop permission-side work when the token cancels; core readiness also
  /// races this token so a late/non-returning provider cannot hold the caller.
  func requestPermission(cancellation: StartupCancellation) async -> MicrophonePermission
}

public struct PCMAudioCallbacks: Sendable {
  public let frames: @Sendable (OwnedAudioFrames) -> PCMFrameAdmission
  public let event: @Sendable (PCMAudioEvent) async -> Void

  public init(
    frames: @escaping @Sendable (OwnedAudioFrames) -> PCMFrameAdmission,
    event: @escaping @Sendable (PCMAudioEvent) async -> Void
  ) {
    self.frames = frames
    self.event = event
  }
}

/// Synchronous admission prevents a driver from queuing transferred audio
/// outside the state actor. A driver must await an accepted receipt before it
/// offers another buffer; rejection has already cleared the offered buffer.
public struct PCMFrameAdmission: Sendable {
  public let accepted: Bool
  private let receipt: PCMFrameReceipt?

  init(
    accepted: Bool,
    completion: Task<Void, Never>? = nil,
    release: (@Sendable () -> Void)? = nil
  ) {
    self.accepted = accepted
    receipt = completion.map { PCMFrameReceipt(completion: $0, release: release) }
  }

  public func waitUntilConsumed() async {
    await receipt?.waitUntilConsumed()
  }
}

private final class PCMFrameReceipt: @unchecked Sendable {
  private let completion: Task<Void, Never>
  private let release: (@Sendable () -> Void)?
  private let lock = NSLock()
  private var released = false

  init(completion: Task<Void, Never>, release: (@Sendable () -> Void)?) {
    self.completion = completion
    self.release = release
  }

  func waitUntilConsumed() async {
    await completion.value
    let shouldRelease = lock.withLock {
      guard !released else { return false }
      released = true
      return true
    }
    if shouldRelease { release?() }
  }
}

public protocol PCMAudioDriving: Sendable {
  /// Must honor cancellation. `freezeInput` invalidates a pending start and
  /// returns only when no new callback can begin for this session. The driver
  /// must await every accepted frame receipt before offering another buffer.
  func start(
    sessionID: UInt64,
    callbacks: PCMAudioCallbacks,
    cancellation: StartupCancellation
  ) async throws
  func freezeInput(sessionID: UInt64) async throws
  func release(sessionID: UInt64) async throws
}

public protocol PCMClock: Sendable {
  func sleep(nanoseconds: UInt64) async throws
}

public struct ContinuousPCMClock: PCMClock {
  public init() {}

  public func sleep(nanoseconds: UInt64) async throws {
    try await Task.sleep(nanoseconds: nanoseconds)
  }
}
