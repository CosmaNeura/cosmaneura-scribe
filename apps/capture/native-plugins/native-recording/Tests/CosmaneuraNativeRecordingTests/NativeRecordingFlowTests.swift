import CryptoKit
import Foundation
import Security
import XCTest

@testable import CosmaneuraNativeRecording

@MainActor final class NativeRecordingFlowTests: XCTestCase {
  private final class Records: NativeRecordingFlowStore, @unchecked Sendable {
    let lock = NSLock()
    var rows: [String: NativeRecordingStoredRecord] = [:]
    var failBefore = false, failAfter = false, listFails = false
    var failRead = false, hideFailedWrite = false
    var additions: [String] = []
    func readBinding(key: String) throws -> NativeRecordingStoredRecord? {
      try lock.withLock {
        if failRead { throw NativeRecordingFailure.storageUnavailable }
        return rows[key]
      }
    }
    func read(key: String) throws -> NativeRecordingStoredRecord {
      try XCTUnwrap(readBinding(key: key))
    }
    func createBinding(key: String, data: Data) throws { try write(key, 0, data) }
    func compareAndSwapBinding(key: String, expectedRevision: UInt64, data: Data) throws {
      try write(key, expectedRevision, data)
    }
    func compareAndSwap(key: String, expectedRevision: UInt64, data: Data) throws {
      try write(key, expectedRevision, data)
    }
    func availableBytes() -> Int { 2_000_000_000 }
    func listRecordingKeys(prefix: String) throws -> [String] {
      try lock.withLock {
        if listFails { throw NativeRecordingFailure.storageUnavailable }
        return rows.keys.filter { $0.hasPrefix(prefix) }.sorted() + additions
      }
    }
    func write(_ key: String, _ revision: UInt64, _ data: Data) throws {
      try lock.withLock {
        if failBefore { throw NativeRecordingFailure.storageUnavailable }
        guard rows[key]?.revision ?? 0 == revision else {
          throw NativeRecordingBindingFailure.journalConflict
        }
        rows[key] = NativeRecordingStoredRecord(data: data, revision: revision + 1)
        if failAfter {
          if hideFailedWrite { failRead = true }
          throw NativeRecordingFailure.storageUnavailable
        }
      }
    }
    var flowKey: String { rows.keys.first { $0.hasPrefix("scribe-native-flow:") }! }
    func edit(_ key: String, _ operation: (inout [String: Any]) throws -> Void) throws {
      let row = try XCTUnwrap(rows[key])
      var value = try JSONSerialization.jsonObject(with: row.data) as! [String: Any]
      try operation(&value)
      rows[key] = NativeRecordingStoredRecord(
        data: try JSONSerialization.data(withJSONObject: value), revision: row.revision)
    }
  }
  private final class Keys: NativeRecordingKeyStorage, @unchecked Sendable {
    var value: Data?
    func read(account: String) -> Data? { value }
    func insert(account: String, value: Data) throws {
      guard self.value == nil else { throw NativeRecordingFailure.keyConflict }
      self.value = value
    }
  }
  private actor Service: NativeRecordingBindingService, NativeRecordingReservationService {
    let scope: NativeRecordingScope
    var changed = false, hold = false
    var waiting: CheckedContinuation<Void, Never>?
    var checks = 0
    init(scope: NativeRecordingScope) { self.scope = scope }
    func configure(changed: Bool = false, hold: Bool = false) {
      self.changed = changed
      self.hold = hold
    }
    func release() {
      waiting?.resume()
      waiting = nil
      hold = false
    }
    func recordingScope() async throws -> NativeRecordingScope {
      checks += 1
      if hold { await withCheckedContinuation { waiting = $0 } }
      if changed { throw NativeRecordingBindingFailure.authorityChanged }
      return scope
    }
    func publishedKey() throws -> NativeRecordingPublicKey {
      throw NativeRecordingFailure.invalidKey
    }
    func bind(key: NativeRecordingKeyReceipt, intent: UUID) throws
      -> NativeRecordingBindingAcknowledgement
    {
      throw NativeRecordingFailure.invalidKey
    }
    func reserve(lease: NativeRecordingLease, first: Int, count: Int, intent: UUID) throws
      -> NativeRecordingReservationBatch
    {
      let values = try (first..<(first + count)).map { index in
        let object = UUID()
        return try NativeRecordingReservation(
          scope: scope, objectID: object, sequence: index,
          additionalData: nativeBase64URL(scope.additionalData(objectID: object, sequence: index)),
          createdAt: lease.issuedAt)
      }
      return NativeRecordingReservationBatch(
        batchID: UUID(), sessionID: scope.sessionID, authorizedUntil: lease.expiresAt,
        reservations: values)
    }
  }
  private struct Fixture {
    let scope: NativeRecordingScope, recovery = UUID()
    let records = Records(), keys = Keys(), service: Service
    let cipher: NativeRecordingEncryption, lease: NativeRecordingLease
    init() throws {
      scope = try NativeRecordingScope(
        tenantID: UUID(), sessionID: UUID(), workspaceID: UUID(),
        accountDigest: String(repeating: "a", count: 64))
      service = Service(scope: scope)
      let key = try XCTUnwrap(
        SecKeyCreateRandomKey(
          [
            kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits: 3072,
            kSecAttrIsPermanent: false,
          ] as CFDictionary, nil))
      let der =
        try XCTUnwrap(SecKeyCopyExternalRepresentation(XCTUnwrap(SecKeyCopyPublicKey(key)), nil))
        as Data
      cipher = try NativeRecordingEncryption.create(
        scope: scope,
        published: NativeRecordingPublicKey(
          version: "synthetic-v1", modulusBase64URL: nativeBase64URL(der.subdata(in: 9..<393))),
        storage: keys)
      lease = try NativeRecordingLease(
        receiptID: UUID(), leaseID: UUID(), sessionID: scope.sessionID,
        generation: 1, issuedAt: "2026-09-26T00:00:00Z", expiresAt: "2026-09-26T00:15:00Z")
    }
    var owner: NativeRecordingFlowOwner {
      NativeRecordingFlowOwner(
        scope: scope, recoveryScope: recovery, service: service, records: records)
    }
    func record(_ sizes: [Int], reserve count: Int = 3) async throws -> [String] {
      let reservations = NativeRecordingReservationOwner(
        scope: scope, recoveryScope: recovery, service: service, records: records)
      let batch = try await reservations.reserve(lease: lease, first: 0, count: count)
      let writer = try NativeRecordingQueueWriter(
        encryption: cipher, recoveryScope: recovery, store: records,
        firstSequence: 0, priorPlaintextBytes: 0,
        maximumPlaintextBytes: NativeRecordingFlowOwner.maximumPlaintextBytes)
      for (index, size) in sizes.enumerated() {
        var pcm = Data(repeating: 4, count: size)
        _ = try writer.persist(
          pcm16: &pcm, objectID: batch.reservations[index].objectID, sequence: index)
        XCTAssertTrue(pcm.allSatisfy { $0 == 0 })
      }
      return batch.reservations.map {
        scope.queuePrefix(recoveryScope: recovery) + $0.objectID.uuidString.lowercased()
      }
    }
  }
  /// Generates one authenticated queue record on demand. This exercises the
  /// full three-hour scan without retaining a second whole recording in tests.
  private final class StreamingRecords: NativeRecordingFlowStore, @unchecked Sendable {
    private final class One: NativeRecordingRecordStore {
      var row: NativeRecordingStoredRecord
      init(_ data: Data) { row = NativeRecordingStoredRecord(data: data, revision: 1) }
      func read(key: String) -> NativeRecordingStoredRecord { row }
      func availableBytes() -> Int { 2_000_000_000 }
      func compareAndSwap(key: String, expectedRevision: UInt64, data: Data) throws {
        guard expectedRevision == row.revision else {
          throw NativeRecordingBindingFailure.journalConflict
        }
        row = NativeRecordingStoredRecord(data: data, revision: row.revision + 1)
      }
    }
    let cipher: NativeRecordingEncryption, recovery: UUID
    let lock = NSLock()
    var retained: [String: NativeRecordingStoredRecord] = [:]
    private var enabled = false
    private var reads = 0
    let objects = (0..<1080).map {
      UUID(uuidString: String(format: "10000000-0000-4000-8000-%012d", $0))!
    }
    init(cipher: NativeRecordingEncryption, recovery: UUID) {
      self.cipher = cipher
      self.recovery = recovery
    }
    func enable() { lock.withLock { enabled = true } }
    var readCount: Int { lock.withLock { reads } }
    func readBinding(key: String) -> NativeRecordingStoredRecord? {
      lock.withLock { retained[key] }
    }
    func createBinding(key: String, data: Data) throws { try write(key, 0, data) }
    func compareAndSwapBinding(key: String, expectedRevision: UInt64, data: Data) throws {
      try write(key, expectedRevision, data)
    }
    func compareAndSwap(key: String, expectedRevision: UInt64, data: Data) throws {
      try write(key, expectedRevision, data)
    }
    func availableBytes() -> Int { 2_000_000_000 }
    func write(_ key: String, _ revision: UInt64, _ data: Data) throws {
      try lock.withLock {
        guard retained[key]?.revision ?? 0 == revision else {
          throw NativeRecordingBindingFailure.journalConflict
        }
        retained[key] = NativeRecordingStoredRecord(data: data, revision: revision + 1)
      }
    }
    func listRecordingKeys(prefix: String) -> [String] {
      lock.withLock {
        enabled ? objects.reversed().map { prefix + $0.uuidString.lowercased() } : []
      }
    }
    func read(key: String) throws -> NativeRecordingStoredRecord {
      let prefix = cipher.scope.queuePrefix(recoveryScope: recovery)
      guard key.hasPrefix(prefix),
        let object = UUID(uuidString: String(key.dropFirst(prefix.count))),
        let sequence = objects.firstIndex(of: object)
      else { throw NativeRecordingBindingFailure.invalidJournal }
      lock.withLock { reads += 1 }
      let empty: [String: Any] = [
        "attempts": 0, "notBeforeEpochMs": NSNull(), "terminalCode": NSNull(),
      ]
      let row = try NativeRecordingReservation(
        scope: cipher.scope, objectID: object, sequence: sequence,
        additionalData: nativeBase64URL(
          cipher.scope.additionalData(objectID: object, sequence: sequence)),
        createdAt: "2026-09-26T00:00:00Z")
      let data = try JSONSerialization.data(withJSONObject: [
        "schemaVersion": 1, "revision": 1, "state": "reserved", "reservation": row.queueValue,
        "idempotencyKeys": [
          "reservation": "synthetic-reservation", "uploadAuthorization": "synthetic-upload",
          "uploadAuthorizationGeneration": 1, "registration": "synthetic-registration",
        ],
        "retry": ["upload": empty, "registration": empty],
      ])
      let one = One(data)
      let writer = try NativeRecordingQueueWriter(
        encryption: cipher, recoveryScope: recovery, store: one,
        firstSequence: sequence, priorPlaintextBytes: sequence * 320_044,
        maximumPlaintextBytes: NativeRecordingFlowOwner.maximumPlaintextBytes)
      var pcm = Data(repeating: 0, count: 320_000)  // Synthetic silence, never an OS source.
      _ = try writer.persist(pcm16: &pcm, objectID: object, sequence: sequence)
      return one.row
    }
  }

  private func rejected(_ operation: () async throws -> NativeRecordingFlowSnapshot) async {
    do {
      _ = try await operation()
      XCTFail("must preserve custody and reject")
    } catch {}
  }

  private func assertSnapshot(
    _ actual: NativeRecordingFlowSnapshot, _ expected: NativeRecordingFlowSnapshot,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    XCTAssertEqual(actual, expected, file: file, line: line)
  }

  func testPendingSourceSurvivesRestartAndCannotSealReconciledPrefix() async throws {
    let f = try Fixture(), owner = f.owner, checkpoint = UUID()
    let original = try await owner.open()
    _ = try await owner.beginSource(checkpoint: checkpoint)
    _ = try await f.record([320_000])
    let restarted = f.owner
    let pending = try await restarted.reconcileAfterStop(encryption: f.cipher)
    XCTAssertEqual(pending.phase, .incomplete)
    XCTAssertEqual(pending.committedChunks, 1)
    XCTAssertEqual(pending.completionIntent, original.completionIntent)
    await rejected { try await restarted.sealForUpload(encryption: f.cipher, lease: f.lease) }
    await rejected { try await restarted.beginSource(checkpoint: UUID()) }
    await rejected { try await restarted.finishSource(checkpoint: UUID(), encryption: f.cipher,
      chunks: 1, plaintextBytes: 320_044) }
    let reopened = try await restarted.open()
    XCTAssertEqual(reopened.phase, .incomplete)
  }

  func testVerifiedSourceClearAllowsNormalReopenAndLegacyJournalShape() async throws {
    let f = try Fixture(), owner = f.owner, checkpoint = UUID()
    _ = try await owner.open()
    _ = try await owner.beginSource(checkpoint: checkpoint)
    _ = try await f.record([160])
    await rejected { try await owner.finishSource(checkpoint: checkpoint, encryption: f.cipher,
      chunks: 2, plaintextBytes: 408) }
    let closed = try await owner.finishSource(checkpoint: checkpoint, encryption: f.cipher,
      chunks: 1, plaintextBytes: 204)
    XCTAssertEqual(closed.phase, .open)
    let raw = try JSONSerialization.jsonObject(with: f.records.rows[f.records.flowKey]!.data) as! [String: Any]
    XCTAssertNil(raw["sourceCheckpoint"])
    XCTAssertEqual(raw["schemaVersion"] as? Int, 1)
    assertSnapshot(try await f.owner.open(), closed)
    let sealed = try await f.owner.sealForUpload(encryption: f.cipher, lease: f.lease)
    XCTAssertEqual(sealed.phase, .sealed)
  }

  func testCheckpointWriteFailureAndLostClearReplyRemainFailClosed() async throws {
    let f = try Fixture(), owner = f.owner, checkpoint = UUID()
    _ = try await owner.open()
    f.records.failBefore = true
    await rejected { try await owner.beginSource(checkpoint: checkpoint) }
    f.records.failBefore = false
    let notMarked = try await owner.open()
    XCTAssertEqual(notMarked.phase, .open)
    _ = try await owner.beginSource(checkpoint: checkpoint)
    _ = try await f.record([160])
    f.records.failAfter = true
    f.records.hideFailedWrite = true
    await rejected { try await owner.finishSource(checkpoint: checkpoint, encryption: f.cipher,
      chunks: 1, plaintextBytes: 204) }
    f.records.failAfter = false
    f.records.failRead = false
    await rejected { try await owner.finishSource(checkpoint: UUID(), encryption: f.cipher,
      chunks: 1, plaintextBytes: 204) }
    let cleared = try await owner.finishSource(checkpoint: checkpoint, encryption: f.cipher,
      chunks: 1, plaintextBytes: 204)
    XCTAssertEqual(cleared.phase, .open)
    assertSnapshot(try await f.owner.open(), cleared)
  }

  func testCreateBeforeKeyWorkAndReopenStableIntent() async throws {
    let f = try Fixture()
    let owner = f.owner
    let first = try await owner.open()
    XCTAssertEqual(first.phase, .open)
    XCTAssertEqual(first.committedChunks, 0)
    assertSnapshot(try await f.owner.open(), first)
    XCTAssertEqual(f.records.rows[f.records.flowKey]?.revision, 1)
  }

  func testUnknownExistingQueueIsNeverAdoptedAsFreshFlow() async throws {
    let f = try Fixture()
    _ = try await f.record([160])
    let before = f.records.rows.mapValues(\.data)
    await rejected { try await f.owner.open() }
    XCTAssertEqual(f.records.rows.mapValues(\.data), before)
  }

  func testCrashAfterCiphertextCommitRecoversExactCountsAndSameKey() async throws {
    let f = try Fixture()
    let initial = try await f.owner.open()
    let key = f.keys.value
    _ = try await f.record([320_000, 16_000])
    let saved = try await f.owner.reconcileAfterStop(encryption: f.cipher)
    XCTAssertEqual(saved.completionIntent, initial.completionIntent)
    XCTAssertEqual(saved.committedChunks, 2)
    XCTAssertEqual(saved.committedPlaintextBytes, 336_088)
    XCTAssertEqual(f.keys.value, key)
    assertSnapshot(try await f.owner.reconcileAfterStop(encryption: f.cipher), saved)
    XCTAssertEqual(f.records.rows[f.records.flowKey]?.revision, 2)
  }

  func testSealSurvivesUploadPurgeAndFreezesCompletionPayload() async throws {
    let f = try Fixture()
    _ = try await f.owner.open()
    _ = try await f.record([160])
    let sealed = try await f.owner.sealForUpload(encryption: f.cipher, lease: f.lease)
    XCTAssertEqual(sealed.phase, .sealed)
    let prefix = f.scope.queuePrefix(recoveryScope: f.recovery)
    for key in Array(f.records.rows.keys).filter({ $0.hasPrefix(prefix) }) {
      f.records.rows.removeValue(forKey: key)
    }
    f.records.listFails = true  // Sealed recovery must not require deleted audio.
    let changed = try NativeRecordingLease(
      receiptID: UUID(), leaseID: f.lease.leaseID, sessionID: f.scope.sessionID,
      generation: 2, issuedAt: "2026-09-26T00:10:00Z", expiresAt: "2026-09-26T00:25:00Z")
    assertSnapshot(try await f.owner.open(), sealed)
    assertSnapshot(try await f.owner.sealForUpload(encryption: f.cipher, lease: changed), sealed)
    assertSnapshot(try await f.owner.reconcileAfterStop(encryption: f.cipher), sealed)
  }

  func testLostLocalWriteResultAcceptsOnlyExactCommittedSuccessor() async throws {
    let f = try Fixture()
    f.records.failAfter = true
    let opened = try await f.owner.open()
    f.records.failAfter = false
    _ = try await f.record([160])
    f.records.failAfter = true
    let sealed = try await f.owner.sealForUpload(encryption: f.cipher, lease: f.lease)
    XCTAssertEqual(sealed.completionIntent, opened.completionIntent)
    XCTAssertEqual(f.records.rows[f.records.flowKey]?.revision, 2)
    assertSnapshot(try await f.owner.open(), sealed)
  }

  func testMissingOrRolledBackCiphertextAndEarlyUploadFailClosed() async throws {
    for fault in [
      "missing", "gap", "uploaded", "changed-aad", "tag", "digest", "metadata", "foreign-key",
      "duplicate-key",
    ] {
      let f = try Fixture()
      _ = try await f.owner.open()
      let keys = try await f.record([160, 160])
      let original = try await f.owner.reconcileAfterStop(encryption: f.cipher)
      switch fault {
      case "missing": f.records.rows.removeValue(forKey: keys[1])
      case "gap": f.records.rows.removeValue(forKey: keys[0])
      case "foreign-key": f.records.additions = ["another-scope"]
      case "duplicate-key": f.records.additions = [keys[0]]
      default:
        try f.records.edit(keys[0]) { value in
          switch fault {
          case "uploaded": value["state"] = "uploaded"
          case "metadata": value["uploadUrl"] = "forbidden-fixture"
          case "changed-aad":
            var reservation = value["reservation"] as! [String: Any]
            reservation["additionalAuthenticatedData"] = nativeBase64URL(Data("wrong-scope".utf8))
            value["reservation"] = reservation
          case "tag":
            var envelope = nativeBase64URLDecode(value["envelope"] as! String)!
            envelope[envelope.count - 1] ^= 1
            value["envelope"] = nativeBase64URL(envelope)
            value["sha256"] = SHA256.hash(data: envelope).map { String(format: "%02x", $0) }
              .joined()
          default: value["sha256"] = String(repeating: "0", count: 64)
          }
        }
      }
      let before = f.records.rows.mapValues(\.data)
      await rejected { try await f.owner.reconcileAfterStop(encryption: f.cipher) }
      XCTAssertEqual(f.records.rows.mapValues(\.data), before, fault)
      assertSnapshot(try await f.owner.open(), original)
    }
  }

  func testInvalidJournalOrChangedAccountCannotAdvance() async throws {
    for fault in [
      "account", "recovery", "extra", "boolean-count", "negative", "null-lease", "oversized-count",
      "unbalanced-bytes",
    ] {
      let f = try Fixture()
      _ = try await f.owner.open()
      try f.records.edit(f.records.flowKey) { value in
        switch fault {
        case "account": value["account"] = String(repeating: "b", count: 64)
        case "recovery": value["recovery"] = UUID().uuidString
        case "extra": value["token"] = "forbidden-fixture"
        case "boolean-count": value["chunks"] = true
        case "negative": value["plaintextBytes"] = -1
        case "null-lease": value["completionLease"] = NSNull()
        case "oversized-count": value["chunks"] = 2049
        default: value["plaintextBytes"] = 100
        }
      }
      await rejected { try await f.owner.open() }
    }
    let f = try Fixture()
    let original = try await f.owner.open()
    await f.service.configure(changed: true)
    await rejected { try await f.owner.open() }
    await rejected { try await f.owner.sealForUpload(encryption: f.cipher, lease: f.lease) }
    await f.service.configure()
    assertSnapshot(try await f.owner.open(), original)
  }

  func testThreeHourRecoveryStreamsAndAuthenticatesEveryPacket() async throws {
    let f = try Fixture()
    let records = StreamingRecords(cipher: f.cipher, recovery: f.recovery)
    let owner = NativeRecordingFlowOwner(
      scope: f.scope, recoveryScope: f.recovery, service: f.service, records: records)
    let initial = try await owner.open()
    records.enable()
    let recovered = try await owner.reconcileAfterStop(encryption: f.cipher)
    XCTAssertEqual(recovered.completionIntent, initial.completionIntent)
    XCTAssertEqual(recovered.committedChunks, 1080)
    XCTAssertEqual(recovered.committedPlaintextBytes, 345_647_520)
    XCTAssertEqual(records.readCount, 1080)
    XCTAssertEqual(records.retained.count, 1)  // Only the durable metadata journal.
  }

  func testConcurrentOpenAndEmptyUploadCannotAdvance() async throws {
    let f = try Fixture()
    let owner = f.owner
    await f.service.configure(hold: true)
    let task = Task { try await owner.open() }
    while await f.service.waiting == nil { await Task.yield() }
    await rejected { try await owner.open() }
    await f.service.release()
    _ = try await task.value
    await rejected { try await owner.sealForUpload(encryption: f.cipher, lease: f.lease) }
    XCTAssertEqual(f.records.rows[f.records.flowKey]?.revision, 1)
  }
}
