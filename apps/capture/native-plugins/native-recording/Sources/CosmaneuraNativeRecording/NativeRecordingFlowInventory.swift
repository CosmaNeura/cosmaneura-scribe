import CryptoKit
import Foundation

/// Implemented by the existing encrypted file queue. Enumeration returns keys,
/// not audio, and every record is read/authenticated individually during recovery.
public protocol NativeRecordingFlowStore: NativeRecordingBindingRecordStore,
  NativeRecordingRecordStore
{
  func listRecordingKeys(prefix: String) throws -> [String]
}

struct NativeRecordingFlowInventory {
  let chunks: Int
  let plaintextBytes: Int

  static func read(
    encryption: NativeRecordingEncryption, recoveryScope: UUID,
    records: any NativeRecordingFlowStore
  ) throws -> Self {
    let scope = encryption.scope
    let prefix = scope.queuePrefix(recoveryScope: recoveryScope)
    let keys = try records.listRecordingKeys(prefix: prefix)
    guard keys.count <= 2048, Set(keys).count == keys.count else {
      throw NativeRecordingBindingFailure.invalidJournal
    }
    var positions: [Int: Int] = [:]
    for key in keys {
      guard key.hasPrefix(prefix),
        let object = UUID(uuidString: String(key.dropFirst(prefix.count))),
        key == prefix + object.uuidString.lowercased()
      else { throw NativeRecordingBindingFailure.invalidJournal }
      try autoreleasepool {
        let stored = try records.read(key: key)
        guard stored.data.count <= 524_288, stored.revision > 0,
          let raw = try? JSONSerialization.jsonObject(with: stored.data) as? [String: Any],
          let reservation = raw["reservation"] as? [String: Any],
          let sequence = exactSequence(reservation["sequenceNumber"]), positions[sequence] == nil,
          let state = raw["state"] as? String, state == "reserved" || state == "encrypted"
        else { throw NativeRecordingBindingFailure.invalidJournal }
        let baseFields: Set<String> = [
          "schemaVersion", "revision", "state", "reservation", "idempotencyKeys", "retry",
        ]
        guard
          Set(raw.keys)
            == (state == "reserved"
              ? baseFields : baseFields.union(["envelope", "sha256", "byteLength"]))
        else {
          throw NativeRecordingBindingFailure.invalidJournal
        }
        // The existing strict reserved-record validator covers the untouched queue
        // metadata. Upload mutations are forbidden until the flow has been sealed.
        var base = raw.filter { baseFields.contains($0.key) }
        base["state"] = "reserved"
        let encoded = try JSONSerialization.data(withJSONObject: base)
        let checked = try nativeRecordingReservedRecord(
          NativeRecordingStoredRecord(data: encoded, revision: stored.revision),
          scope: scope, objectID: object, sequence: sequence)
        if state == "reserved" {
          guard stored.revision == 1, checked.revision == 1,
            let aad = nativeBase64URLDecode(checked.aad),
            try aad == scope.additionalData(objectID: object, sequence: sequence)
          else { throw NativeRecordingBindingFailure.invalidJournal }
          positions[sequence] = 0
        } else {
          guard stored.revision == 2, checked.revision == 2,
            let envelopeText = raw["envelope"] as? String,
            let envelope = nativeBase64URLDecode(envelopeText), envelope.count <= 327_680,
            let byteLength = raw["byteLength"] as? NSNumber,
            CFGetTypeID(byteLength) != CFBooleanGetTypeID(),
            byteLength.doubleValue == Double(envelope.count),
            let digest = raw["sha256"] as? String,
            digest == SHA256.hash(data: envelope).map({ String(format: "%02x", $0) }).joined()
          else { throw NativeRecordingBindingFailure.invalidJournal }
          positions[sequence] = try encryption.authenticatedPlaintextBytes(
            envelope: envelope, objectID: object, sequence: sequence,
            additionalAuthenticatedData: checked.aad)
        }
      }
    }
    var chunks = 0
    var bytes = 0
    var reserved = false
    for sequence in 0..<positions.count {
      guard let count = positions[sequence] else {
        throw NativeRecordingBindingFailure.invalidJournal
      }
      if count == 0 {
        reserved = true
      } else {
        guard !reserved, bytes <= NativeRecordingFlowOwner.maximumPlaintextBytes - count else {
          throw NativeRecordingBindingFailure.invalidJournal
        }
        bytes += count
        chunks += 1
      }
    }
    return Self(chunks: chunks, plaintextBytes: bytes)
  }

  private static func exactSequence(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
      (0..<2048).contains(number.intValue), number.doubleValue == Double(number.intValue)
    else { return nil }
    return number.intValue
  }
}
