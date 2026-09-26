import CosmaneuraIOSPCMCore
import CosmaneuraNativeRecording
import Foundation

public struct NativeRecordingContinuationState: Equatable, Sendable {
  public enum Phase: Sendable { case ready, recording, renewalDelayed, stopping, stopped, failed }
  public enum Reason: Sendable {
    case authorityExpired, sourceRetired, renewalRejected, captureFailed, storageFailed
    case closureUnconfirmed
  }
  public let phase: Phase
  public let reason: Reason?
  public let sourceGeneration: Int
  public let reservedThroughSequence: Int
  public let capture: NativeRecordingPCMState
}

/// Native-only maintenance for an already authorized, exclusively owned source.
/// The host retains original source-stop proof and confirms it only after stop
/// succeeds. Neither this owner nor its recovered lease can start an audio source.
public actor NativeRecordingContinuation {
  private struct Pending {
    let lease: NativeRecordingLease
    let first: Int
    let count: Int
  }

  private let session: IOSPCMSessionHandle
  private let sink: NativeRecordingPCMSink
  private let leases: NativeRecordingLeaseOwner
  private let reservations: NativeRecordingReservationOwner
  private let sourceClock: any PCMSourceClock
  private let runID: String
  private let initialAuthority: PCMSourceAuthority
  private let initialMaximum: Int
  private let firstSequence: Int
  private let hardEnd: Int
  // Must inspect the same native source owner and current authenticated mount;
  // never a renderer value or a fresh grant for a different source.
  private let validateActiveSource: @Sendable () async throws -> Void
  private var lease: NativeRecordingLease
  private var generation: Int
  private var reservedEnd: Int
  private var expires: Int64
  private var monotonicDeadline: UInt64
  private var phase: NativeRecordingContinuationState.Phase = .ready
  private var reason: NativeRecordingContinuationState.Reason?
  private var pending: Pending?
  private var renewing = false
  private var starting = false
  private var heartbeatTask: Task<Void, Never>?
  private var renewalTask: Task<Void, Never>?
  private var stopTask: Task<Void, Error>?

  public init(
    session: IOSPCMSessionHandle, sink: NativeRecordingPCMSink,
    leases: NativeRecordingLeaseOwner, reservations: NativeRecordingReservationOwner,
    initialLease: NativeRecordingLease, initialAuthority: PCMSourceAuthority,
    initialBatch: NativeRecordingReservationBatch,
    sourceClock: any PCMSourceClock = ContinuousPCMSourceClock(),
    validateActiveSource: @escaping @Sendable () async throws -> Void
  ) throws {
    let state = sink.state
    guard state.phase == .accepting, state.committedChunks == 0,
      initialLease.sessionID == initialBatch.sessionID,
      initialBatch.authorizedUntil == initialLease.expiresAt,
      initialAuthority.generation == 1,
      (1...90).contains(initialBatch.reservations.count),
      initialBatch.reservations.first?.sequence == state.nextSequence,
      initialBatch.reservations.count <= initialAuthority.hardMaximumChunks,
      state.nextSequence <= 2048 - initialAuthority.hardMaximumChunks,
      try Self.milliseconds(initialLease.expiresAt) == initialAuthority.expiresAtMilliseconds
    else { throw NativeRecordingFailure.invalidBinding }
    let deadline = try Self.deadline(initialAuthority.expiresAtMilliseconds, now: sourceClock.now())
    // The sink validates each row/scope and the writer rechecks persisted custody.
    try sink.stage(initialBatch)
    self.session = session
    self.sink = sink
    self.leases = leases
    self.reservations = reservations
    self.sourceClock = sourceClock
    self.validateActiveSource = validateActiveSource
    lease = initialLease
    runID = initialAuthority.runID
    self.initialAuthority = initialAuthority
    initialMaximum = initialBatch.reservations.count
    generation = initialAuthority.generation
    firstSequence = state.nextSequence
    hardEnd = state.nextSequence + initialAuthority.hardMaximumChunks
    reservedEnd = state.nextSequence + initialBatch.reservations.count
    expires = initialAuthority.expiresAtMilliseconds
    monotonicDeadline = deadline
  }

  deinit {
    heartbeatTask?.cancel()
    renewalTask?.cancel()
  }

  public var state: NativeRecordingContinuationState {
    NativeRecordingContinuationState(
      phase: phase, reason: reason, sourceGeneration: generation,
      reservedThroughSequence: reservedEnd, capture: sink.state)
  }

  /// Call after the native start gate has consumed its one-use permit. Separate
  /// native tasks keep the watchdog alive while a network renewal is suspended.
  /// The heartbeat never enlarges the independently enforced source deadline.
  public func startMaintenance() async throws {
    try await beginMaintenance(automatic: true)
  }

  func beginMaintenance(automatic: Bool) async throws {
    guard phase == .ready, !starting else {
      throw NativeRecordingBindingFailure.operationInProgress
    }
    starting = true
    defer { starting = false }
    do {
      try await validateActiveSource()
      try requireLive()
      try await session.ready()
      try requireLive()
      try await validateActiveSource()
      try requireLive()
      try await session.verifySource(authority: initialAuthority, maximumChunks: initialMaximum)
      try requireLive()
      guard phase == .ready else { throw NativeRecordingBindingFailure.authorityChanged }
      phase = .recording
      guard automatic else { return }
      let clock = sourceClock
      heartbeatTask = Task { [weak self] in
        while !Task.isCancelled {
          guard await self?.heartbeatAndObserve() == true else { return }
          do { try await clock.sleep(nanoseconds: 5_000_000_000) } catch { return }
        }
      }
      renewalTask = Task { [weak self] in
        while !Task.isCancelled {
          await self?.maintain()
          do { try await clock.sleep(nanoseconds: 5_000_000_000) } catch { return }
        }
      }
    } catch {
      await end(.sourceRetired)
      throw error
    }
  }

  /// Idempotent physical closure. Failed closure remains retryable and must not
  /// be reported to Core as stopped. A successful drain commits its partial once.
  public func stop() async throws {
    if phase == .stopped { return }
    if let stopTask { return try await stopTask.value }
    phase = .stopping
    heartbeatTask?.cancel()
    renewalTask?.cancel()
    heartbeatTask = nil
    renewalTask = nil
    let task = Task { [session, sink] in
      let result = try await session.stop(sink.state.phase == .failed ? .discard : .drain)
      if sink.state.phase != .failed && sink.state.phase != .closed {
        try sink.finish(result)
      } else {
        result.finalPacket?.bytes.zeroize()
      }
    }
    stopTask = task
    do {
      try await task.value
      phase = .stopped
      pending = nil
      stopTask = nil
    } catch {
      phase = .failed
      reason = .closureUnconfirmed
      stopTask = nil
      throw error
    }
  }

  private var active: Bool { phase == .recording || phase == .renewalDelayed }

  // Internal deterministic seams exercise the production maintenance operations
  // with an accelerated clock. Production callers use startMaintenance/stop only.
  func heartbeatAndObserve() async -> Bool {
    guard active else { return false }
    do { try await validateActiveSource() } catch {
      await end(.sourceRetired)
      return false
    }
    guard active else { return false }
    guard sink.state.phase == .accepting else {
      await end(sink.state.phase == .draining ? .authorityExpired : .captureFailed)
      return false
    }
    guard remainingNanoseconds() > 0 else {
      await end(.authorityExpired)
      return false
    }
    await session.heartbeat()
    return active
  }

  func maintain() async {
    guard active, !renewing else { return }
    guard remainingNanoseconds() > 0 else {
      await end(.authorityExpired)
      return
    }
    guard
      pending != nil || remainingNanoseconds() <= 120_000_000_000
        || (reservedEnd < hardEnd && reservedEnd - sink.state.nextSequence <= 12)
    else { return }
    renewing = true
    defer { renewing = false }
    do {
      do { try await validateActiveSource() } catch {
        await end(.sourceRetired)
        return
      }
      try requireLive()
      if pending == nil {
        let renewed = try await leases.renew()
        try requireLive()
        guard renewed.leaseID == lease.leaseID, renewed.sessionID == lease.sessionID,
          renewed.generation == lease.generation + 1,
          renewed.receiptID != lease.receiptID,
          try Self.milliseconds(renewed.expiresAt) > expires
        else { throw NativeRecordingBindingFailure.receiptMismatch }
        // Allocate after the prior window, never over a packet that may commit
        // during the request. Replenish to one window instead of accumulating
        // ninety unused reservations at each early renewal.
        let unused = reservedEnd - sink.state.nextSequence
        guard (0...90).contains(unused) else { throw NativeRecordingFailure.invalidBinding }
        pending = Pending(
          lease: renewed, first: reservedEnd,
          count: min(90 - unused, hardEnd - reservedEnd))
      }
      guard let next = pending else { throw NativeRecordingFailure.invalidBinding }
      if next.count > 0 {
        let batch = try await reservations.reserve(
          lease: next.lease, first: next.first, count: next.count)
        try requireLive()
        try sink.stage(batch)
      }
      do { try await validateActiveSource() } catch {
        await end(.sourceRetired)
        return
      }
      try requireLive()
      let nextExpires = try Self.milliseconds(next.lease.expiresAt)
      let nextDeadline = try Self.deadline(nextExpires, now: sourceClock.now())
      try await session.extend(
        PCMSourceExtension(
          runID: runID, generation: generation + 1, expiresAtMilliseconds: nextExpires,
          maximumChunks: next.first + next.count - firstSequence))
      // Stop/revocation may have won while the core actor handled the extension.
      guard active else { return }
      lease = next.lease
      generation += 1
      expires = nextExpires
      monotonicDeadline = nextDeadline
      reservedEnd = next.first + next.count
      pending = nil
      phase = .recording
    } catch {
      guard active else { return }
      if remainingNanoseconds() == 0 {
        await end(.authorityExpired)
      } else if case NativeRecordingBindingFailure.authorityChanged = error {
        await end(.sourceRetired)
      } else if case NativeRecordingBindingFailure.receiptMismatch = error {
        await end(.renewalRejected)
      } else if error is PCMFailure {
        await end(.captureFailed)
      } else if error is CancellationError {
        await end(.sourceRetired)
      } else if error is NativeRecordingBindingFailure || error is NativeRecordingFailure {
        await end(.storageFailed)
      } else {
        // Transport failure: preserve exact durable lease/reservation intents.
        // A retry never extends the old source until all receipts have verified.
        phase = .renewalDelayed
      }
    }
  }

  private func end(_ value: NativeRecordingContinuationState.Reason) async {
    guard active || phase == .ready else { return }
    reason = value
    try? await stop()
  }

  private func requireLive() throws {
    try Task.checkCancellation()
    guard active || phase == .ready, sink.state.phase == .accepting,
      remainingNanoseconds() > 0
    else { throw NativeRecordingBindingFailure.authorityChanged }
  }

  private func remainingNanoseconds() -> UInt64 {
    let now = sourceClock.now()
    guard now.epochMilliseconds >= 0, now.epochMilliseconds < expires,
      now.monotonicNanoseconds < monotonicDeadline
    else {
      return 0
    }
    return min(
      UInt64(min(905_000, expires - now.epochMilliseconds)) * 1_000_000,
      monotonicDeadline - now.monotonicNanoseconds)
  }

  private static func deadline(_ expires: Int64, now: PCMSourceTime) throws -> UInt64 {
    guard now.epochMilliseconds >= 0, expires > now.epochMilliseconds,
      expires - now.epochMilliseconds <= 905_000
    else { throw NativeRecordingBindingFailure.receiptMismatch }
    let duration = UInt64(expires - now.epochMilliseconds) * 1_000_000
    guard now.monotonicNanoseconds <= UInt64.max - duration else {
      throw NativeRecordingBindingFailure.receiptMismatch
    }
    return now.monotonicNanoseconds + duration
  }

  private static func milliseconds(_ value: String) throws -> Int64 {
    guard value.utf8.count <= 40 else { throw NativeRecordingBindingFailure.receiptMismatch }
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var date = parser.date(from: value)
    if date == nil {
      parser.formatOptions = [.withInternetDateTime]
      date = parser.date(from: value)
    }
    guard let date,
      (1...9_007_199_254_740_991).contains(date.timeIntervalSince1970 * 1000)
    else { throw NativeRecordingBindingFailure.receiptMismatch }
    return Int64(date.timeIntervalSince1970 * 1000)
  }
}
