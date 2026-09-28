import CosmaneuraIOSAVFoundationDriver
import CosmaneuraIOSPCMCore
import CosmaneuraNativeRecording
import CosmaneuraNativeRecordingPCM
import CosmasNativeAuth
import Foundation

@MainActor protocol NativeProviderRecordingInterval: AnyObject {
  var phase: NativeProviderRecordingRun.Phase { get }
  var isPhysicallyIdle: Bool { get }
  var captureState: NativeRecordingPCMState { get }
  func captureSignal() -> PCMSignalMonitor.Snapshot
  func start() async throws
  func stop() async throws
  func retire()
}
extension NativeProviderRecordingRun: NativeProviderRecordingInterval {}

/// One retained provider visit. Renderer/background lifecycle does not own this
/// object. The bridge retains it until close confirms source cessation; only
/// metadata snapshots cross that bridge. No method automatically resumes audio.
@MainActor final class NativeProviderRecordingHost {
  enum Phase: String {
    case unopened, opening, ready, starting, recording, pausing, paused, stopPending, sealing,
      sealed, failed, closed
  }
  enum Failure: String { case preparationFailed, startFailed, stopPending, recoveryFailed }
  typealias Service = NativeRecordingBindingService & NativeRecordingLeaseService
    & NativeRecordingReservationService
  typealias Records = NativeRecordingFlowStore & NativeRecordingLeaseRecordStore
  typealias SourceFactory =
    @MainActor (NativeRecordingLease, NativeRecordingReservationBatch)
    throws -> any NativeProviderMicrophoneSource
  typealias RunFactory =
    @MainActor (
      any NativeProviderMicrophoneSource, NativeRecordingEncryption, Int,
      NativeRecordingLease, NativeRecordingReservationBatch,
      NativeRecordingLeaseOwner, NativeRecordingReservationOwner, AppleMicrophoneInputPreference
    ) throws -> any NativeProviderRecordingInterval

  // Serializes native hosts even before a source grant exists. The provider UI
  // also retains its existing legacy flow lock before selecting either backend.
  private static var owner: UUID?
  private let id = UUID()
  let scope: NativeRecordingScope
  let recoveryScope: UUID
  private let flow: NativeRecordingFlowOwner
  private let binding: NativeRecordingBindingOwner
  private let leases: NativeRecordingLeaseOwner
  private let reservations: NativeRecordingReservationOwner
  private let requireCurrent: @MainActor () throws -> Void
  private let recoverSources: @MainActor () async throws -> Void
  private let makeSource: SourceFactory
  private let makeRun: RunFactory
  private var cipher: NativeRecordingEncryption?
  private var source: (any NativeProviderMicrophoneSource)?
  private var run: (any NativeProviderRecordingInterval)?
  // The PCM sink counts only this interval. Retain its exact saved baseline
  // even after pause reconciliation, so progress can neither drop nor double.
  private(set) var capturePriorPlaintextBytes = 0
  private var opening: Task<Void, Error>?
  private var starting: Task<Void, Error>?
  private var stopping: Task<Void, Error>?
  private var closingSource: Task<Void, Error>?
  private var sealing: Task<Void, Error>?
  private var generation = UUID()
  private var retired = false
  private let input = AppleMicrophoneInputPreference()
  private(set) var phase: Phase = .unopened
  private(set) var failure: Failure?
  private(set) var saved: NativeRecordingFlowSnapshot?

  init(
    scope: NativeRecordingScope, recoveryScope: UUID, service: any Service,
    records: any Records, keys: any NativeRecordingKeyStorage = KeychainNativeRecordingStorage(),
    requireCurrent: @escaping @MainActor () throws -> Void,
    recoverSources: @escaping @MainActor () async throws -> Void,
    makeSource: @escaping SourceFactory, makeRun: @escaping RunFactory
  ) {
    self.scope = scope
    self.recoveryScope = recoveryScope
    self.requireCurrent = requireCurrent
    self.recoverSources = recoverSources
    self.makeSource = makeSource
    self.makeRun = makeRun
    flow = NativeRecordingFlowOwner(
      scope: scope, recoveryScope: recoveryScope, service: service, records: records)
    binding = NativeRecordingBindingOwner(
      scope: scope, service: service, records: records, keys: keys)
    leases = NativeRecordingLeaseOwner(scope: scope, service: service, records: records)
    reservations = NativeRecordingReservationOwner(
      scope: scope, recoveryScope: recoveryScope, service: service, records: records)
  }

  /// Does not request microphone permission or acquire a capture lease. Opening
  /// preloads existing key custody, so pressing Record need not repeat key work.
  func open() async throws {
    guard !retired else { throw ProviderNativeError.unavailable }
    if let opening { return try await opening.value }
    guard phase == .unopened || phase == .failed, source == nil, !retired else {
      if [.ready, .paused, .recording, .sealed].contains(phase) {
        try requireCurrent()
        return
      }
      throw ProviderNativeError.unavailable
    }
    try requireCurrent()
    guard Self.owner == nil || Self.owner == id else { throw ProviderNativeError.unavailable }
    Self.owner = id
    phase = .opening
    failure = nil
    let ticket = generation
    let task = Task { @MainActor [self] in
      do {
        try await recoverSources()
        try current(ticket)
        saved = try await flow.open()
        try current(ticket)
        if saved?.phase == .sealed {
          phase = .sealed
          return
        }
        cipher = try await binding.open()
        try current(ticket)
        // A booted native host passed stop-only recovery before inspecting audio.
        saved = try await flow.reconcileAfterStop(encryption: cipher!)
        try current(ticket)
        phase = saved!.committedChunks == 0 ? .ready : .paused
      } catch {
        if phase == .opening {
          phase = .failed
          failure = .preparationFailed
        }
        throw error
      }
    }
    opening = task
    defer { opening = nil }
    try await task.value
  }

  func start() async throws {
    if let starting { return try await starting.value }
    guard [.ready, .paused].contains(phase), opening == nil, stopping == nil, sealing == nil,
      !retired, let cipher, let saved, saved.phase == .open,
      saved.committedChunks < 2048,
      saved.committedPlaintextBytes < NativeRecordingFlowOwner.maximumPlaintextBytes
    else { throw ProviderNativeError.unavailable }
    try current(generation)
    phase = .starting
    failure = nil
    let ticket = generation
    let task = Task { @MainActor [self] in
      do {
        var lease = try await leases.open()
        try current(ticket)
        // Expired/near-expiry receipts remain useful for upload recovery but
        // cannot prepare a new interval. Renew under the same durable intent.
        if try Self.expires(lease) <= Date().addingTimeInterval(60) {
          lease = try await leases.renew()
          try current(ticket)
        }
        guard try Self.expires(lease) > Date().addingTimeInterval(15) else {
          throw ProviderNativeError.unavailable
        }
        let batch = try await reservations.reserve(
          lease: lease, first: saved.committedChunks, count: min(90, 2048 - saved.committedChunks))
        try current(ticket)
        // Retain the original source proof even if graph construction fails.
        // No discarded constructor error may orphan stop-only custody.
        source = try makeSource(lease, batch)
        run = nil
        let next = try makeRun(
          source!, cipher, saved.committedPlaintextBytes, lease, batch, leases, reservations, input)
        capturePriorPlaintextBytes = saved.committedPlaintextBytes
        run = next
        try await next.start()
        try current(ticket)
        guard next.phase == .recording else { throw ProviderNativeError.unavailable }
        phase = .recording
      } catch {
        if phase == .starting {
          failure = .startFailed
          do {
            try await stopSource()
            try current(ticket)
            self.saved = try await flow.reconcileAfterStop(encryption: cipher)
            try current(ticket)
            phase = .paused
          } catch {
            phase = .stopPending
            failure = .stopPending
          }
        }
        throw error
      }
    }
    starting = task
    defer { starting = nil }
    try await task.value
  }

  func pause() async throws {
    if let sealing { return try await sealing.value }
    guard [.ready, .starting, .recording, .pausing, .paused, .stopPending, .sealed].contains(phase)
    else { throw ProviderNativeError.unavailable }
    try await stop(reconcile: true)
  }

  /// Stop and freeze completion before allowing the existing ciphertext uploader.
  /// A fresh Stop-and-upload performs one authenticated scan, not pause + scan.
  func sealForUpload() async throws {
    if let sealing { return try await sealing.value }
    if phase == .sealed {
      try requireCurrent()
      return
    }
    guard !retired,
      [.ready, .starting, .recording, .pausing, .paused, .stopPending].contains(phase)
    else {
      throw ProviderNativeError.unavailable
    }
    let task = Task { @MainActor [self] in
      try await stop(reconcile: false)
      try current(generation)
      guard let cipher else { throw ProviderNativeError.unavailable }
      phase = .sealing
      do {
        let lease = try await leases.open()
        try current(generation)
        saved = try await flow.sealForUpload(encryption: cipher, lease: lease)
        try current(generation)
        phase = .sealed
        failure = nil
      } catch {
        if phase == .sealing {
          phase = .paused
          failure = .recoveryFailed
        }
        throw error
      }
    }
    sealing = task
    defer { sealing = nil }
    try await task.value
  }

  /// Refresh is metadata only. Terminal native interruption states become an
  /// explicit retry/pause state; opening a screen never resumes the microphone.
  func refresh() async throws {
    try requireCurrent()
    if phase == .recording, let run, run.phase != .recording {
      try await pause()
    }
  }

  var signal: PCMSignalMonitor.Snapshot? { run?.captureSignal() }
  var captureState: NativeRecordingPCMState? { run?.captureState }
  var busy: Bool { opening != nil || starting != nil || stopping != nil || sealing != nil }
  var requiresReopen: Bool { retired }
  var microphoneInput: AppleMicrophoneInput { input.selected }

  func selectMicrophoneInput(_ value: AppleMicrophoneInput) throws {
    try current(generation)
    guard [.ready, .paused].contains(phase), !busy, run == nil || run?.isPhysicallyIdle == true
    else {
      throw ProviderNativeError.unavailable
    }
    input.select(value)
  }

  /// Account changes fence synchronously. Same-account foreground recovery may
  /// still close its original source; a fresh authorized host is needed to start.
  func retire() {
    retired = true
    generation = UUID()
    opening?.cancel()
    starting?.cancel()
    sealing?.cancel()
    source?.retireForAuthenticationChange()
    run?.retire()
    Task { @MainActor [self] in try? await stop(reconcile: false) }
  }

  /// No key/queue deletion. Await outstanding cancelled preparation before
  /// releasing native ownership, so late work cannot race the next host.
  func close() async throws {
    if phase == .closed { return }
    retired = true
    generation = UUID()
    opening?.cancel()
    starting?.cancel()
    sealing?.cancel()
    try await stop(reconcile: false)
    if let opening { _ = try? await opening.value }
    if let starting { _ = try? await starting.value }
    if let sealing { _ = try? await sealing.value }
    guard source == nil || run?.phase == .stopped || run == nil else {
      throw ProviderNativeError.unavailable
    }
    phase = .closed
    if Self.owner == id { Self.owner = nil }
  }

  private func stop(reconcile: Bool) async throws {
    if let stopping { return try await stopping.value }
    if phase == .sealed { return }
    guard phase != .closed else { throw ProviderNativeError.unavailable }
    generation = UUID()
    opening?.cancel()
    starting?.cancel()
    phase = .pausing
    let ticket = generation
    let task = Task { @MainActor [self] in
      do {
        try await stopSource()
        // Starting is already fenced. Late network/permission results cannot
        // open a source, but remain retained until they have actually settled.
        if reconcile, let cipher {
          try current(ticket)
          saved = try await flow.reconcileAfterStop(encryption: cipher)
          try current(ticket)
        }
        phase = .paused
        if failure == .stopPending || failure == .recoveryFailed { failure = nil }
      } catch {
        phase = .stopPending
        failure = .stopPending
        throw error
      }
    }
    stopping = task
    defer { stopping = nil }
    try await task.value
  }

  private func stopSource() async throws {
    if let closingSource { return try await closingSource.value }
    let task = Task { @MainActor [self] in
      if let run {
        try await run.stop()
        guard run.isPhysicallyIdle, run.phase == .stopped else {
          throw ProviderNativeError.unavailable
        }
      } else if let source {
        source.retireForAuthenticationChange()
        try await NativeCaptureStartGate.recoverWhileIdle { try await source.confirmStopped() }
      }
      // A confirmed source owner has deliberately destroyed its start proof.
      // Do not ask that closed owner to confirm again on Pause/Close/retry.
      source = nil
    }
    closingSource = task
    defer { closingSource = nil }
    try await task.value
  }

  private func current(_ ticket: UUID) throws {
    try Task.checkCancellation()
    guard !retired, Self.owner == id, generation == ticket else {
      throw ProviderNativeError.unavailable
    }
    try requireCurrent()
  }
  private static func expires(_ lease: NativeRecordingLease) throws -> Date {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = parser.date(from: lease.expiresAt) { return date }
    parser.formatOptions = [.withInternetDateTime]
    guard let date = parser.date(from: lease.expiresAt) else { throw ProviderNativeError.response }
    return date
  }
}
