import Foundation

public struct NativeRecordingResumeWindowRequest: Codable, Equatable, Sendable {
  public let previous: NativeRecordingLease
  public let first: Int
  public let intent: UUID
  public let renewIntent: UUID
  public let reserveIntent: UUID
  public init(
    previous: NativeRecordingLease, first: Int, intent: UUID, renewIntent: UUID, reserveIntent: UUID
  ) {
    self.previous = previous
    self.first = first
    self.intent = intent
    self.renewIntent = renewIntent
    self.reserveIntent = reserveIntent
  }
}

public struct NativeRecordingResumeWindowReceipt: Codable, Equatable, Sendable {
  public let lease: NativeRecordingLease
  public let batch: NativeRecordingReservationBatch
  public init(lease: NativeRecordingLease, batch: NativeRecordingReservationBatch) {
    self.lease = lease
    self.batch = batch
  }
}

public protocol NativeRecordingResumeWindowService: Sendable {
  func recordingScope() async throws -> NativeRecordingScope
  func prepareResumeWindow(_ request: NativeRecordingResumeWindowRequest) async throws
    -> NativeRecordingResumeWindowReceipt
}

/// Start/Resume preparation only. An interrupted aggregate must finish before
/// the independent lease owner can recover or issue another request. Healthy
/// in-recording continuation keeps its existing durable protocol unchanged.
public actor NativeRecordingResumeWindowOwner {
  private struct Journal: Codable {
    let schemaVersion: Int
    let account: String
    let recovery: UUID
    let ordinal: UInt64
    let request: NativeRecordingResumeWindowRequest
    var receipt: NativeRecordingResumeWindowReceipt?
    var adopted: Bool
    var revision: UInt64 { ordinal * 3 + (adopted ? 3 : receipt == nil ? 1 : 2) }
  }
  private let scope: NativeRecordingScope
  private let recovery: UUID
  private let service: any NativeRecordingResumeWindowService
  private let records: any NativeRecordingBindingRecordStore
  private let key: String
  private var busy = false

  public init(
    scope: NativeRecordingScope, recoveryScope: UUID,
    service: any NativeRecordingResumeWindowService,
    records: any NativeRecordingBindingRecordStore
  ) {
    self.scope = scope
    recovery = recoveryScope
    self.service = service
    self.records = records
    key =
      "scribe-native-resume-window:v1:\(scope.keyAccount):\(recoveryScope.uuidString.lowercased())"
  }

  /// Must precede leases.open(): a crash may have adopted the lease but not
  /// yet the batch. The frozen request remains the sole recovery authority.
  public func recover(
    first: Int, leases: NativeRecordingLeaseOwner,
    reservations: NativeRecordingReservationOwner
  ) async throws -> NativeRecordingResumeWindowReceipt? {
    try await advance(previous: nil, first: first, leases: leases, reservations: reservations)
  }

  public func prepare(
    previous: NativeRecordingLease, first: Int,
    leases: NativeRecordingLeaseOwner,
    reservations: NativeRecordingReservationOwner
  ) async throws -> NativeRecordingResumeWindowReceipt {
    guard
      let result = try await advance(
        previous: previous, first: first, leases: leases, reservations: reservations)
    else { throw NativeRecordingBindingFailure.invalidJournal }
    return result
  }

  private func advance(
    previous: NativeRecordingLease?, first: Int,
    leases: NativeRecordingLeaseOwner,
    reservations: NativeRecordingReservationOwner
  ) async throws -> NativeRecordingResumeWindowReceipt? {
    guard !busy else { throw NativeRecordingBindingFailure.operationInProgress }
    busy = true
    defer { busy = false }
    try await checkScope()
    guard (0..<2048).contains(first) else { throw NativeRecordingFailure.invalidBinding }
    let saved = try records.readBinding(key: key)
    var journal = try saved.map(decode)
    if journal == nil || journal?.adopted == true {
      guard let previous else { return nil }
      _ = try previous.validated()
      guard previous.sessionID == scope.sessionID else {
        throw NativeRecordingFailure.invalidBinding
      }
      try await leases.requireSettled(previous)
      try await checkScope()
      if let retained = journal?.receipt {
        guard previous.leaseID == retained.lease.leaseID,
          previous.generation >= retained.lease.generation
        else { throw NativeRecordingBindingFailure.journalConflict }
      }
      journal = Journal(
        schemaVersion: 1, account: scope.keyAccount, recovery: recovery,
        ordinal: (journal?.ordinal).map { $0 + 1 } ?? 0,
        request: NativeRecordingResumeWindowRequest(
          previous: previous, first: first,
          intent: UUID(), renewIntent: UUID(), reserveIntent: UUID()), adopted: false)
      try commit(journal!, after: saved?.revision ?? 0)
    }
    guard var retained = journal, retained.request.first == first,
      previous == nil || previous == retained.request.previous
    else { throw NativeRecordingBindingFailure.journalConflict }
    if retained.receipt == nil {
      let receipt = try await service.prepareResumeWindow(retained.request)
      try await checkScope()
      try validate(receipt, request: retained.request)
      let revision = retained.revision
      retained.receipt = receipt
      try commit(retained, after: revision)
    }
    guard let receipt = retained.receipt else { throw NativeRecordingBindingFailure.invalidJournal }
    try await leases.adoptRenewal(
      receipt.lease, previous: retained.request.previous, intent: retained.request.renewIntent)
    try await checkScope()
    _ = try await reservations.adoptPrepared(
      lease: receipt.lease, batch: receipt.batch, intent: retained.request.reserveIntent)
    try await checkScope()
    let revision = retained.revision
    retained.adopted = true
    try commit(retained, after: revision)
    return receipt
  }

  private func checkScope() async throws {
    try Task.checkCancellation()
    guard try await service.recordingScope() == scope else {
      throw NativeRecordingBindingFailure.authorityChanged
    }
    try Task.checkCancellation()
  }
  private func validate(
    _ receipt: NativeRecordingResumeWindowReceipt, request: NativeRecordingResumeWindowRequest
  ) throws {
    let old = request.previous
    let next = receipt.lease
    _ = try next.validated()
    guard next.sessionID == scope.sessionID, next.leaseID == old.leaseID,
      next.generation == old.generation + 1, next.receiptID != old.receiptID,
      let expiry = NativeRecordingLease.date(next.expiresAt),
      let priorExpiry = NativeRecordingLease.date(old.expiresAt),
      expiry > priorExpiry, (1...90).contains(receipt.batch.reservations.count),
      receipt.batch.reservations.count <= 2048 - request.first
    else { throw NativeRecordingBindingFailure.receiptMismatch }
    try receipt.batch.validate(
      scope: scope, lease: next, first: request.first, count: receipt.batch.reservations.count)
  }
  private func encoded(_ value: Journal) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(value)
  }
  private func decode(_ row: NativeRecordingStoredRecord) throws -> Journal {
    guard row.data.count <= 131_072,
      let value = try? JSONDecoder().decode(Journal.self, from: row.data),
      value.schemaVersion == 1, value.account == scope.keyAccount, value.recovery == recovery,
      value.ordinal < UInt64(Int64.max) / 3 - 1, value.revision == row.revision,
      try encoded(value) == row.data, !value.adopted || value.receipt != nil,
      value.request.previous.sessionID == scope.sessionID, (0..<2048).contains(value.request.first),
      Set([value.request.intent, value.request.renewIntent, value.request.reserveIntent]).count == 3
    else { throw NativeRecordingBindingFailure.invalidJournal }
    _ = try value.request.previous.validated()
    if let receipt = value.receipt { try validate(receipt, request: value.request) }
    return value
  }
  private func commit(_ journal: Journal, after revision: UInt64) throws {
    try Task.checkCancellation()
    let data = try encoded(journal)
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
      else { throw NativeRecordingBindingFailure.journalConflict }
    }
  }
}
