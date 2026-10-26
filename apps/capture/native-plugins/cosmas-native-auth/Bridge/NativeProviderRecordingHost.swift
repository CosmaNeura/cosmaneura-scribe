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
  var capturedAudioFrames: Int { get }
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
  enum Failure: String {
    case preparationFailed, startFailed, stopPending, recoveryFailed, captureInterrupted, recordingIncomplete
  }
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
  private let records: any Records
  private let flow: NativeRecordingFlowOwner
  private let service: any Service
  private let binding: NativeRecordingBindingOwner
  private let initialWindow: NativeRecordingWindowOwner?
  private let resumeWindow: NativeRecordingResumeWindowOwner?
  private let leases: NativeRecordingLeaseOwner
  private let reservations: NativeRecordingReservationOwner
  private let requireCurrent: @MainActor () throws -> Void
  private let recoverSources: @MainActor () async throws -> Void
  private let makeSource: SourceFactory
  private let makeRun: RunFactory
  private let now: @MainActor () -> Date
  private var cipher: NativeRecordingEncryption?
  private var source: (any NativeProviderMicrophoneSource)?
  private var run: (any NativeProviderRecordingInterval)?
  // The PCM sink counts only this interval. Retain its exact saved baseline
  // even after pause reconciliation, so progress can neither drop nor double.
  private(set) var capturePriorPlaintextBytes = 0
  private var capturePriorAudioFrames = 0
  private var warming: (id: UUID, task: Task<Void, Never>)?
  private var opening: Task<Void, Error>?
  private var starting: Task<Void, Error>?
  private var stopping: Task<Void, Error>?
  private var closingSource: Task<Bool, Error>?
  private var sealing: Task<Void, Error>?
  private var generation = UUID()
  private var retired = false
  private var changingInput = false
  private var inputChangeGeneration = UUID()
  private var interruptionObserved = false
  private let input = AppleMicrophoneInputPreference()
  private(set) var phase: Phase = .unopened
  private(set) var failure: Failure?
  private var sourceCheckpoint: UUID?
  private(set) var saved: NativeRecordingFlowSnapshot?

  init(
    scope: NativeRecordingScope, recoveryScope: UUID, service: any Service,
    records: any Records, keys: any NativeRecordingKeyStorage = KeychainNativeRecordingStorage(),
    requireCurrent: @escaping @MainActor () throws -> Void,
    recoverSources: @escaping @MainActor () async throws -> Void,
    makeSource: @escaping SourceFactory, makeRun: @escaping RunFactory,
    now: @escaping @MainActor () -> Date = { Date() }
  ) {
    self.scope = scope
    self.service = service
    self.records = records
    self.recoveryScope = recoveryScope
    self.requireCurrent = requireCurrent
    self.recoverSources = recoverSources
    self.makeSource = makeSource
    self.makeRun = makeRun
    self.now = now
    #if os(iOS)
      if let selected = AppleMicrophoneCheck.shared.selectedPreference {
        input.select(selected.0, uid: selected.1)
      }
    #endif
    flow = NativeRecordingFlowOwner(
      scope: scope, recoveryScope: recoveryScope, service: service, records: records)
    if let aggregate = service as? any NativeRecordingWindowService {
      let window = NativeRecordingWindowOwner(
        scope: scope, recoveryScope: recoveryScope, service: aggregate, records: records)
      initialWindow = window
      binding = NativeRecordingBindingOwner(
        scope: scope, service: window, records: records, keys: keys)
    } else {
      initialWindow = nil
      binding = NativeRecordingBindingOwner(
        scope: scope, service: service, records: records, keys: keys)
    }
    if let aggregate = service as? any NativeRecordingResumeWindowService {
      resumeWindow = NativeRecordingResumeWindowOwner(
        scope: scope, recoveryScope: recoveryScope,
        service: aggregate, records: records)
    } else {
      resumeWindow = nil
    }
    leases = NativeRecordingLeaseOwner(scope: scope, service: service, records: records)
    reservations = NativeRecordingReservationOwner(
      scope: scope, recoveryScope: recoveryScope, service: service, records: records)
  }

  /// Opens authorized key custody, then prepares lease/reservation metadata
  /// without delaying the screen. Microphone permission and source admission
  /// remain exclusively in the deliberate start path.
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
        let freshFlow = try await flow.takeFreshInitialWindowProof()
        try await initialWindow?.initialize(freshFlow: freshFlow)
        cipher = try await binding.open()
        try current(ticket)
        try await initialWindow?.adopt(leases: leases, reservations: reservations)
        try current(ticket)
        // A booted native host passed stop-only recovery before inspecting audio.
        saved = try await flow.reconcileAfterStop(encryption: cipher!)
        try current(ticket)
        if saved?.phase == .incomplete {
          phase = .failed
          failure = .recordingIncomplete
          return
        }
        phase = saved!.committedChunks == 0 ? .ready : .paused
        warmRecordingWindow()
      } catch {
        await service.abandonFreshInitialWindow()
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

  func start(allowInputChange: Bool = false) async throws {
    if let starting { return try await starting.value }
    guard [.ready, .paused].contains(phase), opening == nil, stopping == nil, sealing == nil,
      !retired, let cipher, let saved, saved.phase == .open,
      (!changingInput || allowInputChange),
      saved.committedChunks < 2048,
      saved.committedPlaintextBytes < NativeRecordingFlowOwner.maximumPlaintextBytes
    else { throw ProviderNativeError.unavailable }
    try current(generation)
    let recoverSavedPosition = failure == .recoveryFailed
    PCMStartupDiagnostics.shared.record(.startRequested)
    phase = .starting
    failure = nil
    interruptionObserved = false
    let ticket = generation
    let task = Task { @MainActor [self] in
      do {
        var checkpoint = saved
        if recoverSavedPosition {
          do {
            // Stop may have committed audio before sealing failed. Reconcile
            // that retained audio before choosing the next source position.
            checkpoint = try await flow.reconcileAfterStop(encryption: cipher)
            try current(ticket)
            self.saved = checkpoint
          } catch {
            if phase == .starting {
              phase = .paused
              failure = .recoveryFailed
            }
            throw error
          }
          // A lost seal response may already have frozen completion. Recover
          // upload instead of starting another interval with the old snapshot.
          if checkpoint.phase == .sealed {
            phase = .sealed
            throw ProviderNativeError.unavailable
          }
        }
        guard checkpoint.committedChunks < 2048,
          checkpoint.committedPlaintextBytes < NativeRecordingFlowOwner.maximumPlaintextBytes
        else { throw ProviderNativeError.unavailable }
        // Join preparation already in flight, then revalidate the durable
        // receipts. Failed prewarming is retried only by this deliberate Start.
        if let warming { try await NativeProviderPreparationWait().wait(for: warming.task) }
        try current(ticket)
        let (lease, batch) = try await prepareRecordingWindow(
          checkpoint: checkpoint, ticket: ticket, reportStartup: true)
        let checkpointID = UUID()
        self.saved = try await flow.beginSource(checkpoint: checkpointID)
        sourceCheckpoint = checkpointID
        try current(ticket)
        // Retain the original source proof even if graph construction fails.
        // No discarded constructor error may orphan stop-only custody.
        source = try makeSource(lease, batch)
        run = nil
        let next = try makeRun(
          source!, cipher, checkpoint.committedPlaintextBytes, lease, batch, leases, reservations,
          input)
        capturePriorPlaintextBytes = checkpoint.committedPlaintextBytes
        capturePriorAudioFrames = max(0, checkpoint.committedPlaintextBytes - checkpoint.committedChunks * 44) / 2
        run = next
        try await next.start()
        try current(ticket)
        guard next.phase == .recording else { throw ProviderNativeError.unavailable }
        phase = .recording
      } catch {
        if phase == .starting {
          failure = .startFailed
          do {
            let reconciled = try await stopSource()
            try current(ticket)
            if !reconciled {
              self.saved = try await flow.reconcileAfterStop(encryption: cipher)
              try current(ticket)
            }
            phase = self.saved?.phase == .incomplete ? .failed : .paused
            if self.saved?.phase == .incomplete { failure = .recordingIncomplete }
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
    inputChangeGeneration = UUID() // A deliberate Pause cancels an input restart.
    if let sealing { return try await sealing.value }
    guard [.ready, .starting, .recording, .pausing, .paused, .stopPending, .sealed].contains(phase)
    else { throw ProviderNativeError.unavailable }
    try await stop(reconcile: true)
    warmRecordingWindow()
  }

  /// Stop and freeze completion before allowing the existing ciphertext uploader.
  /// A fresh Stop-and-upload performs one authenticated scan, not pause + scan.
  func sealForUpload() async throws {
    inputChangeGeneration = UUID()
    if let sealing { return try await sealing.value }
    let alreadySealed = phase == .sealed
    guard !retired, saved?.phase != .incomplete || sourceCheckpoint != nil,
      alreadySealed || [.ready, .starting, .recording, .pausing, .paused, .stopPending].contains(phase)
    else {
      throw ProviderNativeError.unavailable
    }
    let task = Task { @MainActor [self] in
      if alreadySealed { try await retainPassageAudio(); return }
      try await stop(reconcile: false)
      phase = .sealing
      do {
        if let warming { await warming.task.value }
        try current(generation)
        guard let cipher else { throw ProviderNativeError.unavailable }
        let lease = try await leases.open()
        try current(generation)
        saved = try await flow.sealForUpload(encryption: cipher, lease: lease)
        try current(generation)
        try await retainPassageAudio()
        phase = .sealed
        #if os(iOS)
          ScribeRecordingActivity.end()
        #endif
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

  private func retainPassageAudio() async throws {
    let ticket = generation
    try current(ticket)
    guard let saved, saved.phase == .sealed, source == nil,
      run.map({ $0.isPhysicallyIdle && $0.phase == .stopped }) ?? true else {
      throw ProviderNativeError.unavailable
    }
    if cipher == nil { cipher = try await binding.reopenBound() }
    try current(ticket)
    guard let cipher else { throw ProviderNativeError.unavailable }
    let recovery = recoveryScope, records = records, chunks = saved.committedChunks
    try await nativePassageWork {
      try NativeRecordingPassageArchive.retain(encryption: cipher, recovery: recovery,
        chunks: chunks, records: records, current: { try Task.checkCancellation() })
    }
    try current(ticket)
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
  var capturedAudioFrames: Int {
    let retained = max(0, (saved?.committedPlaintextBytes ?? 0) - (saved?.committedChunks ?? 0) * 44) / 2
    // The saved checkpoint may already include this run after reconciliation.
    // Add its accepted frames only to the baseline taken before that run.
    return max(retained, run.map { capturePriorAudioFrames + $0.capturedAudioFrames } ?? 0)
  }
  var busy: Bool { changingInput || opening != nil || starting != nil || stopping != nil || sealing != nil }
  var requiresReopen: Bool { retired }
  var microphoneInput: AppleMicrophoneInput { input.selected }

  func selectMicrophoneInput(_ value: AppleMicrophoneInput, uid: String? = nil) async throws {
    try current(generation)
    // Older Start callers supply a category default. Preserve a real named
    // preflight choice; the current UI changes it through an exact native UID.
    if uid == nil, input.selectedUID != nil { return }
    guard [.ready, .paused, .recording].contains(phase), !busy
    else {
      throw ProviderNativeError.unavailable
    }
    #if os(iOS)
      if let uid {
        let selected = try AppleMicrophoneCheck.selection(id: uid)
        guard selected.0 == value else { throw ProviderNativeError.invalidRequest }
      }
    #else
      guard uid == nil else { throw ProviderNativeError.invalidRequest }
    #endif
    let resume = phase == .recording
    let ticket = inputChangeGeneration
    changingInput = true
    defer { changingInput = false }
    if resume {
      // Close and durably reconcile the accepted tail before selecting a route.
      // A new native source interval uses the same key/session/sequence. The
      // visible pausing/starting phases disclose the real capture gap.
      try await stop(reconcile: true)
      try current(generation)
      guard ticket == inputChangeGeneration, phase == .paused else {
        throw ProviderNativeError.unavailable
      }
    }
    guard run == nil || run?.isPhysicallyIdle == true else { throw ProviderNativeError.unavailable }
    input.select(value, uid: uid)
    if resume { try await start(allowInputChange: true) }
  }

  var inputDevices: [[String: Any]] {
    #if os(iOS)
      AppleMicrophoneCheck.devices().map(\.object)
    #else
      []
    #endif
  }
  var selectedInputID: String? {
    #if os(iOS)
      AppleMicrophoneCheck.devices().first(where: \.current)?.id
    #else
      nil
    #endif
  }

  /// Account changes fence synchronously. Same-account foreground recovery may
  /// still close its original source; a fresh authorized host is needed to start.
  func retire() {
    inputChangeGeneration = UUID()
    retired = true
    generation = UUID()
    warming?.task.cancel()
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
    inputChangeGeneration = UUID()
    if phase == .closed { return }
    retired = true
    generation = UUID()
    warming?.task.cancel()
    opening?.cancel()
    starting?.cancel()
    sealing?.cancel()
    do { try await stop(reconcile: false) }
    catch is NativeRecordingFinalizationFailure {
      // An incomplete visit may close once physical/Core stop is proven. Its
      // durable checkpoint remains and will block admission/upload on reopening.
      guard run?.isPhysicallyIdle == true, run?.phase == .stopped else {
        throw ProviderNativeError.unavailable
      }
    }
    if let warming { await warming.task.value }
    if let opening { _ = try? await opening.value }
    if let starting { _ = try? await starting.value }
    if let sealing { _ = try? await sealing.value }
    guard source == nil || run?.phase == .stopped || run == nil else {
      throw ProviderNativeError.unavailable
    }
    phase = .closed
    #if os(iOS)
      ScribeRecordingActivity.end()
    #endif
    if Self.owner == id { Self.owner = nil }
  }

  /// One bounded attempt per successful open/pause. These existing owners
  /// persist their original intents before I/O; no permission, source proof or
  /// microphone graph is created. A failed attempt never schedules a retry.
  private func warmRecordingWindow() {
    guard !retired, [.ready, .paused].contains(phase), failure != .recoveryFailed,
      let checkpoint = saved, checkpoint.phase == .open,
      checkpoint.committedChunks < 2048,
      checkpoint.committedPlaintextBytes < NativeRecordingFlowOwner.maximumPlaintextBytes
    else { return }
    let previous = warming?.task
    let id = UUID()
    let ticket = generation
    let task = Task { @MainActor [self] in
      defer { if warming?.id == id { warming = nil } }
      // A cancelled request may still be settling. Never overlap the durable
      // owners with a replacement preparation or drop the original intent.
      if let previous { await previous.value }
      do {
        try current(ticket)
        _ = try await prepareRecordingWindow(
          checkpoint: checkpoint, ticket: ticket, reportStartup: false)
      } catch {
        // Deliberate Start uses the normal durable recovery path.
      }
    }
    warming = (id, task)
  }

  private func prepareRecordingWindow(
    checkpoint: NativeRecordingFlowSnapshot, ticket: UUID, reportStartup: Bool
  ) async throws -> (NativeRecordingLease, NativeRecordingReservationBatch) {
    // A retained aggregate may have adopted only its lease before termination.
    // Complete that exact recipe before the legacy owner can issue anything.
    var prepared = try await resumeWindow?.recover(
      first: checkpoint.committedChunks,
      leases: leases, reservations: reservations)
    try current(ticket)
    var lease = try await leases.open()
    try current(ticket)
    // Expired/near-expiry receipts remain useful for upload recovery but
    // cannot prepare a new interval. Renew under the same durable intent.
    if try Self.expires(lease) <= now().addingTimeInterval(60) {
      if let resumeWindow {
        prepared = try await resumeWindow.prepare(
          previous: lease, first: checkpoint.committedChunks,
          leases: leases, reservations: reservations)
        lease = prepared!.lease
      } else {
        lease = try await leases.renew()
      }
      try current(ticket)
    }
    guard try Self.expires(lease) > now().addingTimeInterval(15) else {
      throw ProviderNativeError.unavailable
    }
    if reportStartup { PCMStartupDiagnostics.shared.record(.leaseReady) }
    let retained: NativeRecordingReservationBatch?
    if let prepared, prepared.lease == lease {
      retained = prepared.batch
    } else {
      retained = try await reservations.reuseForStart(
        lease: lease, first: checkpoint.committedChunks)
    }
    try current(ticket)
    let batch: NativeRecordingReservationBatch
    if let retained {
      batch = retained
    } else {
      // Prepare five minutes initially. Native continuation replenishes the
      // window with two minutes remaining, up to ninety outstanding slots.
      batch = try await reservations.reserve(
        lease: lease, first: checkpoint.committedChunks,
        count: min(30, 2048 - checkpoint.committedChunks))
    }
    try current(ticket)
    if reportStartup { PCMStartupDiagnostics.shared.record(.reservationsReady) }
    return (lease, batch)
  }

  private func stop(reconcile: Bool) async throws {
    if let stopping { return try await stopping.value }
    if phase == .sealed { return }
    guard phase != .closed else { throw ProviderNativeError.unavailable }
    // Preserve an unsolicited native stop across stop-confirmation retries.
    // A deliberate Pause still starts from a recording run and is not a fault.
    if phase == .recording, let run, run.phase != .recording {
      interruptionObserved = true
    }
    generation = UUID()
    warming?.task.cancel()
    opening?.cancel()
    starting?.cancel()
    phase = .pausing
    let ticket = generation
    let task = Task { @MainActor [self] in
      do {
        let reconciled = try await stopSource()
        // Starting is already fenced. Late network/permission results cannot
        // open a source, but remain retained until they have actually settled.
        if reconcile, !reconciled, let cipher {
          try current(ticket)
          saved = try await flow.reconcileAfterStop(encryption: cipher)
          try current(ticket)
        }
        phase = .paused
        if failure == .stopPending || failure == .recoveryFailed { failure = nil }
        if failure == nil && interruptionObserved { failure = .captureInterrupted }
      } catch {
        phase = .stopPending
        failure = error is NativeRecordingFinalizationFailure ? .recordingIncomplete : .stopPending
        throw error
      }
    }
    stopping = task
    defer { stopping = nil }
    try await task.value
  }

  private func stopSource() async throws -> Bool {
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
      let reconciled = sourceCheckpoint != nil
      if let sourceCheckpoint {
        guard let cipher else { throw ProviderNativeError.unavailable }
        if let run {
          let capture = run.captureState
          guard capture.phase == .closed
            || capture.phase == .accepting && run.capturedAudioFrames == 0 else {
            throw NativeRecordingFinalizationFailure.storageFailed
          }
        }
        let chunks = run?.captureState.nextSequence ?? saved?.committedChunks ?? 0
        let bytes = run.map { capturePriorPlaintextBytes + $0.captureState.committedPlaintextBytes }
          ?? saved?.committedPlaintextBytes ?? 0
        saved = try await flow.finishSource(checkpoint: sourceCheckpoint, encryption: cipher,
          chunks: chunks, plaintextBytes: bytes)
        self.sourceCheckpoint = nil
      }
      // A confirmed source owner has deliberately destroyed its start proof.
      // Do not ask that closed owner to confirm again on Pause/Close/retry.
      source = nil
      return reconciled
    }
    closingSource = task
    defer { closingSource = nil }
    return try await task.value
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

/// Cancelling the visible Start must not wait for a non-cooperative network
/// callback. The host still retains `warming` and joins it before retry/close;
/// this waiter owns no preparation, receipt, source permission or stop proof.
@MainActor private final class NativeProviderPreparationWait {
  private var continuation: CheckedContinuation<Void, Error>?
  private var cancelled = false

  func wait(for preparation: Task<Void, Never>) async throws {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        self.continuation = continuation
        if cancelled || Task.isCancelled {
          finish(cancelled: true)
          return
        }
        Task { @MainActor in
          await preparation.value
          self.finish(cancelled: false)
        }
      }
    } onCancel: {
      Task { @MainActor in self.finish(cancelled: true) }
    }
  }

  private func finish(cancelled: Bool) {
    self.cancelled = self.cancelled || cancelled
    guard let continuation else { return }
    self.continuation = nil
    if self.cancelled {
      continuation.resume(throwing: CancellationError())
    } else {
      continuation.resume()
    }
  }
}
