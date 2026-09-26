import Foundation

public enum NativeRecordingBindingFailure: Error {
  case operationInProgress, invalidJournal, journalConflict, authorityChanged, receiptMismatch
}

/// Atomic operations on the existing encrypted queue; absence must mean only
/// record-not-found, never an unreadable file or unavailable encryption key.
public protocol NativeRecordingBindingRecordStore: Sendable {
  func readBinding(key: String) throws -> NativeRecordingStoredRecord?
  func createBinding(key: String, data: Data) throws
  func compareAndSwapBinding(key: String, expectedRevision: UInt64, data: Data) throws
}

public struct NativeRecordingBindingAcknowledgement: Sendable {
  public let sessionID: UUID
  public let keyVersion: String
  public init(sessionID: UUID, keyVersion: String) {
    self.sessionID = sessionID
    self.keyVersion = keyVersion
  }
}

/// Implemented by the authenticated native Core connection. Each operation
/// must use fresh native credentials and validate its complete Core envelope.
/// No renderer-provided identity or cached capture permission is accepted here.
public protocol NativeRecordingBindingService: Sendable {
  func recordingScope() async throws -> NativeRecordingScope
  func publishedKey() async throws -> NativeRecordingPublicKey
  func bind(key: NativeRecordingKeyReceipt, intent: UUID) async throws
    -> NativeRecordingBindingAcknowledgement
}

/// Retains the intent before creating custody, and the exact candidate before
/// dispatching bind. The returned cipher remains native-only. This owner does
/// not grant recording permission or replace exclusive source/flow ownership.
public actor NativeRecordingBindingOwner {
  private struct Journal: Codable {
    let schemaVersion: Int
    let account: String
    let intent: UUID
    let keyVersion: String
    let modulus: String
    var wrappedDEK: String?
    var bound: Bool

    var revision: UInt64 { bound ? 3 : (wrappedDEK == nil ? 1 : 2) }
    var receipt: NativeRecordingKeyReceipt? {
      wrappedDEK.map { NativeRecordingKeyReceipt(keyVersion: keyVersion, wrappedDEK: $0) }
    }
  }

  private let scope: NativeRecordingScope
  private let service: any NativeRecordingBindingService
  private let records: any NativeRecordingBindingRecordStore
  private let keys: any NativeRecordingKeyStorage
  private let recordKey: String
  private var busy = false

  public init(
    scope: NativeRecordingScope, service: any NativeRecordingBindingService,
    records: any NativeRecordingBindingRecordStore,
    keys: any NativeRecordingKeyStorage = KeychainNativeRecordingStorage()
  ) {
    self.scope = scope
    self.service = service
    self.records = records
    self.keys = keys
    recordKey = "scribe-native-binding:v1:\(scope.keyAccount)"
  }

  public func open() async throws -> NativeRecordingEncryption {
    // Actor isolation alone does not exclude another call across network awaits.
    guard !busy else { throw NativeRecordingBindingFailure.operationInProgress }
    busy = true
    defer { busy = false }
    try await checkScope()

    var journal: Journal
    if let retained = try records.readBinding(key: recordKey) {
      journal = try decode(retained)
    } else {
      let published = try await service.publishedKey()
      try await checkScope()
      journal = Journal(
        schemaVersion: 1, account: scope.keyAccount, intent: UUID(),
        keyVersion: published.version, modulus: nativeBase64URL(published.modulus),
        wrappedDEK: nil, bound: false)
      try commit(journal, after: 0)
    }

    let cipher: NativeRecordingEncryption
    if let receipt = journal.receipt {
      // Once a candidate was recorded it may already be bound remotely. Even
      // when the last response was lost, missing custody can never be replaced.
      cipher = try NativeRecordingEncryption.reopen(scope: scope, expected: receipt, storage: keys)
    } else {
      cipher = try NativeRecordingEncryption.prepareBindingCandidate(
        scope: scope,
        published: NativeRecordingPublicKey(
          version: journal.keyVersion, modulusBase64URL: journal.modulus),
        intent: journal.intent, storage: keys)
      journal.wrappedDEK = cipher.receipt.wrappedDEK
      try commit(journal, after: 1)
    }
    if journal.bound {
      try Task.checkCancellation()
      return cipher
    }

    try await checkScope()
    let acknowledgement = try await service.bind(key: cipher.receipt, intent: journal.intent)
    try await checkScope()
    guard acknowledgement.sessionID == scope.sessionID,
      acknowledgement.keyVersion == cipher.receipt.keyVersion
    else { throw NativeRecordingBindingFailure.receiptMismatch }
    journal.bound = true
    try commit(journal, after: 2)
    return cipher
  }

  private func checkScope() async throws {
    try Task.checkCancellation()
    guard try await service.recordingScope() == scope else {
      throw NativeRecordingBindingFailure.authorityChanged
    }
    try Task.checkCancellation()
  }

  private func decode(_ record: NativeRecordingStoredRecord) throws -> Journal {
    guard record.data.count <= 4096,
      let fields = try? JSONSerialization.jsonObject(with: record.data) as? [String: Any]
    else { throw NativeRecordingBindingFailure.invalidJournal }
    var allowed: Set<String> = [
      "schemaVersion", "account", "intent", "keyVersion", "modulus", "bound",
    ]
    if fields["wrappedDEK"] != nil { allowed.insert("wrappedDEK") }
    guard Set(fields.keys) == allowed,
      let journal = try? JSONDecoder().decode(Journal.self, from: record.data),
      journal.schemaVersion == 1, journal.account == scope.keyAccount,
      journal.revision == record.revision,
      journal.keyVersion.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
      (try? NativeRecordingPublicKey(
        version: journal.keyVersion, modulusBase64URL: journal.modulus)) != nil,
      !journal.bound || journal.wrappedDEK != nil
    else { throw NativeRecordingBindingFailure.invalidJournal }
    if let wrapped = journal.wrappedDEK {
      guard wrapped.utf8.count == 512, nativeBase64URLDecode(wrapped)?.count == 384 else {
        throw NativeRecordingBindingFailure.invalidJournal
      }
    } else if fields["wrappedDEK"] != nil {
      throw NativeRecordingBindingFailure.invalidJournal
    }
    return journal
  }

  private func commit(_ journal: Journal, after revision: UInt64) throws {
    try Task.checkCancellation()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(journal)
    // Validate the same strict shape used on recovery before any write.
    _ = try decode(NativeRecordingStoredRecord(data: data, revision: revision + 1))
    do {
      if revision == 0 {
        try records.createBinding(key: recordKey, data: data)
      } else {
        try records.compareAndSwapBinding(key: recordKey, expectedRevision: revision, data: data)
      }
    } catch {
      // One read resolves only this exact successor. Never overwrite/adopt a
      // different intent or regenerate a key after an ambiguous storage result.
      guard let retained = try records.readBinding(key: recordKey),
        retained.revision == revision + 1, retained.data == data
      else { throw NativeRecordingBindingFailure.journalConflict }
    }
  }
}
