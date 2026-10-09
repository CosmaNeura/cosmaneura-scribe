import Foundation
import XCTest

@testable import CosmaneuraNativeRecording

@MainActor final class NativeRecordingReservationTests: XCTestCase {
  private final class Records: NativeRecordingBindingRecordStore, NativeRecordingRecordStore,
    @unchecked Sendable
  {
    let lock = NSLock()
    var rows: [String: NativeRecordingStoredRecord] = [:]
    var fault = "none"
    var after = false
    var available = 2_000_000_000
    func readBinding(key: String) throws -> NativeRecordingStoredRecord? {
      try lock.withLock {
        if fault == "read" { throw NativeRecordingFailure.storageUnavailable }
        return rows[key]
      }
    }
    func read(key: String) throws -> NativeRecordingStoredRecord {
      guard let result = try readBinding(key: key) else {
        throw NativeRecordingFailure.storageUnavailable
      }
      return result
    }
    func createBinding(key: String, data: Data) throws { try write(key, data, 0) }
    func compareAndSwapBinding(key: String, expectedRevision: UInt64, data: Data) throws {
      try write(key, data, expectedRevision)
    }
    func compareAndSwap(key: String, expectedRevision: UInt64, data: Data) throws {
      try write(key, data, expectedRevision)
    }
    func availableBytes() -> Int { available }
    func write(_ key: String, _ data: Data, _ revision: UInt64) throws {
      try lock.withLock {
        guard rows[key]?.revision ?? 0 == revision else {
          throw NativeRecordingFailure.storageUnavailable
        }
        let queue = key.hasPrefix("scribe-provider-queue:")
        let fail =
          (!queue && fault == "journal-\(revision + 1)")
          || (queue && fault == "second-chunk"
            && rows.keys.filter { $0.hasPrefix("scribe-provider-queue:") }.count == 1)
        if fail && !after { throw NativeRecordingFailure.storageUnavailable }
        rows[key] = NativeRecordingStoredRecord(data: data, revision: revision + 1)
        if fail { throw NativeRecordingFailure.storageUnavailable }
      }
    }
    var queue: [String: NativeRecordingStoredRecord] {
      rows.filter { $0.key.hasPrefix("scribe-provider-queue:") }
    }
  }

  private actor Service: NativeRecordingReservationService {
    struct Call: Equatable {
      let lease: NativeRecordingLease
      let first: Int
      let count: Int
      let intent: UUID
    }
    let scope: NativeRecordingScope
    let leaseID = UUID()
    var calls: [Call] = []
    var saved: [UUID: NativeRecordingReservationBatch] = [:]
    var fault = "none"
    var changed = false
    var suspended: CheckedContinuation<Void, Never>?
    var waiter: CheckedContinuation<Void, Never>?
    init() throws {
      scope = try NativeRecordingScope(
        tenantID: UUID(), sessionID: UUID(), workspaceID: UUID(),
        accountDigest: String(repeating: "a", count: 64))
    }
    func configure(_ fault: String) { self.fault = fault }
    func revoke() { changed = true }
    func recordingScope() throws -> NativeRecordingScope {
      if changed {
        return try NativeRecordingScope(
          tenantID: UUID(), sessionID: scope.sessionID,
          workspaceID: scope.workspaceID, accountDigest: scope.accountDigest)
      }
      return scope
    }
    func reserve(lease: NativeRecordingLease, first: Int, count: Int, intent: UUID) async throws
      -> NativeRecordingReservationBatch
    {
      calls.append(Call(lease: lease, first: first, count: count, intent: intent))
      if fault == "pause" {
        await withCheckedContinuation {
          suspended = $0
          waiter?.resume()
          waiter = nil
        }
      }
      if fault == "scope" { changed = true }
      let rows = try (first..<(first + count)).map { index in
        let sequence = index + (fault == "sequence" ? 1 : 0)
        let object = UUID(
          uuidString: String(format: "10000000-0000-4000-8000-%012d", sequence + 1))!
        return try NativeRecordingReservation(
          scope: scope, objectID: object, sequence: sequence,
          additionalData: nativeBase64URL(
            scope.additionalData(objectID: object, sequence: sequence)),
          createdAt: "2026-09-26T00:00:00Z")
      }
      let batch = NativeRecordingReservationBatch(
        batchID: UUID(),
        sessionID: fault == "session" ? UUID() : scope.sessionID,
        authorizedUntil: fault == "deadline" ? "2026-09-26T00:01:00Z" : lease.expiresAt,
        reservations: fault == "count" ? Array(rows.dropLast()) : rows)
      if saved[intent] == nil { saved[intent] = batch }
      if fault == "lost" { throw NativeRecordingFailure.storageUnavailable }
      return saved[intent]!
    }
    func waitUntilSuspended() async {
      if suspended == nil { await withCheckedContinuation { waiter = $0 } }
    }
    func resume() {
      suspended?.resume()
      suspended = nil
    }
  }

  private let recovery = UUID()
  private func lease(_ service: Service, generation: Int = 1) throws -> NativeRecordingLease {
    let date = Date(timeIntervalSince1970: 1_790_000_000 + Double(generation * 600))
    let formatter = ISO8601DateFormatter()
    return try NativeRecordingLease(
      receiptID: UUID(), leaseID: service.leaseID,
      sessionID: service.scope.sessionID, generation: generation,
      issuedAt: formatter.string(from: date),
      expiresAt: formatter.string(from: date.addingTimeInterval(900)))
  }
  private func owner(_ service: Service, _ records: Records) -> NativeRecordingReservationOwner {
    NativeRecordingReservationOwner(
      scope: service.scope, recoveryScope: recovery, service: service, records: records)
  }
  private func liveLease(_ service: Service, expired: Bool = false) throws -> NativeRecordingLease {
    let issued = Date().addingTimeInterval(expired ? -1000 : -10)
    let formatter = ISO8601DateFormatter()
    return try NativeRecordingLease(
      receiptID: UUID(), leaseID: service.leaseID, sessionID: service.scope.sessionID,
      generation: 1, issuedAt: formatter.string(from: issued),
      expiresAt: formatter.string(from: issued.addingTimeInterval(900)))
  }
  private func rejected(_ operation: () async throws -> NativeRecordingReservationBatch) async {
    do {
      _ = try await operation()
      XCTFail("must fail closed")
    } catch {}
  }

  func testLostReplyReplaysExactWindowAndIntent() async throws {
    let service = try Service()
    let records = Records()
    let lease = try lease(service)
    await service.configure("lost")
    await rejected {
      try await self.owner(service, records).reserve(lease: lease, first: 0, count: 3)
    }
    XCTAssertTrue(records.queue.isEmpty)
    await service.configure("none")
    let batch = try await owner(service, records).reserve(lease: lease, first: 0, count: 3)
    let restored = try await owner(service, records).reserve(lease: lease, first: 0, count: 3)
    XCTAssertEqual(batch, restored)
    XCTAssertEqual(records.queue.count, 3)
    let calls = await service.calls
    XCTAssertEqual(calls.count, 2)
    XCTAssertEqual(calls[0], calls[1])
  }

  func testCancellationAndOverlapPreserveRequestForRecovery() async throws {
    let service = try Service()
    let records = Records()
    let lease = try lease(service)
    let owner = owner(service, records)
    await service.configure("pause")
    let active = Task { try await owner.reserve(lease: lease, first: 0, count: 3) }
    await service.waitUntilSuspended()
    await rejected { try await owner.reserve(lease: lease, first: 0, count: 3) }
    do {
      _ = try await owner.reuseForStart(lease: lease, first: 0)
      XCTFail("must not reuse during a reservation operation")
    } catch {}
    active.cancel()
    await service.resume()
    await rejected { try await active.value }
    XCTAssertTrue(records.queue.isEmpty)
    await service.configure("none")
    _ = try await self.owner(service, records).reserve(lease: lease, first: 0, count: 3)
    let calls = await service.calls
    XCTAssertEqual(calls.count, 2)
    XCTAssertEqual(calls[0], calls[1])
    XCTAssertEqual(records.queue.count, 3)
  }

  func testCorruptJournalCannotReplaceRetainedReservations() async throws {
    for field in ["unknown", "revision", "lease", "keys", "sequence", "account"] {
      let service = try Service()
      let records = Records()
      let lease = try lease(service)
      _ = try await owner(service, records).reserve(lease: lease, first: 0, count: 3)
      let key = try XCTUnwrap(
        records.rows.keys.first { $0.hasPrefix("scribe-native-reservations:") })
      let before = records.queue
      var journal = try XCTUnwrap(
        JSONSerialization.jsonObject(with: records.rows[key]!.data) as? [String: Any])
      switch field {
      case "lease":
        var value = journal["lease"] as! [String: Any]
        value["generation"] = -1
        journal["lease"] = value
      case "keys": journal["keys"] = []
      case "sequence":
        var batch = journal["batch"] as! [String: Any]
        var rows = batch["reservations"] as! [[String: Any]]
        rows[0]["sequence"] = 2
        batch["reservations"] = rows
        journal["batch"] = batch
      case "account": journal["account"] = "different-account"
      case "unknown": journal["unknown"] = true
      default: break
      }
      let damaged = try JSONSerialization.data(withJSONObject: journal)
      records.rows[key] = NativeRecordingStoredRecord(
        data: damaged, revision: field == "revision" ? 2 : 3)
      await rejected {
        try await self.owner(service, records).reserve(lease: lease, first: 0, count: 3)
      }
      XCTAssertEqual(records.rows[key]?.data, damaged)
      for (key, value) in before { XCTAssertEqual(records.rows[key]?.data, value.data) }
      let calls = await service.calls
      XCTAssertEqual(calls.count, 1)
    }
  }

  func testInterruptedWritesRecoverWithoutChangingUploadKeys() async throws {
    for fault in ["journal-1", "journal-2", "journal-3", "second-chunk"] {
      for after in [false, true] {
        let service = try Service()
        let records = Records()
        let lease = try lease(service)
        records.fault = fault
        records.after = after
        if after {
          _ = try await owner(service, records).reserve(lease: lease, first: 0, count: 3)
        } else {
          await rejected {
            try await self.owner(service, records).reserve(lease: lease, first: 0, count: 3)
          }
        }
        let before = records.queue
        records.fault = "none"
        _ = try await owner(service, records).reserve(lease: lease, first: 0, count: 3)
        for (key, value) in before { XCTAssertEqual(records.rows[key]?.data, value.data) }
        XCTAssertEqual(records.queue.count, 3)
        let calls = await service.calls
        XCTAssertEqual(calls.count, fault == "journal-2" && !after ? 2 : 1)
      }
    }
  }

  func testNewLeasePreservesOverlappingUnusedReservations() async throws {
    let service = try Service()
    let records = Records()
    _ = try await owner(service, records).reserve(lease: lease(service), first: 0, count: 3)
    let before = records.queue
    _ = try await owner(service, records).reserve(
      lease: lease(service, generation: 2), first: 1, count: 3)
    XCTAssertEqual(records.queue.count, 4)
    for (key, value) in before { XCTAssertEqual(records.rows[key]?.data, value.data) }
  }

  func testEncryptedOrConflictingRecordIsNeverOverwritten() async throws {
    for field in ["state", "additionalAuthenticatedData"] {
      let service = try Service()
      let records = Records()
      _ = try await owner(service, records).reserve(lease: lease(service), first: 0, count: 1)
      let key = try XCTUnwrap(records.queue.keys.first)
      let old = records.rows[key]!
      var value = try JSONSerialization.jsonObject(with: old.data) as! [String: Any]
      if field == "state" {
        value["state"] = "encrypted"
        value["envelope"] = "retained-ciphertext"
      } else {
        var reservation = value["reservation"] as! [String: Any]
        reservation[field] = "changed"
        value["reservation"] = reservation
      }
      let bytes = try JSONSerialization.data(withJSONObject: value)
      records.rows[key] = NativeRecordingStoredRecord(data: bytes, revision: 2)
      await rejected {
        try await self.owner(service, records).reserve(
          lease: self.lease(service, generation: 2), first: 0, count: 1)
      }
      XCTAssertEqual(records.rows[key]?.data, bytes)
    }
  }

  func testWrongAuthorityOrReceiptCannotCreateQueueRecords() async throws {
    for fault in ["scope", "session", "deadline", "sequence", "count", "read"] {
      let service = try Service()
      let records = Records()
      let lease = try lease(service)
      if fault == "read" { records.fault = "read" } else { await service.configure(fault) }
      await rejected {
        try await self.owner(service, records).reserve(lease: lease, first: 0, count: 3)
      }
      XCTAssertTrue(records.queue.isEmpty)
    }
  }

  func testInsufficientStorageRetainsBatchWithoutIssuingAgain() async throws {
    let service = try Service()
    let records = Records()
    let lease = try lease(service)
    records.available = 67_108_864
    await rejected {
      try await self.owner(service, records).reserve(lease: lease, first: 0, count: 3)
    }
    XCTAssertTrue(records.queue.isEmpty)
    records.available = 2_000_000_000
    _ = try await owner(service, records).reserve(lease: lease, first: 0, count: 3)
    let calls = await service.calls
    XCTAssertEqual(calls.count, 1)
  }

  func testThreeHourPositionBudgetAcrossTwelveWindows() async throws {
    let service = try Service()
    let records = Records()
    for window in 0..<12 {
      let result = try await owner(service, records).reserve(
        lease: lease(service, generation: window + 1),
        first: window * 90, count: 90)
      XCTAssertEqual(result.reservations.count, 90)
    }
    XCTAssertEqual(records.queue.count, 1080)
    let calls = await service.calls
    XCTAssertEqual(calls.count, 12)
    await rejected {
      try await self.owner(service, records).reserve(
        lease: self.lease(service), first: 2040, count: 90)
    }
    let unchanged = await service.calls.count
    XCTAssertEqual(unchanged, 12)
  }

  func testResumeReusesOnlyUnusedRowsWithoutNetworkOrWrites() async throws {
    let service = try Service()
    let records = Records()
    let lease = try liveLease(service)
    let owner = owner(service, records)
    let full = try await owner.reserve(lease: lease, first: 0, count: 90)
    for reservation in full.reservations.prefix(3) {
      let key =
        service.scope.queuePrefix(recoveryScope: recovery)
        + reservation.objectID.uuidString.lowercased()
      // Previously committed rows are not eligible for reuse or replacement.
      records.rows[key] = NativeRecordingStoredRecord(
        data: Data("retained encrypted row".utf8), revision: 2)
    }
    let before = records.rows
    let reused = try await owner.reuseForStart(lease: lease, first: 3)
    XCTAssertEqual(reused?.reservations, Array(full.reservations.dropFirst(3)))
    XCTAssertEqual(reused?.batchID, full.batchID)
    XCTAssertEqual(reused?.authorizedUntil, lease.expiresAt)
    let count = await service.calls.count
    XCTAssertEqual(count, 1)
    XCTAssertEqual(records.rows.count, before.count)
    for (key, row) in before {
      XCTAssertEqual(records.rows[key]?.data, row.data)
      XCTAssertEqual(records.rows[key]?.revision, row.revision)
    }
  }

  func testReuseMissesAfterRestartOrLeaseChangeAndKeepsRefillMargin() async throws {
    let service = try Service()
    let records = Records()
    let lease = try liveLease(service)
    let owner = owner(service, records)
    _ = try await owner.reserve(lease: lease, first: 0, count: 90)
    let restart = try await self.owner(service, records).reuseForStart(lease: lease, first: 1)
    let changed = try await owner.reuseForStart(lease: liveLease(service), first: 1)
    let short = try await owner.reuseForStart(lease: lease, first: 78)
    let outside = try await owner.reuseForStart(lease: lease, first: 90)
    let margin = try await owner.reuseForStart(lease: lease, first: 77)
    XCTAssertNil(restart)
    XCTAssertNil(changed)
    XCTAssertNil(short)
    XCTAssertNil(outside)
    XCTAssertEqual(margin?.reservations.count, 13)
    let count = await service.calls.count
    XCTAssertEqual(count, 1)
    _ = try await owner.reserve(lease: lease, first: 78, count: 90)
    let refreshed = await service.calls.count
    XCTAssertEqual(refreshed, 2)
  }

  func testExpiredLeaseCannotReuseAndHardLimitDoesNotExpand() async throws {
    let service = try Service()
    let records = Records()
    let owner = owner(service, records)
    let expired = try liveLease(service, expired: true)
    _ = try await owner.reserve(lease: expired, first: 0, count: 90)
    let unavailable = try await owner.reuseForStart(lease: expired, first: 1)
    XCTAssertNil(unavailable)
    let current = try liveLease(service)
    _ = try await owner.reserve(lease: current, first: 2040, count: 8)
    let tail = try await owner.reuseForStart(lease: current, first: 2041)
    XCTAssertEqual(tail?.reservations.map(\.sequence), Array(2041..<2048))
    do {
      _ = try await owner.reuseForStart(lease: current, first: 2048)
      XCTFail("must retain the visit limit")
    } catch {}
  }

  func testReuseRejectsDamagedJournalOrQueueWithoutRepairingIt() async throws {
    for fault in ["journal", "missing", "encrypted", "reservation", "storage"] {
      let service = try Service()
      let records = Records()
      let lease = try liveLease(service)
      let owner = owner(service, records)
      let batch = try await owner.reserve(lease: lease, first: 0, count: 20)
      let key =
        service.scope.queuePrefix(recoveryScope: recovery)
        + batch.reservations[1].objectID.uuidString.lowercased()
      switch fault {
      case "journal":
        let journal = try XCTUnwrap(
          records.rows.keys.first { $0.hasPrefix("scribe-native-reservations:") })
        records.rows[journal] = NativeRecordingStoredRecord(data: Data("{}".utf8), revision: 3)
      case "missing": records.rows.removeValue(forKey: key)
      case "storage": records.available = 67_108_864
      default:
        var row = try JSONSerialization.jsonObject(with: records.rows[key]!.data) as! [String: Any]
        if fault == "encrypted" {
          row["state"] = "encrypted"
        } else {
          var reservation = row["reservation"] as! [String: Any]
          reservation["createdAt"] = "2026-09-27T00:00:00Z"
          row["reservation"] = reservation
        }
        records.rows[key] = NativeRecordingStoredRecord(
          data: try JSONSerialization.data(withJSONObject: row), revision: 1)
      }
      let before = records.rows
      do {
        _ = try await owner.reuseForStart(lease: lease, first: 1)
        XCTFail("must reject \(fault)")
      } catch {}
      XCTAssertEqual(records.rows.count, before.count)
      for (key, row) in before { XCTAssertEqual(records.rows[key]?.data, row.data) }
      let count = await service.calls.count
      XCTAssertEqual(count, 1)
    }
  }

  func testReuseStillRejectsRevokedScope() async throws {
    let service = try Service()
    let records = Records()
    let lease = try liveLease(service)
    let owner = owner(service, records)
    _ = try await owner.reserve(lease: lease, first: 0, count: 20)
    await service.revoke()
    do {
      _ = try await owner.reuseForStart(lease: lease, first: 1)
      XCTFail("must recheck current scope")
    } catch {}
    let count = await service.calls.count
    XCTAssertEqual(count, 1)
  }
}
