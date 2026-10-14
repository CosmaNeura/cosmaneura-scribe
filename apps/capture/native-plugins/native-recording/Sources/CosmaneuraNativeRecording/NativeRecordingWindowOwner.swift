import Foundation

public struct NativeRecordingWindowRequest: Codable, Equatable, Sendable {
  public let keyVersion: String
  public let wrappedDEK: String
  public let bindIntent: UUID
  public let leaseIntent: UUID
  public let reserveIntent: UUID
  public let count: Int
  public init(
    keyVersion: String, wrappedDEK: String, bindIntent: UUID, leaseIntent: UUID,
    reserveIntent: UUID, count: Int
  ) {
    self.keyVersion = keyVersion
    self.wrappedDEK = wrappedDEK
    self.bindIntent = bindIntent
    self.leaseIntent = leaseIntent
    self.reserveIntent = reserveIntent
    self.count = count
  }
  public var binding: NativeRecordingKeyReceipt {
    NativeRecordingKeyReceipt(keyVersion: keyVersion, wrappedDEK: wrappedDEK)
  }
}

public struct NativeRecordingWindowReceipt: Codable, Equatable, Sendable {
  public let sessionID: UUID
  public let keyVersion: String
  public let lease: NativeRecordingLease
  public let batch: NativeRecordingReservationBatch
  public init(
    sessionID: UUID, keyVersion: String, lease: NativeRecordingLease,
    batch: NativeRecordingReservationBatch
  ) {
    self.sessionID = sessionID
    self.keyVersion = keyVersion
    self.lease = lease
    self.batch = batch
  }
}

public protocol NativeRecordingWindowService: NativeRecordingBindingService {
  func prepareInitialWindow(_ request: NativeRecordingWindowRequest) async throws
    -> NativeRecordingWindowReceipt
  func prepareFreshInitialWindow(_ request: NativeRecordingWindowRequest,
    proof: NativeRecordingFreshInitialWindow) async throws -> NativeRecordingWindowReceipt
}

extension NativeRecordingWindowService {
  public func prepareFreshInitialWindow(_ request: NativeRecordingWindowRequest,
    proof: NativeRecordingFreshInitialWindow) async throws -> NativeRecordingWindowReceipt {
    try await prepareInitialWindow(request)
  }
}

public struct NativeRecordingFreshFlow: Sendable {
  let scope: NativeRecordingScope
  let recovery: UUID
  init(scope: NativeRecordingScope, recovery: UUID) { self.scope = scope; self.recovery = recovery }
}

/// No public constructor, Codable conformance or bridge representation. Created
/// only after new empty flow/window journals and a successful new key insert.
public struct NativeRecordingFreshInitialWindow: Sendable {
  let scope: NativeRecordingScope
  let request: NativeRecordingWindowRequest
  let recovery: UUID
  init(scope: NativeRecordingScope, request: NativeRecordingWindowRequest, recovery: UUID) {
    self.scope = scope; self.request = request; self.recovery = recovery
  }
  public func matches(scope: NativeRecordingScope, request: NativeRecordingWindowRequest) -> Bool {
    self.scope == scope && self.request == request && request.count == 30
  }
  public func matches(scope: NativeRecordingScope, request: NativeRecordingWindowRequest, recoveryScope: UUID) -> Bool {
    matches(scope: scope, request: request) && recovery == recoveryScope
  }
}

/// Fresh native visits collapse bind/lease/reserve into one authenticated request.
/// The existing binding owner still owns key custody. This marker and complete
/// recipe precede dispatch; old journals never silently switch recovery protocols.
public actor NativeRecordingWindowOwner: NativeRecordingBindingService {
  private struct Journal: Codable {
    let schemaVersion: Int
    let account: String
    let recovery: UUID
    let leaseIntent: UUID
    let reserveIntent: UUID
    var request: NativeRecordingWindowRequest?
    var receipt: NativeRecordingWindowReceipt?
    var adopted: Bool
    var revision: UInt64 { adopted ? 4 : receipt != nil ? 3 : request != nil ? 2 : 1 }
  }
  private let scope: NativeRecordingScope
  private let recovery: UUID
  private let service: any NativeRecordingWindowService
  private let records: any NativeRecordingBindingRecordStore & NativeRecordingLeaseRecordStore
  private let key: String
  private var initialized = false
  private var busy = false
  private var createdEmptyWindow = false

  public init(
    scope: NativeRecordingScope, recoveryScope: UUID,
    service: any NativeRecordingWindowService,
    records: any NativeRecordingBindingRecordStore & NativeRecordingLeaseRecordStore
  ) {
    self.scope = scope
    recovery = recoveryScope
    self.service = service
    self.records = records
    key =
      "scribe-native-initial-window:v1:\(scope.keyAccount):\(recoveryScope.uuidString.lowercased())"
  }

  public func initialize(freshFlow: NativeRecordingFreshFlow? = nil) async throws {
    guard !busy else { throw NativeRecordingBindingFailure.operationInProgress }
    busy = true
    defer { busy = false }
    createdEmptyWindow = false
    try await checkScope()
    if let saved = try records.readBinding(key: key) {
      _ = try decode(saved)
    } else if try records.readBinding(key: "scribe-native-binding:v1:\(scope.keyAccount)") == nil,
      try records.readLease(key: "scribe-native-lease:v1:\(scope.keyAccount)") == nil
    {
      let cleanCreation = try commit(
        Journal(
          schemaVersion: 1, account: scope.keyAccount, recovery: recovery,
          leaseIntent: UUID(), reserveIntent: UUID(), adopted: false), after: 0)
      createdEmptyWindow = cleanCreation && freshFlow?.scope == scope && freshFlow?.recovery == recovery
    }
    initialized = true
  }
  public func recordingScope() async throws -> NativeRecordingScope {
    try await service.recordingScope()
  }
  public func publishedKey() async throws -> NativeRecordingPublicKey {
    try await service.publishedKey()
  }
  public func abandonFreshInitialWindow() async {
    createdEmptyWindow = false
    await service.abandonFreshInitialWindow()
  }

  public func bind(key binding: NativeRecordingKeyReceipt, intent: UUID) async throws
    -> NativeRecordingBindingAcknowledgement
  {
    try await bindCandidate(key: binding, intent: intent, proof: nil)
  }
  public func bindNewCandidate(key binding: NativeRecordingKeyReceipt, intent: UUID,
    proof: NativeRecordingFreshBinding) async throws -> NativeRecordingBindingAcknowledgement {
    try await bindCandidate(key: binding, intent: intent, proof: proof)
  }
  private func bindCandidate(key binding: NativeRecordingKeyReceipt, intent: UUID,
    proof: NativeRecordingFreshBinding?) async throws -> NativeRecordingBindingAcknowledgement {
    guard initialized, !busy else { throw NativeRecordingBindingFailure.operationInProgress }
    busy = true
    defer { busy = false }
    let fresh = createdEmptyWindow
    createdEmptyWindow = false
    try await checkScope()
    guard let saved = try records.readBinding(key: key) else {
      return try await service.bind(key: binding, intent: intent)
    }
    var journal = try decode(saved)
    var eligible = fresh && journal.request == nil && journal.receipt == nil && !journal.adopted
      && proof?.scope == scope && proof?.intent == intent && proof?.receipt == binding
    let request = NativeRecordingWindowRequest(
      keyVersion: binding.keyVersion,
      wrappedDEK: binding.wrappedDEK, bindIntent: intent, leaseIntent: journal.leaseIntent,
      reserveIntent: journal.reserveIntent, count: 30)
    if journal.request == nil {
      journal.request = request
      let cleanRequestWrite = try commit(journal, after: 1)
      eligible = eligible && cleanRequestWrite
    }
    guard journal.request == request else { throw NativeRecordingBindingFailure.journalConflict }
    if journal.receipt == nil {
      let receipt: NativeRecordingWindowReceipt
      if eligible {
        receipt = try await service.prepareFreshInitialWindow(request,
          proof: NativeRecordingFreshInitialWindow(scope: scope, request: request, recovery: recovery))
      } else {
        receipt = try await service.prepareInitialWindow(request)
      }
      try await checkScope()
      try validate(receipt, request: request)
      journal.receipt = receipt
      try commit(journal, after: 2)
    }
    guard let receipt = journal.receipt else { throw NativeRecordingBindingFailure.invalidJournal }
    return NativeRecordingBindingAcknowledgement(
      sessionID: receipt.sessionID, keyVersion: receipt.keyVersion)
  }

  /// Publish validated components into the unchanged durable owners before a
  /// source can be prepared. Every adoption is idempotent after a partial write.
  public func adopt(
    leases: NativeRecordingLeaseOwner, reservations: NativeRecordingReservationOwner
  ) async throws {
    guard initialized, !busy else { throw NativeRecordingBindingFailure.operationInProgress }
    busy = true
    defer { busy = false }
    try await checkScope()
    guard let saved = try records.readBinding(key: key) else { return }
    var journal = try decode(saved)
    if journal.adopted { return }
    guard let request = journal.request, let receipt = journal.receipt else {
      throw NativeRecordingBindingFailure.invalidJournal
    }
    try await leases.adoptInitial(receipt.lease, intent: request.leaseIntent)
    try await checkScope()
    _ = try await reservations.adoptPrepared(
      lease: receipt.lease, batch: receipt.batch,
      intent: request.reserveIntent)
    try await checkScope()
    journal.adopted = true
    try commit(journal, after: 3)
  }

  private func checkScope() async throws {
    try Task.checkCancellation()
    guard try await service.recordingScope() == scope else {
      throw NativeRecordingBindingFailure.authorityChanged
    }
    try Task.checkCancellation()
  }
  private func validate(
    _ receipt: NativeRecordingWindowReceipt, request: NativeRecordingWindowRequest
  ) throws {
    guard receipt.sessionID == scope.sessionID, receipt.keyVersion == request.keyVersion,
      receipt.lease.generation == 1
    else { throw NativeRecordingBindingFailure.receiptMismatch }
    try receipt.batch.validate(scope: scope, lease: receipt.lease, first: 0, count: request.count)
  }
  private func encoded(_ value: Journal) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(value)
  }
  private func decode(_ record: NativeRecordingStoredRecord) throws -> Journal {
    guard record.data.count <= 131_072,
      let value = try? JSONDecoder().decode(Journal.self, from: record.data),
      value.schemaVersion == 1, value.account == scope.keyAccount, value.recovery == recovery,
      value.revision == record.revision, try encoded(value) == record.data,
      !value.adopted || value.receipt != nil, value.receipt == nil || value.request != nil
    else { throw NativeRecordingBindingFailure.invalidJournal }
    if let request = value.request {
      guard request.leaseIntent == value.leaseIntent, request.reserveIntent == value.reserveIntent,
        Set([request.bindIntent, request.leaseIntent, request.reserveIntent]).count == 3,
        request.count == 30,
        request.keyVersion.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
        request.wrappedDEK.utf8.count == 512,
        nativeBase64URLDecode(request.wrappedDEK)?.count == 384
      else { throw NativeRecordingBindingFailure.invalidJournal }
      if let receipt = value.receipt { try validate(receipt, request: request) }
    }
    return value
  }
  /// Exact readback preserves recovery, but only an exception-free write is fresh.
  @discardableResult
  private func commit(_ value: Journal, after revision: UInt64) throws -> Bool {
    try Task.checkCancellation()
    let data = try encoded(value)
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
      return false
    }
    return true
  }
}
