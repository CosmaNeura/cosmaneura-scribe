import CosmaneuraIOSPCMCore
import CosmaneuraNativeRecording
import Foundation

public struct NativeRecordingPCMState: Equatable, Sendable {
  public enum Phase: Sendable { case accepting, draining, failed, closed }
  public let phase: Phase
  public let nextSequence: Int
  public let committedChunks: Int
  public let committedPlaintextBytes: Int
  public let pendingReservations: Int
}

/// Consumes on IOSPCMCore's bounded processing path, never its audio callback.
/// The caller must already own the native source, consent and exclusive flow.
/// This sink cannot grant capture authority or start a microphone.
public final class NativeRecordingPCMSink: PCMEmissionSink, @unchecked Sendable {
  private let lock = NSLock()
  private let scope: NativeRecordingScope
  private let writer: NativeRecordingQueueWriter
  private let firstSequence: Int
  private var nextSequence: Int
  private var committedBytes = 0
  private var reservations: [Int: NativeRecordingReservation] = [:]
  private var phase: NativeRecordingPCMState.Phase = .accepting

  public init(
    encryption: NativeRecordingEncryption, recoveryScope: UUID,
    records: any NativeRecordingRecordStore, firstSequence: Int,
    priorPlaintextBytes: Int, maximumPlaintextBytes: Int = 402_653_184
  ) throws {
    scope = encryption.scope
    self.firstSequence = firstSequence
    nextSequence = firstSequence
    writer = try NativeRecordingQueueWriter(
      encryption: encryption, recoveryScope: recoveryScope, store: records,
      firstSequence: firstSequence, priorPlaintextBytes: priorPlaintextBytes,
      maximumPlaintextBytes: maximumPlaintextBytes)
  }

  public var state: NativeRecordingPCMState {
    lock.withLock {
      NativeRecordingPCMState(
        phase: phase, nextSequence: nextSequence,
        committedChunks: nextSequence - firstSequence,
        committedPlaintextBytes: committedBytes, pendingReservations: reservations.count)
    }
  }

  /// Allocations come from NativeRecordingReservationOwner's durable queue write.
  /// Retain at most two bounded windows. The writer rechecks actual custody/CAS
  /// for every packet; receiving metadata is not permission to extend a source.
  public func stage(_ batch: NativeRecordingReservationBatch) throws {
    try lock.withLock {
      guard phase == .accepting, batch.sessionID == scope.sessionID,
        (1...90).contains(batch.reservations.count),
        Set(batch.reservations.map(\.objectID)).count == batch.reservations.count,
        let start = batch.reservations.first?.sequence, start >= firstSequence,
        start <= 2048 - batch.reservations.count
      else { throw NativeRecordingFailure.invalidBinding }
      var proposed = reservations
      for (offset, row) in batch.reservations.enumerated() {
        guard row.sequence == start + offset, row.sessionID == scope.sessionID else {
          throw NativeRecordingFailure.invalidBinding
        }
        _ = try NativeRecordingReservation(
          scope: scope, objectID: row.objectID, sequence: row.sequence,
          additionalData: row.additionalData, createdAt: row.createdAt)
        // A reservation reply may arrive while earlier staged packets are being
        // committed. Those positions are already complete and must not reenter.
        if row.sequence < nextSequence { continue }
        if let existing = proposed[row.sequence], existing != row {
          throw NativeRecordingFailure.invalidBinding
        }
        proposed[row.sequence] = row
      }
      guard proposed.count <= 180,
        Set(proposed.values.map(\.objectID)).count == proposed.count
      else { throw NativeRecordingFailure.invalidBinding }
      reservations = proposed
    }
  }

  public func emit(_ packet: PCMEncodedPacket) throws -> any PCMAcknowledging {
    defer { packet.bytes.zeroize() }
    try lock.withLock {
      guard phase == .accepting else { throw NativeRecordingFailure.invalidPacket }
      do { _ = try persist(packet) } catch {
        fail()
        throw error
      }
    }
    // There is no WebView callback or pending audio payload to await. Accepted
    // means the existing encrypted queue already committed the complete packet.
    return DurablePacketAcknowledgement()
  }

  /// Call only after the source's confirmed drain. The caller's partial packet
  /// is cleared even on rejection; it can be committed at most once.
  @discardableResult public func finish(_ stopped: PCMStopResult) throws -> NativeRecordingCommit? {
    defer { stopped.finalPacket?.bytes.zeroize() }
    return try lock.withLock {
      guard phase == .accepting || phase == .draining else {
        throw NativeRecordingFailure.invalidPacket
      }
      do {
        let commit = try stopped.finalPacket.map { try persist($0) }
        phase = .closed
        reservations.removeAll()
        return commit
      } catch {
        fail()
        throw error
      }
    }
  }

  public func terminated(_ code: PCMTerminationCode) {
    lock.withLock { if phase != .closed { fail() } }
  }

  public func windowClosed(_ reason: PCMWindowCloseReason) {
    lock.withLock { if phase == .accepting { phase = .draining } }
  }

  private func persist(_ packet: PCMEncodedPacket) throws -> NativeRecordingCommit {
    guard packet.sequenceNumber < UInt64(2048 - firstSequence),
      firstSequence + Int(packet.sequenceNumber) == nextSequence,
      (2...320_000).contains(packet.bytes.count), packet.bytes.count.isMultiple(of: 2),
      let reserved = reservations[nextSequence]
    else { throw NativeRecordingFailure.invalidPacket }
    var pcm = packet.bytes.withUnsafeBytes { Data($0) }
    defer { pcm.resetBytes(in: 0..<pcm.count) }
    let result = try writer.persist(
      pcm16: &pcm, objectID: reserved.objectID, sequence: nextSequence)
    reservations.removeValue(forKey: nextSequence)
    nextSequence += 1
    committedBytes += result.plaintextBytes
    return result
  }

  private func fail() {
    phase = .failed
    reservations.removeAll()
  }
}

private struct DurablePacketAcknowledgement: PCMAcknowledging {
  func wait() async -> PCMAcknowledgementResult { .accepted }
  func cancel() {}  // The acknowledged ciphertext is already durable.
}
