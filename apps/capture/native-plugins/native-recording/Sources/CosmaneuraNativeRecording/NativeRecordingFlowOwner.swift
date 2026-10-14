import Foundation

public struct NativeRecordingFlowSnapshot: Equatable, Sendable {
  public enum Phase: String, Codable, Sendable { case open, incomplete, sealed }
  public let phase: Phase
  public let completionIntent: UUID
  public let committedChunks: Int
  public let committedPlaintextBytes: Int
  public let completionLease: NativeRecordingLease?
}

/// Durable capture/upload boundary. The native host holds exclusive flow/source
/// ownership: open before key/source work; reconcile/seal only after confirmed
/// physical stop. A sealed recording cannot resume. Its stable completion intent
/// and counts survive uploader purges and lost Core completion responses.
public actor NativeRecordingFlowOwner {
  public static let maximumPlaintextBytes = 402_653_184
  private struct Journal: Codable {
    let schemaVersion: Int
    let account: String
    let recovery: UUID
    let completionIntent: UUID
    var chunks: Int
    var plaintextBytes: Int
    var completionLease: NativeRecordingLease?
    var sourceCheckpoint: UUID?
  }
  private let scope: NativeRecordingScope
  private let recovery: UUID
  private let service: any NativeRecordingBindingService
  private let records: any NativeRecordingFlowStore
  private let key: String
  private var busy = false
  private struct Clearing {
    let checkpoint: UUID
    let journal: Journal
    let revision: UInt64
  }
  private var clearing: Clearing?
  private var createdEmptyFlow = false

  public init(
    scope: NativeRecordingScope, recoveryScope: UUID,
    service: any NativeRecordingBindingService, records: any NativeRecordingFlowStore
  ) {
    self.scope = scope
    recovery = recoveryScope
    self.service = service
    self.records = records
    key = "scribe-native-flow:v1:\(scope.keyAccount):\(recoveryScope.uuidString.lowercased())"
  }

  /// Creates metadata only. A nonempty queue with no flow journal is never
  /// adopted as a new recording (in particular, never replace legacy key custody).
  public func open() async throws -> NativeRecordingFlowSnapshot {
    try enter()
    defer { busy = false }
    createdEmptyFlow = false
    try await checkScope()
    if let saved = try records.readBinding(key: key) { return snapshot(try decode(saved)) }
    guard try records.listRecordingKeys(prefix: scope.queuePrefix(recoveryScope: recovery)).isEmpty,
      try records.availableBytes() >= 67_108_864 + 16_384 * 4
    else { throw NativeRecordingBindingFailure.invalidJournal }
    let journal = Journal(
      schemaVersion: 1, account: scope.keyAccount, recovery: recovery,
      completionIntent: UUID(), chunks: 0, plaintextBytes: 0)
    try await checkScope()
    try commit(journal, after: 0)
    createdEmptyFlow = true
    return snapshot(journal)
  }

  /// Consumed only during this host's initial open, before any key/window/source.
  /// Existing/recovered flow journals and nonempty queues cannot issue proof.
  public func takeFreshInitialWindowProof() async throws -> NativeRecordingFreshFlow? {
    try enter()
    defer { busy = false }
    let created = createdEmptyFlow
    createdEmptyFlow = false
    guard created else { return nil }
    try await checkScope()
    let (saved, journal) = try load()
    guard saved.revision == 1, journal.chunks == 0, journal.plaintextBytes == 0,
      journal.sourceCheckpoint == nil, journal.completionLease == nil,
      try records.listRecordingKeys(prefix: scope.queuePrefix(recoveryScope: recovery)).isEmpty
    else { return nil }
    return NativeRecordingFreshFlow(scope: scope, recovery: recovery)
  }

  /// Persist before any audio admission. A crash or failed final write leaves
  /// this checkpoint unresolved; reconstructing a prefix cannot silently seal it.
  public func beginSource(checkpoint: UUID) async throws -> NativeRecordingFlowSnapshot {
    try enter()
    defer { busy = false }
    try await checkScope()
    let (saved, journal) = try load()
    guard journal.completionLease == nil, clearing == nil,
      journal.sourceCheckpoint == nil || journal.sourceCheckpoint == checkpoint
    else { throw NativeRecordingBindingFailure.invalidJournal }
    if journal.sourceCheckpoint == checkpoint { return snapshot(journal) }
    var next = journal
    next.sourceCheckpoint = checkpoint
    try await checkScope()
    try commit(next, after: saved.revision)
    return snapshot(next)
  }

  /// Native host only, after confirmed physical/Core stop and successful durable
  /// sink completion. The exact checkpoint and verified inventory must agree.
  public func finishSource(checkpoint: UUID, encryption: NativeRecordingEncryption,
    chunks: Int, plaintextBytes: Int) async throws -> NativeRecordingFlowSnapshot {
    try enter()
    defer { busy = false }
    try await checkScope()
    guard encryption.scope == scope else { throw NativeRecordingBindingFailure.authorityChanged }
    if let clearing {
      guard clearing.checkpoint == checkpoint, clearing.journal.chunks == chunks,
        clearing.journal.plaintextBytes == plaintextBytes
      else { throw NativeRecordingBindingFailure.invalidJournal }
      // Retry the exact CAS recipe after a lost clear response. The existing
      // commit helper accepts only its exact durable bytes and next revision.
      try commit(clearing.journal, after: clearing.revision)
      self.clearing = nil
      return snapshot(clearing.journal)
    }
    let (saved, journal) = try load()
    guard journal.sourceCheckpoint == checkpoint, journal.completionLease == nil else {
      throw NativeRecordingBindingFailure.invalidJournal
    }
    var next = try reconcile(journal, encryption: encryption)
    guard next.chunks == chunks, next.plaintextBytes == plaintextBytes else {
      throw NativeRecordingBindingFailure.invalidJournal
    }
    next.sourceCheckpoint = nil
    try await checkScope()
    clearing = Clearing(checkpoint: checkpoint, journal: next, revision: saved.revision)
    try commit(next, after: saved.revision)
    clearing = nil
    return snapshot(next)
  }

  public func reconcileAfterStop(encryption: NativeRecordingEncryption) async throws
    -> NativeRecordingFlowSnapshot
  {
    try enter()
    defer { busy = false }
    try await checkScope()
    let (saved, journal) = try load()
    if journal.completionLease != nil { return snapshot(journal) }
    let reconciled = try reconcile(journal, encryption: encryption)
    try await checkScope()
    if reconciled.chunks != journal.chunks || reconciled.plaintextBytes != journal.plaintextBytes {
      try commit(reconciled, after: saved.revision)
    }
    return snapshot(reconciled)
  }

  /// Commit before the first upload/purge. Retrying returns the original frozen
  /// completion lease/intent; later callers cannot replace its request payload.
  public func sealForUpload(encryption: NativeRecordingEncryption, lease: NativeRecordingLease)
    async throws -> NativeRecordingFlowSnapshot
  {
    try enter()
    defer { busy = false }
    try await checkScope()
    let (saved, journal) = try load()
    if journal.completionLease != nil { return snapshot(journal) }
    guard journal.sourceCheckpoint == nil else {
      throw NativeRecordingBindingFailure.invalidJournal
    }
    guard lease.sessionID == scope.sessionID else {
      throw NativeRecordingBindingFailure.receiptMismatch
    }
    _ = try lease.validated()
    var next = try reconcile(journal, encryption: encryption)
    guard next.chunks > 0 else { throw NativeRecordingBindingFailure.invalidJournal }
    next.completionLease = lease
    try await checkScope()
    try commit(next, after: saved.revision)
    return snapshot(next)
  }

  private func enter() throws {
    guard !busy else { throw NativeRecordingBindingFailure.operationInProgress }
    busy = true
  }
  private func checkScope() async throws {
    try Task.checkCancellation()
    guard try await service.recordingScope() == scope else {
      throw NativeRecordingBindingFailure.authorityChanged
    }
    try Task.checkCancellation()
  }
  private func load() throws -> (NativeRecordingStoredRecord, Journal) {
    guard let stored = try records.readBinding(key: key) else {
      throw NativeRecordingBindingFailure.invalidJournal
    }
    return (stored, try decode(stored))
  }
  private func reconcile(_ journal: Journal, encryption: NativeRecordingEncryption) throws
    -> Journal
  {
    guard encryption.scope == scope else { throw NativeRecordingBindingFailure.authorityChanged }
    let inventory = try NativeRecordingFlowInventory.read(
      encryption: encryption, recoveryScope: recovery, records: records)
    guard inventory.chunks >= journal.chunks, inventory.plaintextBytes >= journal.plaintextBytes,
      inventory.chunks != journal.chunks || inventory.plaintextBytes == journal.plaintextBytes
    else { throw NativeRecordingBindingFailure.invalidJournal }
    var next = journal
    next.chunks = inventory.chunks
    next.plaintextBytes = inventory.plaintextBytes
    return next
  }
  private func snapshot(_ journal: Journal) -> NativeRecordingFlowSnapshot {
    NativeRecordingFlowSnapshot(
      phase: journal.completionLease != nil ? .sealed : journal.sourceCheckpoint == nil ? .open : .incomplete,
      completionIntent: journal.completionIntent, committedChunks: journal.chunks,
      committedPlaintextBytes: journal.plaintextBytes, completionLease: journal.completionLease)
  }
  private func decode(_ stored: NativeRecordingStoredRecord) throws -> Journal {
    guard stored.data.count <= 8192, (1..<UInt64(Int64.max)).contains(stored.revision),
      let raw = try? JSONSerialization.jsonObject(with: stored.data) as? [String: Any]
    else { throw NativeRecordingBindingFailure.invalidJournal }
    var keys: Set<String> = [
      "schemaVersion", "account", "recovery", "completionIntent", "chunks", "plaintextBytes",
    ]
    if raw["completionLease"] != nil { keys.insert("completionLease") }
    if raw["sourceCheckpoint"] != nil { keys.insert("sourceCheckpoint") }
    guard Set(raw.keys) == keys,
      let journal = try? JSONDecoder().decode(Journal.self, from: stored.data),
      journal.schemaVersion == 1, journal.account == scope.keyAccount, journal.recovery == recovery,
      (0...2048).contains(journal.chunks),
      (0...Self.maximumPlaintextBytes).contains(journal.plaintextBytes),
      (journal.chunks == 0) == (journal.plaintextBytes == 0),
      journal.plaintextBytes >= journal.chunks * 46,
      journal.plaintextBytes <= journal.chunks * 320_044,
      (journal.completionLease != nil) == (raw["completionLease"] != nil),
      (journal.sourceCheckpoint != nil) == (raw["sourceCheckpoint"] != nil),
      journal.completionLease == nil || journal.sourceCheckpoint == nil
    else { throw NativeRecordingBindingFailure.invalidJournal }
    if let lease = journal.completionLease {
      guard journal.chunks > 0, lease.sessionID == scope.sessionID,
        let rawLease = raw["completionLease"] as? [String: Any],
        Set(rawLease.keys) == [
          "receiptID", "leaseID", "sessionID", "generation", "issuedAt", "expiresAt",
        ]
      else { throw NativeRecordingBindingFailure.invalidJournal }
      _ = try lease.validated()
    }
    return journal
  }
  private func commit(_ journal: Journal, after revision: UInt64) throws {
    try Task.checkCancellation()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(journal)
    _ = try decode(NativeRecordingStoredRecord(data: data, revision: revision + 1))
    do {
      if revision == 0 {
        try records.createBinding(key: key, data: data)
      } else {
        try records.compareAndSwapBinding(key: key, expectedRevision: revision, data: data)
      }
    } catch {
      guard let saved = try records.readBinding(key: key), saved.revision == revision + 1,
        saved.data == data
      else {
        throw NativeRecordingBindingFailure.journalConflict
      }
    }
  }
}
