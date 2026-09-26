import CryptoKit
import Foundation
import Security
import XCTest

@testable import CosmaneuraNativeRecording

final class NativeRecordingEncryptionTests: XCTestCase {
  private final class MemoryStorage: NativeRecordingKeyStorage, @unchecked Sendable {
    var values: [String: Data] = [:]
    var failWrite = false
    var failAfterWrite = false
    var insertCount = 0
    func read(account: String) throws -> Data? { values[account] }
    func insert(account: String, value: Data) throws {
      insertCount += 1
      if failWrite { throw NativeRecordingFailure.keyUnavailable }
      guard values[account] == nil else { throw NativeRecordingFailure.keyConflict }
      values[account] = value
      if failAfterWrite { throw NativeRecordingFailure.keyUnavailable }
    }
  }

  private final class Records: NativeRecordingRecordStore {
    var rows: [String: NativeRecordingStoredRecord] = [:]
    var capacity = 1_000_000_000
    var failBeforeCommit = false, failAfterCommit = false
    func read(key: String) throws -> NativeRecordingStoredRecord {
      guard let row = rows[key] else { throw NativeRecordingFailure.invalidBinding }
      return row
    }
    func compareAndSwap(key: String, expectedRevision: UInt64, data: Data) throws {
      guard !failBeforeCommit, let prior = rows[key], prior.revision == expectedRevision else {
        throw NativeRecordingFailure.storageUnavailable
      }
      rows[key] = NativeRecordingStoredRecord(data: data, revision: prior.revision + 1)
      if failAfterCommit { throw NativeRecordingFailure.storageUnavailable }
    }
    func availableBytes() throws -> Int { capacity }
  }

  private func reservation(scope: NativeRecordingScope, object: UUID, sequence: Int) throws -> Data
  {
    let retry: [String: Any] = [
      "attempts": 0, "notBeforeEpochMs": NSNull(), "terminalCode": NSNull(),
    ]
    return try JSONSerialization.data(
      withJSONObject: [
        "schemaVersion": 1, "revision": 1, "state": "reserved",
        "reservation": [
          "protocolVersion": "1.0", "objectId": object.uuidString.lowercased(),
          "sessionId": scope.sessionID.uuidString.lowercased(), "channel": "microphone",
          "sequenceNumber": sequence,
          "additionalAuthenticatedData": nativeBase64URL(try aad(scope, object, sequence)),
          "createdAt": "2026-09-26T12:00:00.000Z",
        ],
        "idempotencyKeys": [
          "reservation": UUID().uuidString.lowercased(),
          "uploadAuthorization": UUID().uuidString.lowercased(), "uploadAuthorizationGeneration": 1,
          "registration": UUID().uuidString.lowercased(),
        ],
        "retry": ["upload": retry, "registration": retry],
      ], options: [.sortedKeys])
  }

  private func queueKey(_ scope: NativeRecordingScope, _ recovery: UUID, _ object: UUID) -> String {
    "scribe-provider-queue:v1:\(recovery.uuidString.lowercased()):\(scope.workspaceID.uuidString.lowercased()):\(scope.sessionID.uuidString.lowercased()):\(object.uuidString.lowercased())"
  }

  func testNativeWriterAdvancesExistingQueueAndRecoversCommittedButLostWrite() throws {
    let scope = try scope()
    let storage = MemoryStorage()
    let (_, published) = try fixture()
    let cipher = try NativeRecordingEncryption.create(
      scope: scope, published: published, storage: storage)
    let records = Records()
    let recovery = UUID()
    let writer = try NativeRecordingQueueWriter(
      encryption: cipher, recoveryScope: recovery,
      store: records, firstSequence: 0, priorPlaintextBytes: 0, maximumPlaintextBytes: 402_653_184)
    for sequence in 0..<2 {
      let object = UUID()
      let key = queueKey(scope, recovery, object)
      let original = try reservation(scope: scope, object: object, sequence: sequence)
      records.rows[key] = NativeRecordingStoredRecord(data: original, revision: 1)
      records.failAfterCommit = sequence == 1
      var pcm = Data([1, 0, 255, 127])
      let result = try writer.persist(pcm16: &pcm, objectID: object, sequence: sequence)
      XCTAssertEqual(result.sequence, sequence)
      XCTAssertEqual(result.plaintextBytes, 48)
      XCTAssertTrue(pcm.allSatisfy { $0 == 0 })
      let saved = try records.read(key: key)
      XCTAssertEqual(saved.revision, 2)
      let row = try XCTUnwrap(JSONSerialization.jsonObject(with: saved.data) as? [String: Any])
      let before = try XCTUnwrap(JSONSerialization.jsonObject(with: original) as? [String: Any])
      XCTAssertEqual(row["state"] as? String, "encrypted")
      XCTAssertEqual(row["revision"] as? Int, 2)
      for name in ["reservation", "idempotencyKeys", "retry"] {
        XCTAssertEqual(
          try JSONSerialization.data(withJSONObject: row[name]!, options: [.sortedKeys]),
          try JSONSerialization.data(withJSONObject: before[name]!, options: [.sortedKeys]))
      }
      let envelope = try XCTUnwrap(nativeBase64URLDecode(XCTUnwrap(row["envelope"] as? String)))
      XCTAssertEqual(row["byteLength"] as? Int, envelope.count)
      XCTAssertEqual(
        row["sha256"] as? String,
        SHA256.hash(data: envelope).map { String(format: "%02x", $0) }.joined())
      if sequence == 1,
        let path = ProcessInfo.processInfo.environment["SCRIBE_NATIVE_RECORDING_FIXTURE_PATH"]
      {
        // Synthetic ciphertext only, for the existing TypeScript queue decoder.
        try saved.data.write(to: URL(fileURLWithPath: path), options: .atomic)
      }
    }
  }

  func testNativeWriterRetainsReservationsAfterDiskFailureAndRejectsWrongPosition() throws {
    let scope = try scope()
    let storage = MemoryStorage()
    let (_, published) = try fixture()
    let cipher = try NativeRecordingEncryption.create(
      scope: scope, published: published, storage: storage)
    let records = Records()
    let recovery = UUID()
    let object = UUID()
    let key = queueKey(scope, recovery, object)
    let original = try reservation(scope: scope, object: object, sequence: 7)
    records.rows[key] = NativeRecordingStoredRecord(data: original, revision: 4)
    let writer = try NativeRecordingQueueWriter(
      encryption: cipher, recoveryScope: recovery,
      store: records, firstSequence: 7, priorPlaintextBytes: 0, maximumPlaintextBytes: 402_653_184)
    for mode in 0..<3 {
      records.capacity = mode == 0 ? 67_108_864 : 1_000_000_000
      records.failBeforeCommit = mode == 1
      var pcm = Data([1, 0, 255, 127])
      XCTAssertThrowsError(
        try writer.persist(pcm16: &pcm, objectID: object, sequence: mode == 2 ? 8 : 7))
      XCTAssertTrue(pcm.allSatisfy { $0 == 0 })
      XCTAssertEqual(try records.read(key: key).data, original)
    }
    records.failBeforeCommit = false
    var pcm = Data([1, 0, 255, 127])
    XCTAssertEqual(try writer.persist(pcm16: &pcm, objectID: object, sequence: 7).sequence, 7)
    var replay = Data([1, 0, 255, 127])
    XCTAssertThrowsError(try writer.persist(pcm16: &replay, objectID: object, sequence: 7))
    XCTAssertTrue(replay.allSatisfy { $0 == 0 })
  }

  private func scope() throws -> NativeRecordingScope {
    try NativeRecordingScope(
      tenantID: UUID(), sessionID: UUID(), workspaceID: UUID(),
      accountDigest: String(repeating: "a", count: 64))
  }

  private func fixture() throws -> (SecKey, NativeRecordingPublicKey) {
    let privateKey = try XCTUnwrap(
      SecKeyCreateRandomKey(
        [
          kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits: 3072,
          kSecAttrIsPermanent: false,
        ] as CFDictionary, nil))
    let publicKey = try XCTUnwrap(SecKeyCopyPublicKey(privateKey))
    let der = try XCTUnwrap(SecKeyCopyExternalRepresentation(publicKey, nil)) as Data
    // Security exports 3072-bit PKCS#1: sequence(4), integer(4), sign byte(1).
    XCTAssertEqual(Array(der.prefix(9)), [0x30, 0x82, 1, 0x8a, 2, 0x82, 1, 0x81, 0])
    return (
      privateKey,
      try NativeRecordingPublicKey(
        version: "synthetic-v1",
        modulusBase64URL: nativeBase64URL(der.subdata(in: 9..<393)))
    )
  }

  private func aad(_ scope: NativeRecordingScope, _ object: UUID, _ sequence: Int) throws -> Data {
    try JSONSerialization.data(
      withJSONObject: [
        "channel": "microphone", "object_id": object.uuidString.lowercased(),
        "sequence_number": sequence, "session_id": scope.sessionID.uuidString.lowercased(),
        "tenant_id": scope.tenantID.uuidString.lowercased(),
      ], options: [.sortedKeys])
  }

  private func open(_ envelope: Data, key: SymmetricKey, aad: Data) throws -> (Data, String) {
    XCTAssertEqual(envelope.prefix(8), Data("CSCRIBE1".utf8))
    let length = envelope[8..<12].reduce(0) { ($0 << 8) | Int($1) }
    let header = try XCTUnwrap(
      JSONSerialization.jsonObject(with: envelope[12..<(12 + length)]) as? [String: String])
    XCTAssertEqual(
      Set(header.keys), ["schema_version", "content_encryption", "nonce", "media_type"])
    XCTAssertEqual(header["schema_version"], "1.0")
    XCTAssertEqual(header["content_encryption"], "A256GCM")
    XCTAssertEqual(header["media_type"], "audio/wav")
    let nonce = try XCTUnwrap(header["nonce"])
    let box = try AES.GCM.SealedBox(
      nonce: AES.GCM.Nonce(data: XCTUnwrap(nativeBase64URLDecode(nonce))),
      ciphertext: envelope[(12 + length)..<(envelope.count - 16)], tag: envelope.suffix(16))
    return (try AES.GCM.open(box, using: key, authenticating: aad), nonce)
  }

  func testThreeHourPacketBudgetUsesNativeRSAAndAESWithoutRetainingPCM() throws {
    let scope = try scope()
    let storage = MemoryStorage()
    let (privateKey, published) = try fixture()
    let cipher = try NativeRecordingEncryption.create(
      scope: scope, published: published, storage: storage)
    let wrapped = try XCTUnwrap(nativeBase64URLDecode(cipher.receipt.wrappedDEK))
    let raw =
      try XCTUnwrap(
        SecKeyCreateDecryptedData(privateKey, .rsaEncryptionOAEPSHA256, wrapped as CFData, nil))
      as Data
    XCTAssertEqual(raw.count, 32)
    let key = SymmetricKey(data: raw)
    var nonces = Set<String>()
    var total = 0
    for sequence in 0..<1080 {
      try autoreleasepool {
        let object = UUID()
        let aad = try aad(scope, object, sequence)
        var pcm = Data(repeating: UInt8(sequence % 255 + 1), count: 320_000)
        let expected = pcm
        let envelope = try cipher.seal(
          pcm16: &pcm, objectID: object, sequence: sequence,
          additionalAuthenticatedData: nativeBase64URL(aad))
        XCTAssertTrue(pcm.allSatisfy { $0 == 0 })
        XCTAssertLessThanOrEqual(envelope.count, 327_680)
        let (wav, nonce) = try open(envelope, key: key, aad: aad)
        XCTAssertEqual(wav.count, 320_044)
        XCTAssertEqual(wav.prefix(4), Data("RIFF".utf8))
        XCTAssertEqual(wav.subdata(in: 8..<16), Data("WAVEfmt ".utf8))
        XCTAssertEqual(
          wav.subdata(in: 20..<36), Data([1, 0, 1, 0, 128, 62, 0, 0, 0, 125, 0, 0, 2, 0, 16, 0]))
        XCTAssertEqual(wav.dropFirst(44), expected)
        XCTAssertTrue(nonces.insert(nonce).inserted)
        total += expected.count
      }
    }
    XCTAssertEqual(total, 345_600_000)
    XCTAssertEqual(nonces.count, 1080)
  }

  func testReopenPreservesExactKeyAndRejectsWrongScopeReceiptAndMissingCustody() throws {
    let scope = try scope()
    let storage = MemoryStorage()
    let (_, published) = try fixture()
    let created = try NativeRecordingEncryption.create(
      scope: scope, published: published, storage: storage)
    let before = storage.values
    let reopened = try NativeRecordingEncryption.reopen(
      scope: scope, expected: created.receipt, storage: storage)
    XCTAssertEqual(reopened.receipt, created.receipt)
    XCTAssertThrowsError(
      try NativeRecordingEncryption.create(scope: scope, published: published, storage: storage))
    XCTAssertThrowsError(
      try NativeRecordingEncryption.reopen(
        scope: self.scope(), expected: created.receipt, storage: storage))
    XCTAssertThrowsError(
      try NativeRecordingEncryption.reopen(
        scope: scope,
        expected: NativeRecordingKeyReceipt(
          keyVersion: "wrong", wrappedDEK: created.receipt.wrappedDEK), storage: storage))
    XCTAssertThrowsError(
      try NativeRecordingEncryption.reopen(
        scope: scope, expected: created.receipt, storage: MemoryStorage()))
    XCTAssertEqual(before, storage.values)
  }

  func testBindingCandidateRecoversLostCreationAndKeepsOneImmutableKey() throws {
    let scope = try scope()
    let intent = UUID()
    let storage = MemoryStorage()
    let (_, published) = try fixture()
    storage.failAfterWrite = true
    let candidate = try NativeRecordingEncryption.prepareBindingCandidate(
      scope: scope, published: published, intent: intent, storage: storage)
    let retained = storage.values
    let resumed = try NativeRecordingEncryption.prepareBindingCandidate(
      scope: scope, published: published, intent: intent, storage: storage)
    XCTAssertEqual(candidate.receipt, resumed.receipt)
    XCTAssertEqual(storage.insertCount, 1)
    XCTAssertEqual(storage.values, retained)
    XCTAssertEqual(
      try NativeRecordingEncryption.reopen(
        scope: scope, expected: candidate.receipt, storage: storage
      ).receipt,
      candidate.receipt)
    XCTAssertThrowsError(
      try NativeRecordingEncryption.prepareBindingCandidate(
        scope: scope, published: published, intent: UUID(), storage: storage))
    let (_, otherKey) = try fixture()
    XCTAssertThrowsError(
      try NativeRecordingEncryption.prepareBindingCandidate(
        scope: scope, published: otherKey, intent: intent, storage: storage))
    let otherVersion = try NativeRecordingPublicKey(
      version: "synthetic-v2", modulusBase64URL: nativeBase64URL(published.modulus))
    XCTAssertThrowsError(
      try NativeRecordingEncryption.prepareBindingCandidate(
        scope: scope, published: otherVersion, intent: intent, storage: storage))
    XCTAssertEqual(storage.insertCount, 1)
    XCTAssertEqual(storage.values, retained)
  }

  func testBindingCandidateCannotAdoptLegacyOrCorruptKeysOrHideMissingBoundCustody() throws {
    let scope = try scope()
    let storage = MemoryStorage()
    let intent = UUID()
    let (_, published) = try fixture()
    let legacy = try NativeRecordingEncryption.create(
      scope: scope, published: published, storage: storage)
    let retained = storage.values
    XCTAssertThrowsError(
      try NativeRecordingEncryption.prepareBindingCandidate(
        scope: scope, published: published, intent: intent, storage: storage))
    XCTAssertEqual(storage.values, retained)
    XCTAssertEqual(storage.insertCount, 1)
    let unavailable = MemoryStorage()
    unavailable.failWrite = true
    XCTAssertThrowsError(
      try NativeRecordingEncryption.prepareBindingCandidate(
        scope: scope, published: published, intent: intent, storage: unavailable))
    XCTAssertTrue(unavailable.values.isEmpty)
    XCTAssertEqual(unavailable.insertCount, 1)
    XCTAssertThrowsError(
      try NativeRecordingEncryption.reopen(
        scope: scope, expected: legacy.receipt, storage: unavailable))
    unavailable.values[scope.keyAccount] = Data("corrupt synthetic key record".utf8)
    let corrupt = unavailable.values
    XCTAssertThrowsError(
      try NativeRecordingEncryption.prepareBindingCandidate(
        scope: scope, published: published, intent: intent, storage: unavailable))
    XCTAssertEqual(unavailable.values, corrupt)
    XCTAssertEqual(unavailable.insertCount, 1)
  }

  func testScopeAndPacketFailuresConsumePCMAndNeverReturnAnEnvelope() throws {
    let scope = try scope()
    let storage = MemoryStorage()
    let (_, published) = try fixture()
    let cipher = try NativeRecordingEncryption.create(
      scope: scope, published: published, storage: storage)
    let object = UUID()
    let aad = try aad(scope, object, 0)
    for (size, sequence, authenticated) in [
      (3, 0, aad), (320_002, 0, aad), (2, 2048, aad),
      (2, 0, Data("wrong scope".utf8)),
    ] {
      var pcm = Data(repeating: 77, count: size)
      XCTAssertThrowsError(
        try cipher.seal(
          pcm16: &pcm, objectID: object, sequence: sequence,
          additionalAuthenticatedData: nativeBase64URL(authenticated)))
      XCTAssertTrue(pcm.allSatisfy { $0 == 0 })
    }
    var pcm = Data([1, 2])
    XCTAssertThrowsError(
      try cipher.seal(
        pcm16: &pcm, objectID: UUID(), sequence: 0,
        additionalAuthenticatedData: nativeBase64URL(aad)))
    XCTAssertEqual(pcm, Data([0, 0]))
  }

  func testTamperingAndDifferentEncounterCannotDecrypt() throws {
    let scope = try scope()
    let storage = MemoryStorage()
    let (privateKey, published) = try fixture()
    let cipher = try NativeRecordingEncryption.create(
      scope: scope, published: published, storage: storage)
    let raw =
      try XCTUnwrap(
        SecKeyCreateDecryptedData(
          privateKey, .rsaEncryptionOAEPSHA256,
          XCTUnwrap(nativeBase64URLDecode(cipher.receipt.wrappedDEK)) as CFData, nil)) as Data
    let key = SymmetricKey(data: raw)
    let object = UUID()
    let data = try aad(scope, object, 0)
    var pcm = Data([1, 0, 255, 127])
    var envelope = try cipher.seal(
      pcm16: &pcm, objectID: object, sequence: 0,
      additionalAuthenticatedData: nativeBase64URL(data))
    XCTAssertThrowsError(try open(envelope, key: key, aad: aad(self.scope(), object, 0)))
    envelope[envelope.count - 1] ^= 1
    XCTAssertThrowsError(try open(envelope, key: key, aad: data))
  }

  func testUnusableCustodyFailsWithoutFallbackAndKeychainPolicyIsDeviceOnly() throws {
    let scope = try scope()
    let storage = MemoryStorage()
    let (_, published) = try fixture()
    storage.failWrite = true
    XCTAssertThrowsError(
      try NativeRecordingEncryption.create(scope: scope, published: published, storage: storage))
    XCTAssertTrue(storage.values.isEmpty)
    storage.values[scope.keyAccount] = Data("unreadable".utf8)
    XCTAssertThrowsError(
      try NativeRecordingEncryption.reopen(
        scope: scope,
        expected: NativeRecordingKeyReceipt(keyVersion: "synthetic-v1", wrappedDEK: "bad"),
        storage: storage))
    let query = KeychainNativeRecordingStorage.query(scope.keyAccount)
    XCTAssertEqual(query[kSecAttrSynchronizable] as? Bool, false)
    XCTAssertNil(query[kSecAttrAccessGroup])
    XCTAssertThrowsError(try NativeRecordingPublicKey(version: "v1", modulusBase64URL: "AQAB"))
  }
}
