import Foundation

/// Reuses the encrypted journal store and the upload queue's existing schema.
/// It allocates metadata only; native source ownership is required separately.
public actor NativeRecordingReservationOwner {
  private struct Keys: Codable {
    let upload: UUID
    let registration: UUID
  }
  private struct Journal: Codable {
    let schemaVersion: Int
    let account: String
    let recovery: UUID
    let lease: NativeRecordingLease
    let first: Int
    let count: Int
    let intent: UUID
    var batch: NativeRecordingReservationBatch?
    var keys: [Keys]?
    var done: Bool
    var revision: UInt64 { done ? 3 : (batch == nil ? 1 : 2) }
  }

  private let scope: NativeRecordingScope
  private let recovery: UUID
  private let service: any NativeRecordingReservationService
  private let records: any NativeRecordingBindingRecordStore & NativeRecordingRecordStore
  private var busy = false

  public init(
    scope: NativeRecordingScope, recoveryScope: UUID,
    service: any NativeRecordingReservationService,
    records: any NativeRecordingBindingRecordStore & NativeRecordingRecordStore
  ) {
    self.scope = scope
    recovery = recoveryScope
    self.service = service
    self.records = records
  }

  public func reserve(lease: NativeRecordingLease, first: Int, count: Int) async throws
    -> NativeRecordingReservationBatch
  {
    guard !busy else { throw NativeRecordingBindingFailure.operationInProgress }
    busy = true
    defer { busy = false }
    _ = try lease.validated()
    guard lease.sessionID == scope.sessionID, (0..<2048).contains(first), (1...90).contains(count),
      first <= 2048 - count
    else { throw NativeRecordingFailure.invalidBinding }
    try await checkScope()
    let key =
      "scribe-native-reservations:v1:\(scope.keyAccount):\(recovery.uuidString.lowercased()):\(lease.generation):\(first):\(count)"
    var journal: Journal
    if let saved = try records.readBinding(key: key) {
      journal = try decode(saved)
    } else {
      journal = Journal(
        schemaVersion: 1, account: scope.keyAccount, recovery: recovery,
        lease: lease, first: first, count: count, intent: UUID(), done: false)
      try commit(journal, key: key, after: 0)
    }
    guard journal.lease == lease, journal.first == first, journal.count == count else {
      throw NativeRecordingBindingFailure.journalConflict
    }
    if journal.batch == nil {
      let batch = try await service.reserve(
        lease: lease, first: first, count: count, intent: journal.intent)
      try await checkScope()
      try batch.validate(scope: scope, lease: lease, first: first, count: count)
      journal.batch = batch
      journal.keys = batch.reservations.map { _ in Keys(upload: UUID(), registration: UUID()) }
      try commit(journal, key: key, after: 1)
    }
    guard let batch = journal.batch, let keys = journal.keys else {
      throw NativeRecordingBindingFailure.invalidJournal
    }
    if journal.done { return batch }
    // Bounded metadata writes retain the existing 64 MiB recovery reserve.
    guard try records.availableBytes() >= 67_108_864 + count * 16_384 * 4 else {
      throw NativeRecordingFailure.storageUnavailable
    }
    for (index, reservation) in batch.reservations.enumerated() {
      try Task.checkCancellation()
      try ensureReserved(reservation, keys: keys[index], intent: journal.intent)
    }
    try await checkScope()
    journal.done = true
    try commit(journal, key: key, after: 2)
    return batch
  }

  private func ensureReserved(_ reservation: NativeRecordingReservation, keys: Keys, intent: UUID)
    throws
  {
    let key =
      scope.queuePrefix(recoveryScope: recovery) + reservation.objectID.uuidString.lowercased()
    let retry: [String: Any] = [
      "attempts": 0, "notBeforeEpochMs": NSNull(), "terminalCode": NSNull(),
    ]
    let value: [String: Any] = [
      "schemaVersion": 1, "revision": 1, "state": "reserved",
      "reservation": reservation.queueValue,
      "idempotencyKeys": [
        "reservation": intent.uuidString.lowercased(),
        "uploadAuthorization": keys.upload.uuidString.lowercased(),
        "uploadAuthorizationGeneration": 1,
        "registration": keys.registration.uuidString.lowercased(),
      ],
      "retry": ["upload": retry, "registration": retry],
    ]
    let data = try JSONSerialization.data(
      withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    let existing: NativeRecordingStoredRecord
    if let prior = try records.readBinding(key: key) {
      existing = prior
    } else {
      do {
        try records.createBinding(key: key, data: data)
        return
      } catch {
        guard let retained = try records.readBinding(key: key) else {
          throw NativeRecordingBindingFailure.journalConflict
        }
        existing = retained
      }
    }
    // A resumed window can overlap unused reservations from the last lease.
    // Preserve their original upload keys; never replace a record or ciphertext.
    let decoded = try nativeRecordingReservedRecord(
      existing, scope: scope,
      objectID: reservation.objectID, sequence: reservation.sequence)
    guard let prior = decoded.record["reservation"] as? [String: Any],
      NSDictionary(dictionary: prior).isEqual(to: reservation.queueValue)
    else {
      throw NativeRecordingBindingFailure.journalConflict
    }
  }

  private func checkScope() async throws {
    try Task.checkCancellation()
    guard try await service.recordingScope() == scope else {
      throw NativeRecordingBindingFailure.authorityChanged
    }
    try Task.checkCancellation()
  }

  private func decode(_ record: NativeRecordingStoredRecord) throws -> Journal {
    guard record.data.count <= 262_144,
      let raw = try? JSONSerialization.jsonObject(with: record.data) as? [String: Any]
    else { throw NativeRecordingBindingFailure.invalidJournal }
    var fields: Set<String> = [
      "schemaVersion", "account", "recovery", "lease", "first", "count", "intent", "done",
    ]
    if raw["batch"] != nil { fields.formUnion(["batch", "keys"]) }
    guard Set(raw.keys) == fields,
      let journal = try? JSONDecoder().decode(Journal.self, from: record.data),
      journal.schemaVersion == 1, journal.account == scope.keyAccount, journal.recovery == recovery,
      journal.revision == record.revision, journal.lease.sessionID == scope.sessionID,
      (0..<2048).contains(journal.first), (1...90).contains(journal.count),
      journal.first <= 2048 - journal.count,
      let lease = raw["lease"] as? [String: Any],
      Set(lease.keys) == [
        "receiptID", "leaseID", "sessionID", "generation", "issuedAt", "expiresAt",
      ], (raw["batch"] != nil) == (journal.batch != nil),
      (raw["keys"] != nil) == (journal.keys != nil),
      !journal.done || journal.batch != nil
    else { throw NativeRecordingBindingFailure.invalidJournal }
    _ = try journal.lease.validated()
    if let batch = journal.batch {
      guard let rawBatch = raw["batch"] as? [String: Any],
        Set(rawBatch.keys) == ["batchID", "sessionID", "authorizedUntil", "reservations"],
        let rows = rawBatch["reservations"] as? [[String: Any]],
        let keys = raw["keys"] as? [[String: Any]],
        rows.count == journal.count, keys.count == journal.count,
        journal.keys?.count == journal.count,
        rows.allSatisfy({
          Set($0.keys) == ["objectID", "sessionID", "sequence", "additionalData", "createdAt"]
        }),
        keys.allSatisfy({ Set($0.keys) == ["upload", "registration"] })
      else { throw NativeRecordingBindingFailure.invalidJournal }
      try batch.validate(
        scope: scope, lease: journal.lease, first: journal.first, count: journal.count)
    } else if journal.keys != nil {
      throw NativeRecordingBindingFailure.invalidJournal
    }
    return journal
  }

  private func commit(_ journal: Journal, key: String, after revision: UInt64) throws {
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
      else { throw NativeRecordingBindingFailure.journalConflict }
    }
  }
}
