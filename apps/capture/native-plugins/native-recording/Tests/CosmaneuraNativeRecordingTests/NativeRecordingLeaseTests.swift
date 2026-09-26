import Foundation
import XCTest

@testable import CosmaneuraNativeRecording

@MainActor final class NativeRecordingLeaseTests: XCTestCase {
  private final class Records: NativeRecordingLeaseRecordStore, @unchecked Sendable {
    let lock = NSLock()
    var row: NativeRecordingStoredRecord?
    var fault: UInt64?
    var after = false
    var unavailable = false
    func readLease(key: String) throws -> NativeRecordingStoredRecord? {
      try lock.withLock {
        if unavailable { throw NativeRecordingFailure.storageUnavailable }
        return row
      }
    }
    func createLease(key: String, data: Data) throws { try write(data, 0) }
    func compareAndSwapLease(key: String, expectedRevision: UInt64, data: Data) throws {
      try write(data, expectedRevision)
    }
    func write(_ data: Data, _ revision: UInt64) throws {
      try lock.withLock {
        guard row?.revision ?? 0 == revision else {
          throw NativeRecordingFailure.storageUnavailable
        }
        let fail = fault == revision + 1
        if fail && !after { throw NativeRecordingFailure.storageUnavailable }
        row = NativeRecordingStoredRecord(data: data, revision: revision + 1)
        if fail { throw NativeRecordingFailure.storageUnavailable }
      }
    }
  }

  private actor Service: NativeRecordingLeaseService {
    struct Call: Equatable {
      let previous: NativeRecordingLease?
      let intent: UUID
    }
    let scope: NativeRecordingScope
    let leaseID = UUID()
    var calls: [Call] = []
    var receipts: [UUID: NativeRecordingLease] = [:]
    var fault = "none"
    var changed = false
    var suspended: CheckedContinuation<Void, Never>?
    var waiter: CheckedContinuation<Void, Never>?
    init() throws {
      scope = try NativeRecordingScope(
        tenantID: UUID(), sessionID: UUID(), workspaceID: UUID(),
        accountDigest: String(repeating: "a", count: 64))
    }
    func configure(_ value: String) { fault = value }
    func recordingScope() throws -> NativeRecordingScope {
      if changed {
        return try NativeRecordingScope(
          tenantID: scope.tenantID, sessionID: UUID(),
          workspaceID: scope.workspaceID, accountDigest: scope.accountDigest)
      }
      return scope
    }
    func requestLease(previous: NativeRecordingLease?, intent: UUID) async throws
      -> NativeRecordingLease
    {
      calls.append(Call(previous: previous, intent: intent))
      if fault == "pause" {
        await withCheckedContinuation {
          suspended = $0
          waiter?.resume()
          waiter = nil
        }
      }
      if fault == "scope" { changed = true }
      let generation = (previous?.generation ?? 0) + 1
      let date = Date(timeIntervalSince1970: 1_790_000_000 + Double(generation * 600))
      let formatter = ISO8601DateFormatter()
      let result = try NativeRecordingLease(
        receiptID: UUID(),
        leaseID: fault == "lease" ? UUID() : leaseID,
        sessionID: fault == "session" ? UUID() : scope.sessionID,
        generation: fault == "generation" ? generation + 1 : generation,
        issuedAt: formatter.string(from: date),
        expiresAt: formatter.string(from: date.addingTimeInterval(900)))
      if receipts[intent] == nil { receipts[intent] = result }
      if fault == "lost" { throw NativeRecordingFailure.storageUnavailable }
      return receipts[intent]!
    }
    func waitUntilSuspended() async {
      if suspended == nil { await withCheckedContinuation { waiter = $0 } }
    }
    func resume() {
      suspended?.resume()
      suspended = nil
    }
  }

  private func owner(_ service: Service, _ records: Records) -> NativeRecordingLeaseOwner {
    NativeRecordingLeaseOwner(scope: service.scope, service: service, records: records)
  }

  private func rejected(_ work: () async throws -> NativeRecordingLease) async {
    do {
      _ = try await work()
      XCTFail("operation must fail closed")
    } catch {}
  }

  func testIssueAndRenewReplayExactIntentAfterRestart() async throws {
    let service = try Service()
    let records = Records()
    await service.configure("lost")
    await rejected { try await self.owner(service, records).open() }
    XCTAssertEqual(records.row?.revision, 1)
    await service.configure("none")
    let first = try await owner(service, records).open()
    XCTAssertEqual(first.generation, 1)
    await service.configure("lost")
    await rejected { try await self.owner(service, records).renew() }
    XCTAssertEqual(records.row?.revision, 3)
    await service.configure("none")
    let second = try await owner(service, records).open()
    let reopened = try await owner(service, records).open()
    XCTAssertEqual(second, reopened)
    XCTAssertEqual(second.generation, 2)
    XCTAssertEqual(first.leaseID, second.leaseID)
    let calls = await service.calls
    XCTAssertEqual(calls.count, 4)
    XCTAssertEqual(calls[0], calls[1])
    XCTAssertEqual(calls[2], calls[3])
    XCTAssertEqual(calls[2].previous, first)
  }

  func testDurableIntentPrecedesEveryMutationAndAcknowledgment() async throws {
    for revision: UInt64 in [1, 2, 3, 4] {
      for after in [false, true] {
        let service = try Service()
        let records = Records()
        if revision >= 3 { _ = try await owner(service, records).open() }
        records.fault = revision
        records.after = after
        let prior = await service.calls.count
        if after {
          _ =
            try await
            (revision >= 3 ? owner(service, records).renew() : owner(service, records).open())
        } else {
          await rejected {
            try await
              (revision >= 3
              ? self.owner(service, records).renew() : self.owner(service, records).open())
          }
          let count = await service.calls.count
          XCTAssertEqual(count, prior + (revision.isMultiple(of: 2) ? 1 : 0))
        }
        records.fault = nil
        let recovered = try await owner(service, records).open()
        XCTAssertEqual(recovered.generation, revision >= 3 && (after || revision == 4) ? 2 : 1)
      }
    }
  }

  func testRejectsChangedAuthorityAndMismatchedReceipts() async throws {
    for fault in ["scope", "session", "generation", "lease"] {
      let service = try Service()
      let records = Records()
      _ = try await owner(service, records).open()
      await service.configure(fault)
      await rejected { try await self.owner(service, records).renew() }
      XCTAssertEqual(records.row?.revision, 3)
    }
  }

  func testUnavailableOrMalformedJournalNeverIssuesNewLease() async throws {
    for malformed in [false, true] {
      let service = try Service()
      let records = Records()
      if malformed {
        records.row = NativeRecordingStoredRecord(data: Data("{}".utf8), revision: 1)
      } else {
        records.unavailable = true
      }
      await rejected { try await self.owner(service, records).open() }
      let calls = await service.calls
      XCTAssertTrue(calls.isEmpty)
    }
  }

  func testCancellationAndOverlappingCallsRetainPendingIntent() async throws {
    let service = try Service()
    let records = Records()
    let owner = owner(service, records)
    await service.configure("pause")
    let first = Task { try await owner.open() }
    await service.waitUntilSuspended()
    await rejected { try await owner.open() }
    first.cancel()
    await service.resume()
    await rejected { try await first.value }
    XCTAssertEqual(records.row?.revision, 1)
    await service.configure("none")
    _ = try await self.owner(service, records).open()
    let calls = await service.calls
    XCTAssertEqual(calls[0], calls[1])
  }

  func testCorruptJournalCannotMintOrReplaceLease() async throws {
    for fault in ["negative", "large", "extra", "account", "null", "revision"] {
      let service = try Service()
      let records = Records()
      _ = try await owner(service, records).open()
      let saved = try XCTUnwrap(records.row)
      var value = try JSONSerialization.jsonObject(with: saved.data) as! [String: Any]
      var lease = value["lease"] as! [String: Any]
      switch fault {
      case "negative": lease["generation"] = -1
      case "large": lease["generation"] = Int.max
      case "extra": lease["token"] = "must-not-be-retained"
      case "account": value["account"] = String(repeating: "b", count: 64)
      case "null": value["pending"] = NSNull()
      default: break
      }
      value["lease"] = lease
      records.row = NativeRecordingStoredRecord(
        data: try JSONSerialization.data(withJSONObject: value),
        revision: saved.revision + (fault == "revision" ? 1 : 0))
      await rejected { try await self.owner(service, records).open() }
      let calls = await service.calls
      XCTAssertEqual(calls.count, 1)
      XCTAssertEqual(records.row?.revision, saved.revision + (fault == "revision" ? 1 : 0))
    }
  }

  func testLeaseWindowCannotExceedFifteenMinutes() throws {
    for expires in ["bad", "2026-09-26T00:00:00Z", "2026-09-26T00:15:01Z"] {
      XCTAssertThrowsError(
        try NativeRecordingLease(
          receiptID: UUID(), leaseID: UUID(), sessionID: UUID(),
          generation: 1, issuedAt: "2026-09-26T00:00:00Z", expiresAt: expires))
    }
  }
}
