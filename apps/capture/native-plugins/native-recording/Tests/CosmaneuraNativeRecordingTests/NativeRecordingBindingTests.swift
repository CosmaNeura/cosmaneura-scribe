import Foundation
import Security
import XCTest

@testable import CosmaneuraNativeRecording

@MainActor
final class NativeRecordingBindingTests: XCTestCase {
  private final class Keys: NativeRecordingKeyStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    private var insertions = 0
    var count: Int { lock.withLock { insertions } }
    func read(account: String) throws -> Data? { lock.withLock { values[account] } }
    func insert(account: String, value: Data) throws {
      try lock.withLock {
        guard values[account] == nil else { throw NativeRecordingFailure.keyConflict }
        values[account] = value
        insertions += 1
      }
    }
    func loseCustody() { lock.withLock { values.removeAll() } }
  }

  private final class Records: NativeRecordingBindingRecordStore, @unchecked Sendable {
    private let lock = NSLock()
    private var rows: [String: NativeRecordingStoredRecord] = [:]
    private var faultRevision: UInt64?
    private var afterWrite = false
    private var readFailure = false
    private var divergentWrite = 0
    var snapshot: [String: NativeRecordingStoredRecord] { lock.withLock { rows } }
    func fault(at revision: UInt64?, after: Bool = false, divergent: Int = 0) {
      lock.withLock {
        faultRevision = revision
        afterWrite = after
        divergentWrite = divergent
      }
    }
    func failReads() { lock.withLock { readFailure = true } }
    func change(_ transform: (inout [String: NativeRecordingStoredRecord]) throws -> Void) rethrows
    {
      try lock.withLock { try transform(&rows) }
    }
    func readBinding(key: String) throws -> NativeRecordingStoredRecord? {
      try lock.withLock {
        if readFailure { throw NativeRecordingFailure.storageUnavailable }
        return rows[key]
      }
    }
    func createBinding(key: String, data: Data) throws {
      try write(key, data, prior: 0)
    }
    func compareAndSwapBinding(key: String, expectedRevision: UInt64, data: Data) throws {
      try write(key, data, prior: expectedRevision)
    }
    private func write(_ key: String, _ data: Data, prior: UInt64) throws {
      try lock.withLock {
        guard rows[key]?.revision ?? 0 == prior else {
          throw NativeRecordingFailure.storageUnavailable
        }
        let fail = faultRevision == prior + 1
        if fail && !afterWrite { throw NativeRecordingFailure.storageUnavailable }
        rows[key] = NativeRecordingStoredRecord(data: data, revision: prior + 1)
        if fail && divergentWrite != 0 {
          rows[key] = NativeRecordingStoredRecord(
            data: divergentWrite == 1 ? Data("conflicting commit".utf8) : data,
            revision: prior + (divergentWrite == 2 ? 2 : 1))
        }
        if fail { throw NativeRecordingFailure.storageUnavailable }
      }
    }
  }

  private actor Service: NativeRecordingBindingService {
    struct Call: Equatable, Sendable {
      let key: NativeRecordingKeyReceipt
      let intent: UUID
    }
    let scope: NativeRecordingScope
    let published: NativeRecordingPublicKey
    var scopeReplies: [NativeRecordingScope] = []
    var calls: [Call] = []
    var publishedReads = 0
    var failBind = false
    var wrongSession = false
    var wrongVersion = false
    var pause = false
    var suspended: CheckedContinuation<Void, Never>?
    var waiter: CheckedContinuation<Void, Never>?
    init(_ scope: NativeRecordingScope, _ published: NativeRecordingPublicKey) {
      self.scope = scope
      self.published = published
    }
    func configure(
      scopes: [NativeRecordingScope] = [], fail: Bool = false,
      otherSession: Bool = false, otherVersion: Bool = false, pauseScope: Bool = false
    ) {
      scopeReplies = scopes
      failBind = fail
      wrongSession = otherSession
      wrongVersion = otherVersion
      pause = pauseScope
    }
    func recordingScope() async throws -> NativeRecordingScope {
      if pause {
        pause = false
        await withCheckedContinuation { continuation in
          suspended = continuation
          waiter?.resume()
          waiter = nil
        }
      }
      return scopeReplies.isEmpty ? scope : scopeReplies.removeFirst()
    }
    func waitUntilSuspended() async {
      if suspended == nil {
        await withCheckedContinuation { waiter = $0 }
      }
    }
    func resume() {
      suspended?.resume()
      suspended = nil
    }
    func publishedKey() async throws -> NativeRecordingPublicKey {
      publishedReads += 1
      return published
    }
    func bind(key: NativeRecordingKeyReceipt, intent: UUID) async throws
      -> NativeRecordingBindingAcknowledgement
    {
      calls.append(Call(key: key, intent: intent))
      if failBind { throw NativeRecordingFailure.storageUnavailable }
      return NativeRecordingBindingAcknowledgement(
        sessionID: wrongSession ? UUID() : scope.sessionID,
        keyVersion: wrongVersion ? "wrong-version" : key.keyVersion)
    }
  }

  private func scope() throws -> NativeRecordingScope {
    try NativeRecordingScope(
      tenantID: UUID(), sessionID: UUID(), workspaceID: UUID(),
      accountDigest: String(repeating: "a", count: 64))
  }

  private func published() throws -> NativeRecordingPublicKey {
    let privateKey = try XCTUnwrap(
      SecKeyCreateRandomKey(
        [
          kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits: 3072,
          kSecAttrIsPermanent: false,
        ] as CFDictionary, nil))
    let publicKey = try XCTUnwrap(SecKeyCopyPublicKey(privateKey))
    let der = try XCTUnwrap(SecKeyCopyExternalRepresentation(publicKey, nil)) as Data
    return try NativeRecordingPublicKey(
      version: "synthetic-v1", modulusBase64URL: nativeBase64URL(der.subdata(in: 9..<393)))
  }

  private func owner(_ service: Service, _ records: Records, _ keys: Keys)
    -> NativeRecordingBindingOwner
  {
    NativeRecordingBindingOwner(
      scope: service.scope, service: service, records: records, keys: keys)
  }

  private func failure(_ operation: () async throws -> Void) async {
    do {
      try await operation()
      XCTFail("Expected failure")
    } catch {}
  }

  func testFreshBindAndRestartUseOneKeyOneIntentAndNoFurtherPublishedKeyFetch() async throws {
    let service = Service(try scope(), try published())
    let records = Records()
    let keys = Keys()
    let first = try await owner(service, records, keys).open()
    let retained = try XCTUnwrap(records.snapshot.values.first)
    XCTAssertEqual(retained.revision, 3)
    let reopened = try await owner(service, records, keys).open()
    XCTAssertEqual(reopened.receipt, first.receipt)
    XCTAssertEqual(records.snapshot.values.first?.data, retained.data)
    XCTAssertEqual(keys.count, 1)
    let calls = await service.calls
    let reads = await service.publishedReads
    XCTAssertEqual(calls.count, 1)
    XCTAssertEqual(reads, 1)
  }

  func testEveryLostJournalWriteResponseResolvesOnlyTheCommittedSuccessor() async throws {
    let published = try published()
    for revision: UInt64 in 1...3 {
      let service = Service(try scope(), published)
      let records = Records()
      let keys = Keys()
      records.fault(at: revision, after: true)
      _ = try await owner(service, records, keys).open()
      XCTAssertEqual(records.snapshot.values.first?.revision, 3)
      XCTAssertEqual(keys.count, 1)
      let calls = await service.calls
      XCTAssertEqual(calls.count, 1)
    }
  }

  func testCreateFailureNeverCreatesKeyOrDispatchesBind() async throws {
    let service = Service(try scope(), try published())
    let records = Records()
    let keys = Keys()
    records.fault(at: 1)
    await failure { _ = try await self.owner(service, records, keys).open() }
    XCTAssertTrue(records.snapshot.isEmpty)
    XCTAssertEqual(keys.count, 0)
    let calls = await service.calls
    XCTAssertTrue(calls.isEmpty)
  }

  func testAmbiguousCreateCannotAdoptDifferentDataOrRevision() async throws {
    let published = try published()
    for divergent in [1, 2] {
      let service = Service(try scope(), published)
      let records = Records()
      let keys = Keys()
      records.fault(at: 1, after: true, divergent: divergent)
      await failure { _ = try await self.owner(service, records, keys).open() }
      XCTAssertEqual(keys.count, 0)
      let calls = await service.calls
      XCTAssertTrue(calls.isEmpty)
      XCTAssertEqual(records.snapshot.count, 1)
    }
  }

  func testInterruptedCandidateCommitReusesRetainedIntentAndExactKeyOnRestart() async throws {
    let service = Service(try scope(), try published())
    let records = Records()
    let keys = Keys()
    records.fault(at: 2)
    await failure { _ = try await self.owner(service, records, keys).open() }
    XCTAssertEqual(records.snapshot.values.first?.revision, 1)
    XCTAssertEqual(keys.count, 1)
    let calls = await service.calls
    XCTAssertTrue(calls.isEmpty)
    let prepared = try XCTUnwrap(records.snapshot.values.first)
    let data = try XCTUnwrap(JSONSerialization.jsonObject(with: prepared.data) as? [String: Any])
    let intent = try XCTUnwrap(UUID(uuidString: XCTUnwrap(data["intent"] as? String)))
    records.fault(at: nil)
    _ = try await owner(service, records, keys).open()
    let recovered = await service.calls
    XCTAssertEqual(recovered.first?.intent, intent)
    XCTAssertEqual(keys.count, 1)
  }

  func testLostBindReplyAndFinalCommitFailureReplayExactCandidate() async throws {
    let published = try published()
    for failBind in [true, false] {
      let service = Service(try scope(), published)
      let records = Records()
      let keys = Keys()
      await service.configure(fail: failBind)
      if !failBind { records.fault(at: 3) }
      await failure { _ = try await self.owner(service, records, keys).open() }
      XCTAssertEqual(records.snapshot.values.first?.revision, 2)
      await service.configure()
      records.fault(at: nil)
      _ = try await owner(service, records, keys).open()
      let calls = await service.calls
      XCTAssertEqual(calls.count, 2)
      XCTAssertEqual(calls[0], calls[1])
      XCTAssertEqual(keys.count, 1)
    }
  }

  func testMissingCandidateOrBoundCustodyNeverGeneratesReplacement() async throws {
    let published = try published()
    for bound in [false, true] {
      let service = Service(try scope(), published)
      let records = Records()
      let keys = Keys()
      await service.configure(fail: !bound)
      if bound {
        _ = try await owner(service, records, keys).open()
      } else {
        await failure { _ = try await self.owner(service, records, keys).open() }
      }
      let retained = records.snapshot.values.first?.data
      keys.loseCustody()
      await service.configure()
      await failure { _ = try await self.owner(service, records, keys).open() }
      XCTAssertEqual(keys.count, 1)
      XCTAssertEqual(records.snapshot.values.first?.data, retained)
      let calls = await service.calls
      XCTAssertEqual(calls.count, 1)
    }
  }

  func testMissingJournalCannotAdoptExistingKeyAndUnreadableStoreIsNotAbsence() async throws {
    let service = Service(try scope(), try published())
    let records = Records()
    let keys = Keys()
    _ = try await owner(service, records, keys).open()
    records.change { $0.removeAll() }
    await failure { _ = try await self.owner(service, records, keys).open() }
    XCTAssertEqual(keys.count, 1)
    XCTAssertEqual(records.snapshot.values.first?.revision, 1)
    let unreadable = Records()
    let freshKeys = Keys()
    unreadable.failReads()
    await failure { _ = try await self.owner(service, unreadable, freshKeys).open() }
    XCTAssertEqual(freshKeys.count, 0)
    XCTAssertTrue(unreadable.snapshot.isEmpty)
    let calls = await service.calls
    XCTAssertEqual(calls.count, 1)
  }

  func testWrongAcknowledgementPreservesCandidateWithoutReturningCipher() async throws {
    let published = try published()
    for wrongSession in [false, true] {
      let service = Service(try scope(), published)
      let records = Records()
      let keys = Keys()
      await service.configure(otherSession: wrongSession, otherVersion: !wrongSession)
      await failure { _ = try await self.owner(service, records, keys).open() }
      XCTAssertEqual(records.snapshot.values.first?.revision, 2)
      XCTAssertEqual(keys.count, 1)
    }
  }

  func testAuthorityChangeBeforeCreateBeforeBindAndAfterBindFailsClosed() async throws {
    let published = try published()
    for checkpoint in 0...3 {
      let expected = try scope()
      let service = Service(expected, published)
      let records = Records()
      let keys = Keys()
      await service.configure(scopes: Array(repeating: expected, count: checkpoint) + [try scope()])
      await failure { _ = try await self.owner(service, records, keys).open() }
      XCTAssertEqual(keys.count, checkpoint < 2 ? 0 : 1)
      XCTAssertEqual(records.snapshot.values.first?.revision, checkpoint < 2 ? nil : 2)
      let calls = await service.calls
      XCTAssertEqual(calls.count, checkpoint == 3 ? 1 : 0)
    }
  }

  func testConcurrentCallAndCancellationCannotCrossSuspendedAuthorityCheck() async throws {
    let service = Service(try scope(), try published())
    let records = Records()
    let keys = Keys()
    let owner = owner(service, records, keys)
    await service.configure(pauseScope: true)
    let pending = Task { try await owner.open() }
    await service.waitUntilSuspended()
    do {
      _ = try await owner.open()
      XCTFail("Concurrent open must fail")
    } catch NativeRecordingBindingFailure.operationInProgress {} catch {
      XCTFail("Unexpected error")
    }
    pending.cancel()
    await service.resume()
    await failure { _ = try await pending.value }
    XCTAssertEqual(keys.count, 0)
    XCTAssertTrue(records.snapshot.isEmpty)
    // Cancellation releases the per-owner gate for an explicit later attempt.
    _ = try await owner.open()
    XCTAssertEqual(keys.count, 1)
  }

  func testCorruptCrossScopeUnknownFieldsAndRevisionMismatchPreserveJournal() async throws {
    let service = Service(try scope(), try published())
    let records = Records()
    let keys = Keys()
    _ = try await owner(service, records, keys).open()
    let original = try XCTUnwrap(records.snapshot.first)
    let value = try XCTUnwrap(
      JSONSerialization.jsonObject(with: original.value.data) as? [String: Any])
    for mode in 0..<7 {
      var fields = value
      switch mode {
      case 0: fields["account"] = String(repeating: "f", count: 64)
      case 1: fields["unknown"] = true
      case 2: fields["wrappedDEK"] = "corrupt"
      case 3: fields["schemaVersion"] = 2
      case 4: fields["bound"] = false
      case 5: fields["wrappedDEK"] = NSNull()
      default: fields["keyVersion"] = "invalid version"
      }
      let data = try JSONSerialization.data(withJSONObject: fields)
      records.change { $0[original.key] = NativeRecordingStoredRecord(data: data, revision: 3) }
      await failure { _ = try await self.owner(service, records, keys).open() }
      XCTAssertEqual(records.snapshot[original.key]?.data, data)
      XCTAssertEqual(keys.count, 1)
    }
    let calls = await service.calls
    XCTAssertEqual(calls.count, 1)
  }
}
