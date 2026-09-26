import CoreFoundation
import CryptoKit
import Foundation

public struct NativeRecordingStoredRecord: Sendable {
  public let data: Data
  public let revision: UInt64
  public init(data: Data, revision: UInt64) {
    self.data = data
    self.revision = revision
  }
}

/// Implemented by the existing device-encrypted SecureQueueStore. The native
/// writer advances its existing records; there is no second upload journal.
public protocol NativeRecordingRecordStore {
  func read(key: String) throws -> NativeRecordingStoredRecord
  func compareAndSwap(key: String, expectedRevision: UInt64, data: Data) throws
  func availableBytes() throws -> Int
}

public struct NativeRecordingCommit: Equatable, Sendable {
  public let sequence: Int
  public let plaintextBytes: Int
  public let envelopeBytes: Int
}

/// Synchronous, bounded native packet consumption, called on the recorder's
/// persistence queue, never the audio callback. The native capture owner must
/// enforce consent/authority and hold exclusive flow ownership throughout.
public final class NativeRecordingQueueWriter {
  private let store: any NativeRecordingRecordStore
  private let encryption: NativeRecordingEncryption
  private let prefix: String
  private let lock = NSLock()
  private var nextSequence: Int
  private var plaintextBytes: Int
  private let maximumPlaintextBytes: Int

  public init(
    encryption: NativeRecordingEncryption, recoveryScope: UUID,
    store: any NativeRecordingRecordStore, firstSequence: Int, priorPlaintextBytes: Int,
    maximumPlaintextBytes: Int
  ) throws {
    guard (0..<2048).contains(firstSequence), priorPlaintextBytes >= 0,
      maximumPlaintextBytes > priorPlaintextBytes, maximumPlaintextBytes <= 402_653_184
    else {
      throw NativeRecordingFailure.invalidBinding
    }
    self.encryption = encryption
    self.store = store
    nextSequence = firstSequence
    plaintextBytes = priorPlaintextBytes
    self.maximumPlaintextBytes = maximumPlaintextBytes
    prefix = encryption.scope.queuePrefix(recoveryScope: recoveryScope)
  }

  /// Returns only after the complete envelope is durably committed. Failure
  /// leaves the prior reservation intact or a recoverable committed envelope.
  public func persist(pcm16: inout Data, objectID: UUID, sequence: Int) throws
    -> NativeRecordingCommit
  {
    lock.lock()
    defer {
      lock.unlock()
      pcm16.resetBytes(in: 0..<pcm16.count)
    }
    guard sequence == nextSequence, !pcm16.isEmpty, pcm16.count <= 320_000,
      pcm16.count.isMultiple(of: 2), pcm16.count + 44 <= maximumPlaintextBytes - plaintextBytes
    else {
      throw NativeRecordingFailure.invalidPacket
    }
    // Existing four-copy storage allowance plus the 64 MiB recovery reserve.
    guard try store.availableBytes() >= 67_108_864 + 4 * 327_680 else {
      throw NativeRecordingFailure.storageUnavailable
    }
    let key = prefix + objectID.uuidString.lowercased()
    let stored = try store.read(key: key)
    let parsed = try nativeRecordingReservedRecord(
      stored, scope: encryption.scope, objectID: objectID, sequence: sequence)
    var record = parsed.record
    let revision = parsed.revision
    let aad = parsed.aad
    let size = pcm16.count + 44
    let envelope = try encryption.seal(
      pcm16: &pcm16, objectID: objectID, sequence: sequence,
      additionalAuthenticatedData: aad)
    record["state"] = "encrypted"
    record["revision"] = revision + 1
    record["envelope"] = nativeBase64URL(envelope)
    record["byteLength"] = envelope.count
    record["sha256"] = SHA256.hash(data: envelope).map { String(format: "%02x", $0) }.joined()
    let encoded = try JSONSerialization.data(
      withJSONObject: record, options: [.sortedKeys, .withoutEscapingSlashes])
    do {
      try store.compareAndSwap(key: key, expectedRevision: stored.revision, data: encoded)
    } catch {
      // A write may commit before reporting failure. Acknowledge only an exact
      // byte-for-byte reread at the successor native revision; never re-encrypt.
      guard let saved = try? store.read(key: key), saved.revision == stored.revision + 1,
        saved.data == encoded
      else { throw NativeRecordingFailure.storageUnavailable }
    }
    plaintextBytes += size
    nextSequence += 1
    return NativeRecordingCommit(
      sequence: sequence, plaintextBytes: size, envelopeBytes: envelope.count)
  }
}

/// Shared strict reservation decoder for the native allocator and encrypted writer.
func nativeRecordingReservedRecord(
  _ stored: NativeRecordingStoredRecord, scope: NativeRecordingScope,
  objectID: UUID, sequence: Int
) throws -> (record: [String: Any], revision: Int, aad: String) {
  guard stored.data.count <= 16_384, stored.revision > 0, stored.revision < UInt64(Int64.max),
    let record = try JSONSerialization.jsonObject(with: stored.data) as? [String: Any],
    Set(record.keys) == [
      "schemaVersion", "revision", "state", "reservation", "idempotencyKeys", "retry",
    ],
    exactInteger(record["schemaVersion"]) == 1,
    let revision = exactInteger(record["revision"]),
    (1..<9_007_199_254_740_991).contains(revision),
    record["state"] as? String == "reserved",
    let reservation = record["reservation"] as? [String: Any],
    Set(reservation.keys) == [
      "protocolVersion", "objectId", "sessionId", "channel", "sequenceNumber",
      "additionalAuthenticatedData", "createdAt",
    ],
    reservation["protocolVersion"] as? String == "1.0",
    reservation["objectId"] as? String == objectID.uuidString.lowercased(),
    reservation["sessionId"] as? String == scope.sessionID.uuidString.lowercased(),
    reservation["channel"] as? String == "microphone",
    exactInteger(reservation["sequenceNumber"]) == sequence,
    let aad = reservation["additionalAuthenticatedData"] as? String, aad.utf8.count <= 1024,
    let created = reservation["createdAt"] as? String, validDate(created),
    validKeys(record["idempotencyKeys"]), validRetry(record["retry"])
  else { throw NativeRecordingFailure.invalidBinding }
  return (record, revision, aad)
}

private func exactInteger(_ value: Any?) -> Int? {
  guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
    number.doubleValue.isFinite, abs(number.doubleValue) <= 9_007_199_254_740_991,
    number.doubleValue.rounded(.towardZero) == number.doubleValue
  else { return nil }
  return number.intValue
}

private func validDate(_ value: String) -> Bool {
  guard value.utf8.count <= 40 else { return false }
  let parser = ISO8601DateFormatter()
  parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if parser.date(from: value) != nil { return true }
  parser.formatOptions = [.withInternetDateTime]
  return parser.date(from: value) != nil
}

private func validKeys(_ value: Any?) -> Bool {
  guard let value = value as? [String: Any],
    Set(value.keys) == [
      "reservation", "uploadAuthorization", "uploadAuthorizationGeneration", "registration",
    ],
    exactInteger(value["uploadAuthorizationGeneration"]) == 1
  else { return false }
  return ["reservation", "uploadAuthorization", "registration"].allSatisfy { name in
    guard let key = value[name] as? String else { return false }
    return key.range(of: "^[A-Za-z0-9._:-]{1,128}$", options: .regularExpression) != nil
  }
}

private func validRetry(_ value: Any?) -> Bool {
  guard let value = value as? [String: Any], Set(value.keys) == ["upload", "registration"] else {
    return false
  }
  return value.values.allSatisfy { raw in
    guard let attempt = raw as? [String: Any],
      Set(attempt.keys) == ["attempts", "notBeforeEpochMs", "terminalCode"],
      exactInteger(attempt["attempts"]) == 0,
      attempt["notBeforeEpochMs"] is NSNull, attempt["terminalCode"] is NSNull
    else { return false }
    return true
  }
}
