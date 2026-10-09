import Foundation

public struct NativeRecordingLease: Codable, Equatable, Sendable {
  public let receiptID: UUID
  public let leaseID: UUID
  public let sessionID: UUID
  public let generation: Int
  public let issuedAt: String
  public let expiresAt: String

  public init(
    receiptID: UUID, leaseID: UUID, sessionID: UUID, generation: Int,
    issuedAt: String, expiresAt: String
  ) throws {
    guard (1..<9_007_199_254_740_991).contains(generation),
      let issued = Self.date(issuedAt), let expires = Self.date(expiresAt),
      issued.timeIntervalSince1970 > 0,
      (0...900).contains(expires.timeIntervalSince(issued)), expires > issued
    else { throw NativeRecordingBindingFailure.receiptMismatch }
    self.receiptID = receiptID
    self.leaseID = leaseID
    self.sessionID = sessionID
    self.generation = generation
    self.issuedAt = issuedAt
    self.expiresAt = expiresAt
  }

  static func date(_ value: String) -> Date? {
    guard value.utf8.count <= 40 else { return nil }
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = parser.date(from: value) { return date }
    parser.formatOptions = [.withInternetDateTime]
    return parser.date(from: value)
  }

  func validated() throws -> Self {
    try Self(
      receiptID: receiptID, leaseID: leaseID, sessionID: sessionID,
      generation: generation, issuedAt: issuedAt, expiresAt: expiresAt)
  }
}

public protocol NativeRecordingLeaseService: Sendable {
  func recordingScope() async throws -> NativeRecordingScope
  func requestLease(previous: NativeRecordingLease?, intent: UUID) async throws
    -> NativeRecordingLease
}

public protocol NativeRecordingLeaseRecordStore: Sendable {
  func readLease(key: String) throws -> NativeRecordingStoredRecord?
  func createLease(key: String, data: Data) throws
  func compareAndSwapLease(key: String, expectedRevision: UInt64, data: Data) throws
}

/// Durable issue/renew intents use the existing encrypted queue. A recovered
/// lease is metadata, not source permission: source-start/reservations and the
/// native monotonic deadline must still verify any proposed capture extension.
public actor NativeRecordingLeaseOwner {
  private struct Journal: Codable {
    let schemaVersion: Int
    let account: String
    var lease: NativeRecordingLease?
    var pending: UUID?
  }

  private let scope: NativeRecordingScope
  private let service: any NativeRecordingLeaseService
  private let records: any NativeRecordingLeaseRecordStore
  private let key: String
  private var busy = false

  public init(
    scope: NativeRecordingScope, service: any NativeRecordingLeaseService,
    records: any NativeRecordingLeaseRecordStore
  ) {
    self.scope = scope
    self.service = service
    self.records = records
    key = "scribe-native-lease:v1:\(scope.keyAccount)"
  }

  /// Replays an interrupted issue/renew exactly, or returns the retained lease.
  /// Expired receipts stay recoverable; they must never reopen an audio source.
  public func open() async throws -> NativeRecordingLease { try await advance(renew: false) }

  /// An explicit continuation renews the same lease using its last generation.
  public func renew() async throws -> NativeRecordingLease { try await advance(renew: true) }

  /// Before selecting the aggregate protocol, require the already-settled
  /// current lease. A legacy pending request must recover on its original path.
  public func requireSettled(_ lease: NativeRecordingLease) async throws {
    guard !busy else { throw NativeRecordingBindingFailure.operationInProgress }
    busy = true
    defer { busy = false }
    try await checkScope()
    guard let saved = try records.readLease(key: key) else {
      throw NativeRecordingBindingFailure.invalidJournal
    }
    let journal = try decode(saved)
    guard journal.pending == nil, journal.lease == lease else {
      throw NativeRecordingBindingFailure.journalConflict
    }
  }

  /// Adopt the exact first lease returned by the frozen aggregate request.
  public func adoptInitial(_ receipt: NativeRecordingLease, intent: UUID) async throws {
    guard !busy else { throw NativeRecordingBindingFailure.operationInProgress }
    busy = true
    defer { busy = false }
    try await checkScope()
    _ = try receipt.validated()
    guard receipt.sessionID == scope.sessionID, receipt.generation == 1 else {
      throw NativeRecordingBindingFailure.receiptMismatch
    }
    var journal: Journal
    if let saved = try records.readLease(key: key) {
      journal = try decode(saved)
      if journal.pending == nil, journal.lease == receipt { return }
      guard saved.revision == 1, journal.lease == nil, journal.pending == intent else {
        throw NativeRecordingBindingFailure.journalConflict
      }
    } else {
      journal = Journal(schemaVersion: 1, account: scope.keyAccount, pending: intent)
      try commit(journal, after: 0)
    }
    journal.lease = receipt
    journal.pending = nil
    try commit(journal, after: 1)
  }

  /// An aggregate owns this exact renewal before dispatch; adopt its receipt
  /// without replacing an older pending lease intent or issuing another one.
  public func adoptRenewal(
    _ receipt: NativeRecordingLease, previous: NativeRecordingLease, intent: UUID
  ) async throws {
    guard !busy else { throw NativeRecordingBindingFailure.operationInProgress }
    busy = true
    defer { busy = false }
    try await checkScope()
    _ = try previous.validated()
    _ = try receipt.validated()
    guard previous.sessionID == scope.sessionID, receipt.sessionID == scope.sessionID,
      receipt.leaseID == previous.leaseID, receipt.generation == previous.generation + 1,
      receipt.receiptID != previous.receiptID,
      let next = NativeRecordingLease.date(receipt.expiresAt),
      let old = NativeRecordingLease.date(previous.expiresAt), next > old,
      let saved = try records.readLease(key: key)
    else { throw NativeRecordingBindingFailure.receiptMismatch }
    var journal = try decode(saved)
    if journal.pending == nil, journal.lease == receipt { return }
    guard journal.lease == previous, journal.pending == nil || journal.pending == intent else {
      throw NativeRecordingBindingFailure.journalConflict
    }
    var revision = saved.revision
    if journal.pending == nil {
      journal.pending = intent
      try commit(journal, after: revision)
      revision += 1
    }
    journal.lease = receipt
    journal.pending = nil
    try commit(journal, after: revision)
  }

  private func advance(renew: Bool) async throws -> NativeRecordingLease {
    guard !busy else { throw NativeRecordingBindingFailure.operationInProgress }
    busy = true
    defer { busy = false }
    try await checkScope()
    let saved = try records.readLease(key: key)
    var journal: Journal
    var revision = saved?.revision ?? 0
    if let saved {
      journal = try decode(saved)
    } else {
      guard !renew else { throw NativeRecordingBindingFailure.invalidJournal }
      journal = Journal(schemaVersion: 1, account: scope.keyAccount, pending: UUID())
      try commit(journal, after: revision)
      revision += 1
    }
    if journal.pending == nil {
      guard let retained = journal.lease else { throw NativeRecordingBindingFailure.invalidJournal }
      if !renew { return retained }
      journal.pending = UUID()
      try commit(journal, after: revision)
      revision += 1
    }
    guard let intent = journal.pending else { throw NativeRecordingBindingFailure.invalidJournal }
    try await checkScope()
    let receipt = try await service.requestLease(previous: journal.lease, intent: intent)
      .validated()
    try await checkScope()
    guard receipt.sessionID == scope.sessionID else {
      throw NativeRecordingBindingFailure.receiptMismatch
    }
    if let previous = journal.lease {
      guard receipt.leaseID == previous.leaseID, receipt.generation == previous.generation + 1,
        receipt.receiptID != previous.receiptID,
        let next = NativeRecordingLease.date(receipt.expiresAt),
        let old = NativeRecordingLease.date(previous.expiresAt), next > old
      else { throw NativeRecordingBindingFailure.receiptMismatch }
    } else if receipt.generation != 1 {
      throw NativeRecordingBindingFailure.receiptMismatch
    }
    journal.lease = receipt
    journal.pending = nil
    try commit(journal, after: revision)
    return receipt
  }

  private func checkScope() async throws {
    try Task.checkCancellation()
    guard try await service.recordingScope() == scope else {
      throw NativeRecordingBindingFailure.authorityChanged
    }
    try Task.checkCancellation()
  }

  private func decode(_ record: NativeRecordingStoredRecord) throws -> Journal {
    guard record.data.count <= 4096, (1..<UInt64(Int64.max)).contains(record.revision),
      let value = try? JSONSerialization.jsonObject(with: record.data) as? [String: Any]
    else { throw NativeRecordingBindingFailure.invalidJournal }
    var expected: Set<String> = ["schemaVersion", "account"]
    if value["lease"] != nil { expected.insert("lease") }
    if value["pending"] != nil { expected.insert("pending") }
    guard Set(value.keys) == expected,
      let journal = try? JSONDecoder().decode(Journal.self, from: record.data),
      journal.schemaVersion == 1, journal.account == scope.keyAccount,
      journal.pending != nil || journal.lease != nil,
      (value["pending"] != nil) == (journal.pending != nil),
      (value["lease"] != nil) == (journal.lease != nil),
      (0..<9_007_199_254_740_991).contains(journal.lease?.generation ?? 0),
      record.revision == UInt64(journal.lease?.generation ?? 0) * 2
        + (journal.pending == nil ? 0 : 1)
    else { throw NativeRecordingBindingFailure.invalidJournal }
    if let lease = journal.lease {
      guard let fields = value["lease"] as? [String: Any],
        Set(fields.keys) == [
          "receiptID", "leaseID", "sessionID", "generation", "issuedAt", "expiresAt",
        ], lease.sessionID == scope.sessionID
      else { throw NativeRecordingBindingFailure.invalidJournal }
      _ = try lease.validated()
    }
    return journal
  }

  private func commit(_ journal: Journal, after revision: UInt64) throws {
    try Task.checkCancellation()
    guard revision < UInt64(Int64.max) - 1 else {
      throw NativeRecordingBindingFailure.invalidJournal
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(journal)
    _ = try decode(NativeRecordingStoredRecord(data: data, revision: revision + 1))
    do {
      if revision == 0 {
        try records.createLease(key: key, data: data)
      } else {
        try records.compareAndSwapLease(key: key, expectedRevision: revision, data: data)
      }
    } catch {
      guard let retained = try records.readLease(key: key), retained.revision == revision + 1,
        retained.data == data
      else { throw NativeRecordingBindingFailure.journalConflict }
    }
  }
}
