import CosmaneuraIOSAVFoundationDriver
import CosmaneuraIOSPCMCore
import CosmaneuraNativeRecording
import CosmaneuraNativeRecordingPCM
import CosmasNativeAuth
import Foundation

/// Internal ports allow synthetic lifecycle checks without opening an OS source.
/// The production source is the existing Core owner with its original stop proof.
@MainActor protocol NativeProviderMicrophoneSource: AnyObject {
  var recordingPreparation: NativeSourcePreparation { get }
  func consumeForMicrophone() async throws -> NativeCapturePermit
  func requireActiveMicrophone(runID: String) throws
  func retireForAuthenticationChange()
  func confirmStopped() async throws
}
extension NativeSourceStartOwner: NativeProviderMicrophoneSource {}

@MainActor protocol NativeProviderEncryptedRecorder: AnyObject {
  var isPhysicallyIdle: Bool { get }
  var captureState: NativeRecordingPCMState { get }
  var capturedAudioFrames: Int { get }
  func start(
    runID: String, captureExpiresAtMilliseconds: Int64,
    lease: NativeRecordingLease, batch: NativeRecordingReservationBatch
  ) throws
  func ready() async throws
  func stop() async throws
  func snapshot() async -> NativeRecordingContinuationState?
  func captureSignal() -> PCMSignalMonitor.Snapshot
}
extension NativeEncryptedPCMRecorder: NativeProviderEncryptedRecorder {}

@MainActor private final class NativeProviderRunAuthority {
  let id = UUID()
  let source: any NativeProviderMicrophoneSource
  var runID: String?
  init(source: any NativeProviderMicrophoneSource) { self.source = source }

  func validate() throws {
    do {
      try NativeCaptureStartGate.requireActiveEncryptedOwner(id)
      guard let runID else { throw ProviderNativeError.authorityChanged }
      try source.requireActiveMicrophone(runID: runID)
    } catch { throw NativeRecordingBindingFailure.authorityChanged }
  }
}

/// One native source interval (including automatic lease renewals). The provider
/// host retains this object across renderer/background lifecycle. A resumed visit
/// creates another interval only after this one reaches stopped. Keys, positions
/// and completion intent remain owned by the host's durable recording journal.
@MainActor final class NativeProviderRecordingRun {
  enum Phase: String { case ready, starting, recording, stopping, stopPending, stopped }
  enum Failure: String { case startFailed, physicalStopPending, sourceStopPending }

  private let authority: NativeProviderRunAuthority
  private let recorder: any NativeProviderEncryptedRecorder
  private let lease: NativeRecordingLease
  private let batch: NativeRecordingReservationBatch
  private let requestPermission: @MainActor () async throws -> Bool
  private var installed = false
  private var starting: Task<Void, Error>?
  private var stopping: Task<Void, Error>?
  private var observing: Task<Void, Never>?
  private(set) var phase: Phase = .ready
  private(set) var failure: Failure?

  /// Factory receives only a native validation closure. No renderer can provide
  /// source authority, a key, PCM, queue positions or the recorder implementation.
  init(
    source: any NativeProviderMicrophoneSource,
    lease: NativeRecordingLease, batch: NativeRecordingReservationBatch,
    requestPermission: @escaping @MainActor () async throws -> Bool,
    makeRecorder: (@escaping @Sendable () async throws -> Void) throws
      -> any NativeProviderEncryptedRecorder
  ) throws {
    let prepared = source.recordingPreparation
    guard lease.sessionID == batch.sessionID, lease.expiresAt == batch.authorizedUntil,
      prepared.source == .ios, prepared.sessionID == lease.sessionID,
      prepared.leaseID == lease.leaseID, prepared.leaseReceiptID == lease.receiptID,
      prepared.leaseGeneration == lease.generation,
      prepared.captureAuthorizedUntil == lease.expiresAt,
      batch.reservations.first?.sequence == prepared.firstSequenceNumber
    else {
      throw NativeRecordingBindingFailure.receiptMismatch
    }
    let authority = NativeProviderRunAuthority(source: source)
    self.authority = authority
    self.lease = lease
    self.batch = batch
    self.requestPermission = requestPermission
    recorder = try makeRecorder { try await authority.validate() }
  }

  /// Concrete encrypted graph uses the existing Apple adapters and queue. This
  /// initializer opens no microphone and does not acquire a source permission.
  convenience init(
    source: NativeSourceStartOwner, encryption: NativeRecordingEncryption,
    recoveryScope: UUID, records: any NativeRecordingRecordStore,
    priorPlaintextBytes: Int, lease: NativeRecordingLease,
    batch: NativeRecordingReservationBatch, leases: NativeRecordingLeaseOwner,
    reservations: NativeRecordingReservationOwner,
    permission: any AppleMicrophonePermissionProviding,
    system: any AppleAudioSystem, foreground: any AppleApplicationForegroundProviding,
    signal: PCMSignalMonitor
  ) throws {
    guard encryption.scope.sessionID == lease.sessionID,
      encryption.scope.workspaceID == source.recordingPreparation.workspaceID
    else { throw NativeRecordingBindingFailure.receiptMismatch }
    try self.init(
      source: source, lease: lease, batch: batch,
      requestPermission: {
        if permission.currentPermission() == .granted { return true }
        return await permission.requestPermission() == .granted
      },
      makeRecorder: { validate in
        try NativeEncryptedPCMRecorder(
          encryption: encryption, recoveryScope: recoveryScope, records: records,
          firstSequence: source.recordingPreparation.firstSequenceNumber,
          priorPlaintextBytes: priorPlaintextBytes, leases: leases, reservations: reservations,
          permission: AVFoundationMicrophonePermissionAdapter(provider: permission),
          system: system, foreground: foreground, signal: signal, validateActiveSource: validate)
      })
  }

  var captureState: NativeRecordingPCMState { recorder.captureState }
  var capturedAudioFrames: Int { recorder.capturedAudioFrames }
  var isPhysicallyIdle: Bool { recorder.isPhysicallyIdle }
  func captureSignal() -> PCMSignalMonitor.Snapshot { recorder.captureSignal() }
  func continuationState() async -> NativeRecordingContinuationState? {
    await recorder.snapshot()
  }

  func start() async throws {
    if let starting { return try await starting.value }
    guard phase == .ready else { throw ProviderNativeError.unavailable }
    try NativeCaptureStartGate.installEncrypted(
      owner: authority.id, idle: { [self] in recorder.isPhysicallyIdle },
      authorize: { [authority] in try await authority.source.consumeForMicrophone() })
    installed = true
    phase = .starting
    let task = Task { @MainActor [self] in
      do {
        // Permission may display an OS prompt. Obtain it before asking Core for
        // the 15-second one-use start decision, and recheck after every await.
        guard try await requestPermission() else { throw ProviderNativeError.unavailable }
        try requireStarting()
        PCMStartupDiagnostics.shared.record(.permissionAccepted)
        PCMStartupDiagnostics.shared.record(.sourceReadyRequested)
        PCMStartupDiagnostics.shared.record(.sourceConsumeRequested)
        try await NativeCaptureStartGate.consume(
          owner: authority.id, consumer: .nativeEncryptedMicrophone
        ) { permit in
          try requireStarting()
          PCMStartupDiagnostics.shared.record(.sourceReadyReceived)
          PCMStartupDiagnostics.shared.record(.authorityAccepted)
          authority.runID = permit.runID
          try recorder.start(
            runID: permit.runID,
            captureExpiresAtMilliseconds: Int64(
              permit.captureExpiresAt.timeIntervalSince1970 * 1000),
            lease: lease, batch: batch)
        }
        try await recorder.ready()
        try requireStarting()
        try authority.validate()
        phase = .recording
        PCMStartupDiagnostics.shared.record(.readyAccepted)
        observeTerminalState()
      } catch {
        if failure == nil { failure = .startFailed }
        // A late permission/Core/readiness result cannot restart a stopped run.
        // The stop operation retains both the graph and original proof on failure.
        try? await stop()
        throw error
      }
    }
    starting = task
    defer { starting = nil }
    try await task.value
  }

  /// Idempotent physical close followed by the original Core stop. Callers must
  /// retain stopPending and offer retry; expiry alone is not cessation evidence.
  func stop() async throws {
    if let stopping { return try await stopping.value }
    if phase == .stopped { return }
    phase = .stopping
    if installed { NativeCaptureStartGate.retire(owner: authority.id) }
    authority.source.retireForAuthenticationChange()
    starting?.cancel()
    observing?.cancel()
    observing = nil
    let task = Task { @MainActor [self] in
      do {
        try await recorder.stop()
        guard recorder.isPhysicallyIdle else { throw ProviderNativeError.unavailable }
      } catch {
        failure = .physicalStopPending
        phase = .stopPending
        throw error
      }
      do {
        if installed {
          try NativeCaptureStartGate.confirmStopped(owner: authority.id)
          try await authority.source.confirmStopped()
          NativeCaptureStartGate.clear(owner: authority.id)
        } else {
          // An abandoned prepared run still has original stop custody, but has
          // never claimed audio. Boot/other sources share this same idle barrier.
          try await NativeCaptureStartGate.recoverWhileIdle {
            try await authority.source.confirmStopped()
          }
        }
        phase = .stopped
        if failure != .startFailed { failure = nil }
      } catch {
        failure = .sourceStopPending
        phase = .stopPending
        throw error
      }
    }
    stopping = task
    defer { stopping = nil }
    try await task.value
  }

  /// Synchronous fence before scheduling closure, used by native auth changes.
  /// UI disappearance/background alone must not invoke this operation.
  func retire() {
    if installed { NativeCaptureStartGate.retire(owner: authority.id) }
    authority.source.retireForAuthenticationChange()
    Task { @MainActor [self] in try? await stop() }
  }

  private func requireStarting() throws {
    try Task.checkCancellation()
    guard phase == .starting else { throw ProviderNativeError.unavailable }
  }

  private func observeTerminalState() {
    observing = Task { @MainActor [self] in
      while !Task.isCancelled && phase == .recording {
        if let state = await recorder.snapshot(), state.phase == .stopped || state.phase == .failed
        {
          try? await stop()
          return
        }
        do { try await Task.sleep(for: .seconds(1)) } catch { return }
      }
    }
  }
}
