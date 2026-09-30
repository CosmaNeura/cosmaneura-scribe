import Foundation
import XCTest

@testable import CosmaneuraNativeRecording

@MainActor final class NativeRecordingWindowTests: XCTestCase {
  private final class Records: NativeRecordingBindingRecordStore, NativeRecordingLeaseRecordStore,
    NativeRecordingRecordStore, @unchecked Sendable
  {
    let lock = NSLock()
    var rows: [String: NativeRecordingStoredRecord] = [:]
    var failurePrefix: String?
    var failureRevision: UInt64?
    var failAfterWrite = false
    func readBinding(key: String) -> NativeRecordingStoredRecord? { lock.withLock { rows[key] } }
    func readLease(key: String) -> NativeRecordingStoredRecord? { readBinding(key: key) }
    func read(key: String) throws -> NativeRecordingStoredRecord {
      guard let row = readBinding(key: key) else { throw NativeRecordingFailure.storageUnavailable }
      return row
    }
    func createBinding(key: String, data: Data) throws { try write(key, data, 0) }
    func createLease(key: String, data: Data) throws { try write(key, data, 0) }
    func compareAndSwapBinding(key: String, expectedRevision: UInt64, data: Data) throws {
      try write(key, data, expectedRevision)
    }
    func compareAndSwapLease(key: String, expectedRevision: UInt64, data: Data) throws {
      try write(key, data, expectedRevision)
    }
    func compareAndSwap(key: String, expectedRevision: UInt64, data: Data) throws {
      try write(key, data, expectedRevision)
    }
    func availableBytes() -> Int { 2_000_000_000 }
    func write(_ key: String, _ data: Data, _ previous: UInt64) throws {
      try lock.withLock {
        guard rows[key]?.revision ?? 0 == previous else {
          throw NativeRecordingFailure.storageUnavailable
        }
        let fail = failurePrefix.map(key.hasPrefix) == true && failureRevision == previous + 1
        if fail && !failAfterWrite { throw NativeRecordingFailure.storageUnavailable }
        rows[key] = NativeRecordingStoredRecord(data: data, revision: previous + 1)
        if fail { throw NativeRecordingFailure.storageUnavailable }
      }
    }
    var queue: [String: NativeRecordingStoredRecord] {
      rows.filter { $0.key.hasPrefix("scribe-provider-queue:") }
    }
  }

  private actor Service: NativeRecordingWindowService, NativeRecordingLeaseService,
    NativeRecordingReservationService, NativeRecordingResumeWindowService
  {
    let scope: NativeRecordingScope
    let records: Records
    var calls: [NativeRecordingWindowRequest] = []
    var saved: [UUID: NativeRecordingWindowReceipt] = [:]
    var resumeCalls: [NativeRecordingResumeWindowRequest] = []
    var resumeReceipts: [UUID: NativeRecordingResumeWindowReceipt] = [:]
    var legacyBinds = 0
    var leaseCalls = 0
    var reserveCalls = 0
    var fault = "none"
    var changed = false
    var suspended: CheckedContinuation<Void, Never>?
    var waiter: CheckedContinuation<Void, Never>?
    init(records: Records) throws {
      self.records = records
      scope = try NativeRecordingScope(
        tenantID: UUID(), sessionID: UUID(), workspaceID: UUID(),
        accountDigest: String(repeating: "a", count: 64))
    }
    func configure(_ value: String) { fault = value }
    func recordingScope() throws -> NativeRecordingScope {
      if changed {
        return try NativeRecordingScope(
          tenantID: UUID(), sessionID: scope.sessionID, workspaceID: scope.workspaceID,
          accountDigest: scope.accountDigest)
      }
      return scope
    }
    func publishedKey() throws -> NativeRecordingPublicKey {
      throw NativeRecordingFailure.invalidKey
    }
    func bind(key: NativeRecordingKeyReceipt, intent: UUID) -> NativeRecordingBindingAcknowledgement
    {
      legacyBinds += 1
      return NativeRecordingBindingAcknowledgement(
        sessionID: scope.sessionID, keyVersion: key.keyVersion)
    }
    func requestLease(previous: NativeRecordingLease?, intent: UUID) throws -> NativeRecordingLease
    {
      leaseCalls += 1
      throw NativeRecordingFailure.invalidBinding
    }
    func reserve(lease: NativeRecordingLease, first: Int, count: Int, intent: UUID) throws
      -> NativeRecordingReservationBatch
    {
      reserveCalls += 1
      throw NativeRecordingFailure.invalidBinding
    }
    func prepareInitialWindow(_ request: NativeRecordingWindowRequest) async throws
      -> NativeRecordingWindowReceipt
    {
      // The complete immutable request, including the DEK wrap and all keys,
      // must be durable before any simulated server mutation.
      let journals = records.rows.filter { $0.key.hasPrefix("scribe-native-initial-window:") }
      guard journals.count == 1, let row = journals.values.first, row.revision == 2,
        let object = try JSONSerialization.jsonObject(with: row.data) as? [String: Any],
        let raw = object["request"],
        try JSONDecoder().decode(
          NativeRecordingWindowRequest.self, from: JSONSerialization.data(withJSONObject: raw))
          == request
      else { throw NativeRecordingBindingFailure.invalidJournal }
      calls.append(request)
      if fault == "pause" {
        await withCheckedContinuation {
          suspended = $0
          waiter?.resume()
          waiter = nil
        }
      }
      if fault == "scope" { changed = true }
      if saved[request.bindIntent] == nil {
        let formatter = ISO8601DateFormatter()
        let issued = Date().addingTimeInterval(-2)
        let lease = try NativeRecordingLease(
          receiptID: UUID(), leaseID: UUID(), sessionID: scope.sessionID,
          generation: 1, issuedAt: formatter.string(from: issued),
          expiresAt: formatter.string(from: issued.addingTimeInterval(900)))
        let reservations = try (0..<request.count).map { sequence in
          let object = UUID()
          return try NativeRecordingReservation(
            scope: scope, objectID: object, sequence: sequence,
            additionalData: nativeBase64URL(
              scope.additionalData(objectID: object, sequence: sequence)), createdAt: lease.issuedAt
          )
        }
        let batch = NativeRecordingReservationBatch(
          batchID: UUID(), sessionID: scope.sessionID,
          authorizedUntil: lease.expiresAt,
          reservations: fault == "count" ? Array(reservations.dropLast()) : reservations)
        saved[request.bindIntent] = NativeRecordingWindowReceipt(
          sessionID: fault == "session" ? UUID() : scope.sessionID,
          keyVersion: request.keyVersion, lease: lease, batch: batch)
      }
      if fault == "lost" { throw NativeRecordingFailure.storageUnavailable }
      return saved[request.bindIntent]!
    }
    func prepareResumeWindow(_ request: NativeRecordingResumeWindowRequest) async throws
      -> NativeRecordingResumeWindowReceipt
    {
      let rows = records.rows.filter { $0.key.hasPrefix("scribe-native-resume-window:") }
      guard rows.count == 1, let row = rows.values.first, row.revision % 3 == 1,
        let json = try JSONSerialization.jsonObject(with: row.data) as? [String: Any],
        let raw = json["request"],
        try JSONDecoder().decode(
          NativeRecordingResumeWindowRequest.self, from: JSONSerialization.data(withJSONObject: raw)
        ) == request
      else { throw NativeRecordingBindingFailure.invalidJournal }
      resumeCalls.append(request)
      if fault == "pause" {
        await withCheckedContinuation {
          suspended = $0
          waiter?.resume()
          waiter = nil
        }
      }
      if fault == "scope" { changed = true }
      if resumeReceipts[request.intent] == nil {
        let previous = request.previous
        let formatter = ISO8601DateFormatter()
        let prior = NativeRecordingLease.date(previous.expiresAt)!
        let lease = try NativeRecordingLease(
          receiptID: UUID(), leaseID: previous.leaseID,
          sessionID: fault == "session" ? UUID() : scope.sessionID,
          generation: previous.generation + 1,
          issuedAt: formatter.string(from: prior.addingTimeInterval(-10)),
          expiresAt: formatter.string(from: prior.addingTimeInterval(890)))
        let count = min(30, 2048 - request.first)
        let reservations = try (request.first..<(request.first + count)).map { sequence in
          let object = UUID()
          return try NativeRecordingReservation(
            scope: scope, objectID: object, sequence: sequence,
            additionalData: nativeBase64URL(
              scope.additionalData(objectID: object, sequence: sequence)), createdAt: lease.issuedAt
          )
        }
        let batch = NativeRecordingReservationBatch(
          batchID: UUID(), sessionID: scope.sessionID,
          authorizedUntil: lease.expiresAt, reservations: reservations)
        resumeReceipts[request.intent] = NativeRecordingResumeWindowReceipt(
          lease: lease, batch: batch)
      }
      if fault == "lost" { throw NativeRecordingFailure.storageUnavailable }
      return resumeReceipts[request.intent]!
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
  private let key = NativeRecordingKeyReceipt(
    keyVersion: "synthetic-key-v1", wrappedDEK: String(repeating: "A", count: 512))
  private func owner(_ service: Service, _ records: Records) -> NativeRecordingWindowOwner {
    NativeRecordingWindowOwner(
      scope: service.scope, recoveryScope: recovery, service: service, records: records)
  }
  private func rejected<T>(_ action: () async throws -> T) async {
    do {
      _ = try await action()
      XCTFail("must retain request and fail closed")
    } catch {}
  }
  private func adopt(_ owner: NativeRecordingWindowOwner, _ service: Service, _ records: Records)
    async throws -> (NativeRecordingLeaseOwner, NativeRecordingReservationOwner)
  {
    let leases = NativeRecordingLeaseOwner(scope: service.scope, service: service, records: records)
    let reservations = NativeRecordingReservationOwner(
      scope: service.scope, recoveryScope: recovery, service: service, records: records)
    try await owner.adopt(leases: leases, reservations: reservations)
    return (leases, reservations)
  }

  func testLostResponseReopensExactRecipeThenAdoptsWithoutSeparateRequests() async throws {
    let records = Records()
    let service = try Service(records: records)
    let intent = UUID()
    let first = owner(service, records)
    try await first.initialize()
    await service.configure("lost")
    await rejected { try await first.bind(key: self.key, intent: intent) }
    XCTAssertTrue(records.queue.isEmpty)
    await service.configure("none")
    let second = owner(service, records)
    try await second.initialize()
    let acknowledgement = try await second.bind(key: key, intent: intent)
    XCTAssertEqual(acknowledgement.sessionID, service.scope.sessionID)
    let (leases, reservations) = try await adopt(second, service, records)
    let lease = try await leases.open()
    let reuse = try await reservations.reuseForStart(lease: lease, first: 0)
    XCTAssertEqual(reuse?.reservations.count, 30)
    let queue = records.queue
    let reopened = owner(service, records)
    try await reopened.initialize()
    _ = try await reopened.bind(key: key, intent: intent)
    _ = try await adopt(reopened, service, records)
    XCTAssertEqual(records.queue.mapValues(\.data), queue.mapValues(\.data))
    let calls = await service.calls
    XCTAssertEqual(calls.count, 2)
    XCTAssertEqual(calls[0], calls[1])
    XCTAssertEqual(calls[0].binding, key)
    let counts = await (service.legacyBinds, service.leaseCalls, service.reserveCalls)
    XCTAssertEqual(counts.0 + counts.1 + counts.2, 0)
  }

  func testEveryDurableBoundaryCanRecoverWithoutChangingRecipeOrQueueKeys() async throws {
    for (prefix, revision) in [
      ("scribe-native-initial-window:", 2), ("scribe-native-initial-window:", 3),
      ("scribe-native-initial-window:", 4), ("scribe-native-lease:", 1),
      ("scribe-native-lease:", 2),
      ("scribe-native-reservations:", 1), ("scribe-native-reservations:", 2),
      ("scribe-native-reservations:", 3),
      ("scribe-provider-queue:", 1),
    ] {
      for after in [false, true] {
        let records = Records()
        let service = try Service(records: records)
        let intent = UUID()
        let first = owner(service, records)
        try await first.initialize()
        records.failurePrefix = prefix
        records.failureRevision = UInt64(revision)
        records.failAfterWrite = after
        do {
          _ = try await first.bind(key: key, intent: intent)
          _ = try await adopt(first, service, records)
        } catch { XCTAssertFalse(after, "a confirmed exact write must recover") }
        let retainedQueue = records.queue
        records.failurePrefix = nil
        let reopened = owner(service, records)
        try await reopened.initialize()
        _ = try await reopened.bind(key: key, intent: intent)
        _ = try await adopt(reopened, service, records)
        XCTAssertEqual(records.queue.count, 30)
        for (name, row) in retainedQueue { XCTAssertEqual(records.rows[name]?.data, row.data) }
        let calls = await service.calls
        if let first = calls.first { XCTAssertTrue(calls.allSatisfy { $0 == first }) }
        let legacy = await service.legacyBinds
        XCTAssertEqual(legacy, 0)
      }
    }
  }

  func testLegacyJournalsDoNotSwitchToAggregate() async throws {
    for prefix in ["scribe-native-binding:v1:", "scribe-native-lease:v1:"] {
      let records = Records()
      let service = try Service(records: records)
      records.rows[prefix + service.scope.keyAccount] = NativeRecordingStoredRecord(
        data: Data("legacy-owned-record".utf8), revision: 1)
      let fresh = owner(service, records)
      try await fresh.initialize()
      _ = try await fresh.bind(key: key, intent: UUID())
      _ = try await adopt(fresh, service, records)
      let calls = await service.calls
      let binds = await service.legacyBinds
      XCTAssertTrue(calls.isEmpty)
      XCTAssertEqual(binds, 1)
    }
  }

  func testChangedRecipeMalformedJournalAndBadReplyDoNotAdopt() async throws {
    for fault in ["session", "count", "scope", "changed-wrap", "unknown-field", "revision"] {
      let records = Records()
      let service = try Service(records: records)
      let intent = UUID()
      let first = owner(service, records)
      try await first.initialize()
      await service.configure(
        ["changed-wrap", "unknown-field", "revision"].contains(fault) ? "lost" : fault)
      await rejected { try await first.bind(key: self.key, intent: intent) }
      if fault == "changed-wrap" {
        await service.configure("none")
        await rejected {
          try await first.bind(
            key: NativeRecordingKeyReceipt(
              keyVersion: self.key.keyVersion, wrappedDEK: String(repeating: "B", count: 512)),
            intent: intent)
        }
      } else if fault == "unknown-field" || fault == "revision" {
        let name = try XCTUnwrap(
          records.rows.keys.first { $0.hasPrefix("scribe-native-initial-window:") })
        let row = try XCTUnwrap(records.rows[name])
        var json = try JSONSerialization.jsonObject(with: row.data) as! [String: Any]
        if fault == "unknown-field" { json["unexpected"] = "reject" }
        records.rows[name] = NativeRecordingStoredRecord(
          data: try JSONSerialization.data(
            withJSONObject: json, options: [.sortedKeys, .withoutEscapingSlashes]),
          revision: fault == "revision" ? 3 : row.revision)
        await rejected { try await self.owner(service, records).initialize() }
      }
      XCTAssertTrue(records.queue.isEmpty)
      XCTAssertFalse(records.rows.keys.contains { $0.hasPrefix("scribe-native-lease:") })
    }
  }

  func testCancellationAndOverlapRetainExactRequest() async throws {
    let records = Records()
    let service = try Service(records: records)
    let intent = UUID()
    let first = owner(service, records)
    try await first.initialize()
    await service.configure("pause")
    let pending = Task { try await first.bind(key: key, intent: intent) }
    await service.waitUntilSuspended()
    await rejected { try await first.bind(key: self.key, intent: intent) }
    pending.cancel()
    await service.resume()
    await rejected { try await pending.value }
    XCTAssertTrue(records.queue.isEmpty)
    await service.configure("none")
    let reopened = owner(service, records)
    try await reopened.initialize()
    _ = try await reopened.bind(key: key, intent: intent)
    _ = try await adopt(reopened, service, records)
    let calls = await service.calls
    XCTAssertEqual(calls.count, 2)
    XCTAssertEqual(calls[0], calls[1])
  }
  private func resumeOwner(_ service: Service, _ records: Records)
    -> NativeRecordingResumeWindowOwner
  {
    NativeRecordingResumeWindowOwner(
      scope: service.scope, recoveryScope: recovery, service: service, records: records)
  }
  private func initialLease(_ service: Service) throws -> NativeRecordingLease {
    let formatter = ISO8601DateFormatter()
    let issued = Date().addingTimeInterval(-880)
    return try NativeRecordingLease(
      receiptID: UUID(), leaseID: UUID(), sessionID: service.scope.sessionID,
      generation: 1, issuedAt: formatter.string(from: issued),
      expiresAt: formatter.string(from: issued.addingTimeInterval(900)))
  }

  func testResumeLostReplyAndEveryPartialAdoptionRecoverBeforeAnyLegacyRequest() async throws {
    for boundary in [
      "lost", "lease-3", "lease-4", "reserve-1", "reserve-2", "reserve-3", "aggregate-3",
    ] {
      let records = Records()
      let service = try Service(records: records)
      let lease = try initialLease(service)
      let leases = NativeRecordingLeaseOwner(
        scope: service.scope, service: service, records: records)
      let reservations = NativeRecordingReservationOwner(
        scope: service.scope, recoveryScope: recovery, service: service, records: records)
      try await leases.adoptInitial(lease, intent: UUID())
      if boundary == "lost" {
        await service.configure("lost")
      } else {
        let parts = boundary.split(separator: "-")
        records.failurePrefix =
          parts[0] == "lease"
          ? "scribe-native-lease:"
          : parts[0] == "reserve" ? "scribe-native-reservations:" : "scribe-native-resume-window:"
        records.failureRevision = UInt64(parts[1])!
      }
      await rejected {
        try await self.resumeOwner(service, records).prepare(
          previous: lease, first: 7, leases: leases, reservations: reservations)
      }
      let oldKeys = records.queue.mapValues(\.data)
      records.failurePrefix = nil
      await service.configure("none")
      let freshLeases = NativeRecordingLeaseOwner(
        scope: service.scope, service: service, records: records)
      let freshReservations = NativeRecordingReservationOwner(
        scope: service.scope, recoveryScope: recovery, service: service, records: records)
      let owner = resumeOwner(service, records)
      let result = try await owner.recover(
        first: 7, leases: freshLeases, reservations: freshReservations)
      let recovered = try XCTUnwrap(result)
      XCTAssertEqual(recovered.lease.generation, 2)
      let savedLease = try await freshLeases.open()
      XCTAssertEqual(savedLease, recovered.lease)
      for (key, value) in oldKeys { XCTAssertEqual(records.queue[key]?.data, value) }
      let again = try await owner.recover(
        first: 7, leases: freshLeases, reservations: freshReservations)
      XCTAssertNil(again)
      let calls = await service.resumeCalls
      XCTAssertEqual(calls.count, boundary == "lost" ? 2 : 1)
      XCTAssertTrue(calls.allSatisfy { $0 == calls[0] })
      let counts = await (service.leaseCalls, service.reserveCalls)
      XCTAssertEqual(counts.0 + counts.1, 0)
    }
  }

  func testResumeNeverOverwritesExistingLegacyRenewalIntent() async throws {
    let records = Records()
    let service = try Service(records: records)
    let lease = try initialLease(service)
    let leases = NativeRecordingLeaseOwner(scope: service.scope, service: service, records: records)
    let reservations = NativeRecordingReservationOwner(
      scope: service.scope, recoveryScope: recovery, service: service, records: records)
    try await leases.adoptInitial(lease, intent: UUID())
    await rejected { try await leases.renew() }
    let before = try XCTUnwrap(records.rows["scribe-native-lease:v1:" + service.scope.keyAccount])
    await rejected {
      try await self.resumeOwner(service, records).prepare(
        previous: lease, first: 7, leases: leases, reservations: reservations)
    }
    XCTAssertEqual(
      records.rows["scribe-native-lease:v1:" + service.scope.keyAccount]?.data, before.data)
    let calls = await service.resumeCalls
    XCTAssertTrue(calls.isEmpty)
    XCTAssertTrue(records.queue.isEmpty)
  }

  func testSuccessiveResumeRequestsAdvanceOnlyAfterPriorAdoption() async throws {
    let records = Records()
    let service = try Service(records: records)
    let lease = try initialLease(service)
    let leases = NativeRecordingLeaseOwner(scope: service.scope, service: service, records: records)
    let reservations = NativeRecordingReservationOwner(
      scope: service.scope, recoveryScope: recovery, service: service, records: records)
    try await leases.adoptInitial(lease, intent: UUID())
    let owner = resumeOwner(service, records)
    let first = try await owner.prepare(
      previous: lease, first: 7, leases: leases, reservations: reservations)
    let second = try await owner.prepare(
      previous: first.lease, first: 37, leases: leases, reservations: reservations)
    XCTAssertEqual(second.lease.generation, 3)
    let saved = records.rows.values.filter {
      (try? JSONSerialization.jsonObject(with: $0.data) as? [String: Any])?["ordinal"] != nil
    }
    XCTAssertEqual(saved.first?.revision, 6)
    let calls = await service.resumeCalls
    XCTAssertEqual(calls.count, 2)
    XCTAssertNotEqual(calls[0].intent, calls[1].intent)
  }

  func testResumeCancellationScopeChangeAndChangedPositionCannotAdopt() async throws {
    for fault in ["scope", "session", "position", "pause"] {
      let records = Records()
      let service = try Service(records: records)
      let lease = try initialLease(service)
      let leases = NativeRecordingLeaseOwner(
        scope: service.scope, service: service, records: records)
      let reservations = NativeRecordingReservationOwner(
        scope: service.scope, recoveryScope: recovery, service: service, records: records)
      try await leases.adoptInitial(lease, intent: UUID())
      await service.configure(fault == "position" ? "lost" : fault)
      let owner = resumeOwner(service, records)
      let pending = Task {
        try await owner.prepare(
          previous: lease, first: 7, leases: leases, reservations: reservations)
      }
      if fault == "pause" {
        await service.waitUntilSuspended()
        pending.cancel()
        await service.resume()
      }
      await rejected { try await pending.value }
      if fault == "position" {
        await service.configure("none")
        await rejected {
          try await owner.recover(first: 8, leases: leases, reservations: reservations)
        }
      }
      XCTAssertTrue(records.queue.isEmpty)
      XCTAssertEqual(
        records.rows["scribe-native-lease:v1:" + service.scope.keyAccount]?.revision, 2)
    }
  }

}
