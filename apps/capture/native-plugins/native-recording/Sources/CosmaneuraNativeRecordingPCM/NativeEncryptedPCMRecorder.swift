import CosmaneuraIOSAVFoundationDriver
import CosmaneuraIOSPCMCore
import CosmaneuraNativeRecording
import Foundation

/// Concrete native capture graph: AVFoundation -> PCM -> encrypted queue. No
/// audio, key or acknowledgement crosses the WebView. Construction opens no mic.
/// The authenticated host must retain this owner, acquire the shared source gate
/// before start, and keep its original stop proof until isPhysicallyIdle is true.
@MainActor public final class NativeEncryptedPCMRecorder {
  public static let maximumPlaintextBytes = 402_653_184
  public static let threeHourPlaintextBytes = 1_080 * (320_000 + 44)

  private let records: any NativeRecordingRecordStore
  private let firstSequence: Int
  private let priorPlaintextBytes: Int
  private let core: IOSPCMCore
  private let sink: NativeRecordingPCMSink
  private let leases: NativeRecordingLeaseOwner
  private let reservations: NativeRecordingReservationOwner
  private let sourceClock: any PCMSourceClock
  private let validateActiveSource: @Sendable () async throws -> Void
  private let signal: PCMSignalMonitor
  private var claimed = false
  private var handle: IOSPCMSessionHandle?
  private var continuation: NativeRecordingContinuation?
  private var readiness: Task<Void, Error>?
  private var physicalClosureConfirmed = true
  private var stopping: Task<Void, Error>?

  public init(
    encryption: NativeRecordingEncryption, recoveryScope: UUID,
    records: any NativeRecordingRecordStore,
    firstSequence: Int, priorPlaintextBytes: Int,
    leases: NativeRecordingLeaseOwner, reservations: NativeRecordingReservationOwner,
    permission: any MicrophonePermissionAuthorizing,
    system: any AppleAudioSystem, foreground: any AppleApplicationForegroundProviding,
    signal: PCMSignalMonitor,
    sourceClock: any PCMSourceClock = ContinuousPCMSourceClock(),
    validateActiveSource: @escaping @Sendable () async throws -> Void
  ) throws {
    self.records = records
    self.firstSequence = firstSequence
    self.priorPlaintextBytes = priorPlaintextBytes
    self.leases = leases
    self.reservations = reservations
    self.sourceClock = sourceClock
    self.validateActiveSource = validateActiveSource
    self.signal = signal
    sink = try NativeRecordingPCMSink(
      encryption: encryption, recoveryScope: recoveryScope, records: records,
      firstSequence: firstSequence, priorPlaintextBytes: priorPlaintextBytes,
      maximumPlaintextBytes: Self.maximumPlaintextBytes)
    core = IOSPCMCore(
      permission: permission,
      audio: AVFoundationPCMDriver(
        system: system, foreground: foreground, lifecycle: .nativeEncrypted),
      sink: sink, sourceClock: sourceClock, signalMonitor: signal)
    try requireCapacity()
  }

  /// Called synchronously inside the existing native gate's permit-consumption
  /// closure. The run ID/deadline come from its verified decision, not JS options.
  public func start(
    runID: String, captureExpiresAtMilliseconds: Int64,
    lease: NativeRecordingLease, batch: NativeRecordingReservationBatch
  ) throws {
    guard !claimed, handle == nil, stopping == nil else {
      throw NativeRecordingBindingFailure.operationInProgress
    }
    try requireCapacity()
    try sink.stage(batch)
    let authority = try PCMSourceAuthority(
      runID: runID, generation: 1, expiresAtMilliseconds: captureExpiresAtMilliseconds,
      hardMaximumChunks: 2_048 - firstSequence)
    let configuration = try PCMConfiguration(
      targetFramesPerChunk: 160_000, maximumChunks: batch.reservations.count,
      maximumInputFramesPerBuffer: PCMConfiguration.maximumFramesPerInputBuffer,
      authority: authority)
    claimed = true
    signal.reset()
    // Retain the handle before constructing continuation. Even a validation or
    // deadline failure after claim leaves physical closure explicitly retryable.
    let started = try core.start(configuration: configuration)
    handle = started
    physicalClosureConfirmed = false
    continuation = try NativeRecordingContinuation(
      session: started, sink: sink, leases: leases, reservations: reservations,
      initialLease: lease, initialAuthority: authority, initialBatch: batch,
      sourceClock: sourceClock, validateActiveSource: validateActiveSource)
  }

  public func ready() async throws {
    if let readiness { return try await readiness.value }
    guard let continuation else { throw NativeRecordingFailure.invalidBinding }
    let task = Task { try await continuation.startMaintenance() }
    readiness = task
    try await task.value
  }

  /// A ready recorder can be held by the native host across view teardown.
  /// Application/scene background events alone do not deactivate this owner.
  public func snapshot() async -> NativeRecordingContinuationState? { await continuation?.state }
  public func captureSignal() -> PCMSignalMonitor.Snapshot { signal.snapshot() }
  public var captureState: NativeRecordingPCMState { sink.state }
  public var isPhysicallyIdle: Bool { physicalClosureConfirmed }

  public func stop() async throws {
    if let stopping { return try await stopping.value }
    if physicalClosureConfirmed && claimed { return }
    claimed = true  // A stopped preparation cannot later become a new start.
    readiness?.cancel()
    let task = Task { [continuation, handle, sink] in
      if let continuation {
        try await continuation.stop()
      } else if let handle {
        let stopped = try await handle.stop(.drain)
        if sink.state.phase == .accepting || sink.state.phase == .draining {
          try sink.finish(stopped)
        } else {
          stopped.finalPacket?.bytes.zeroize()
        }
      }
    }
    stopping = task
    do {
      try await task.value
      physicalClosureConfirmed = true
      stopping = nil
    } catch {
      stopping = nil
      throw error
    }
  }

  /// Same conservative four-copy allowance and 64 MiB recovery reserve as the
  /// existing JS flow. The 384 MiB plaintext ceiling exceeds a three-hour visit.
  public static func requiredAvailableBytes(priorPlaintextBytes: Int) throws -> Int {
    guard (0..<maximumPlaintextBytes).contains(priorPlaintextBytes) else {
      throw NativeRecordingFailure.invalidBinding
    }
    return (maximumPlaintextBytes - priorPlaintextBytes) * 4 + 67_108_864
  }

  private func requireCapacity() throws {
    guard
      try records.availableBytes()
        >= Self.requiredAvailableBytes(
          priorPlaintextBytes: priorPlaintextBytes)
    else { throw NativeRecordingFailure.storageUnavailable }
  }
}
