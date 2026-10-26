import CryptoKit
import Foundation
import Security
import XCTest
@testable import CosmaneuraNativeRecording

final class NativeRecordingPassageArchiveTests: XCTestCase {
  private final class Keys: NativeRecordingKeyStorage, @unchecked Sendable {
    var rows: [String: Data] = [:]
    func read(account: String) -> Data? { rows[account] }
    func insert(account: String, value: Data) { rows[account] = value }
  }
  private final class Records: NativeRecordingFlowStore, @unchecked Sendable {
    var rows: [String: NativeRecordingStoredRecord] = [:]
    var bindingReads: [String] = []
    var failAfterWrite = false, failBeforeWrite = false
    func readBinding(key: String) -> NativeRecordingStoredRecord? { bindingReads.append(key);return rows[key] }
    func read(key: String) throws -> NativeRecordingStoredRecord { try XCTUnwrap(rows[key]) }
    func createBinding(key: String, data: Data) throws {
      if failBeforeWrite { throw NativeRecordingFailure.storageUnavailable }
      guard rows[key] == nil else { throw NativeRecordingFailure.keyConflict }
      rows[key] = NativeRecordingStoredRecord(data: data, revision: 1)
      if failAfterWrite { throw NativeRecordingFailure.storageUnavailable }
    }
    func compareAndSwapBinding(key: String, expectedRevision: UInt64, data: Data) throws { try compareAndSwap(key: key, expectedRevision: expectedRevision, data: data) }
    func compareAndSwap(key: String, expectedRevision: UInt64, data: Data) throws {
      guard rows[key]?.revision == expectedRevision else { throw NativeRecordingFailure.storageUnavailable }
      rows[key] = NativeRecordingStoredRecord(data: data, revision: expectedRevision + 1)
    }
    func availableBytes() -> Int { 2_000_000_000 }
    func listRecordingKeys(prefix: String) -> [String] { rows.keys.filter { $0.hasPrefix(prefix) }.sorted() }
  }
  private struct Fixture {
    let keys: Keys, records: Records, scope: NativeRecordingScope, recovery: UUID, cipher: NativeRecordingEncryption, chunks: Int
    func retain(_ current: () throws -> Void = {}) throws {
      try NativeRecordingPassageArchive.retain(encryption: cipher, recovery: recovery, chunks: chunks, records: records, current: current)
    }
    func open(account: String? = nil, workspace: UUID? = nil, session: UUID? = nil) throws -> NativeRecordingPassageArchive? {
      try NativeRecordingPassageArchive.open(account: account ?? scope.accountDigest, recovery: recovery,
        workspace: workspace ?? scope.workspaceID, session: session ?? scope.sessionID, records: records)
    }
    var queue: [String] { records.listRecordingKeys(prefix: scope.queuePrefix(recoveryScope: recovery)) }
    func purge(_ key: String) throws {
      let saved = try records.read(key: key)
      var value = try JSONSerialization.jsonObject(with: saved.data) as! [String: Any]
      value["state"] = "purged";value.removeValue(forKey: "envelope");value.removeValue(forKey: "sha256");value.removeValue(forKey: "byteLength")
      records.rows[key] = NativeRecordingStoredRecord(data: try JSONSerialization.data(withJSONObject: value), revision: saved.revision + 1)
    }
  }
  // Synthetic consented capture fixture only. Real RSA/AES, private in-memory
  // key/record stores, no keychain, microphone, provider, filesystem audio or UI.
  private func fixture(chunks: Int = 2, frames: Int = 320) throws -> Fixture {
    let key = try XCTUnwrap(SecKeyCreateRandomKey([kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits: 3072, kSecAttrIsPermanent: false] as CFDictionary, nil))
    let pub = try XCTUnwrap(SecKeyCopyPublicKey(key));let der = try XCTUnwrap(SecKeyCopyExternalRepresentation(pub, nil)) as Data
    let published = try NativeRecordingPublicKey(version: "synthetic-consented-v1", modulusBase64URL: nativeBase64URL(der.subdata(in: 9..<393)))
    let scope = try NativeRecordingScope(tenantID: UUID(), sessionID: UUID(), workspaceID: UUID(), accountDigest: String(repeating: "a", count: 64))
    let keys = Keys(), records = Records(), recovery = UUID()
    let cipher = try NativeRecordingEncryption.create(scope: scope, published: published, storage: keys)
    for sequence in 0..<chunks {
      let object = UUID(), aad = nativeBase64URL(try scope.additionalData(objectID: object, sequence: sequence))
      var pcm = Data(repeating: UInt8(truncatingIfNeeded: sequence + 1), count: frames * 2)
      let envelope = try cipher.seal(pcm16: &pcm, objectID: object, sequence: sequence, additionalAuthenticatedData: aad)
      XCTAssertTrue(pcm.allSatisfy { $0 == 0 })
      let row: [String: Any] = ["state": "encrypted", "reservation": ["protocolVersion": "1.0", "sessionId": scope.sessionID.uuidString.lowercased(), "objectId": object.uuidString.lowercased(), "sequenceNumber": sequence, "channel": "microphone", "additionalAuthenticatedData": aad], "envelope": nativeBase64URL(envelope), "byteLength": envelope.count, "sha256": SHA256.hash(data: envelope).map { String(format: "%02x", $0) }.joined()]
      records.rows[scope.queuePrefix(recoveryScope: recovery) + object.uuidString.lowercased()] = NativeRecordingStoredRecord(data: try JSONSerialization.data(withJSONObject: row), revision: 2)
    }
    return Fixture(keys: keys, records: records, scope: scope, recovery: recovery, cipher: cipher, chunks: chunks)
  }
  func testRetainsExactAudioAfterIndependentQueuePurgeAndKeyReopen() throws {
    let f = try fixture();let original = f.queue.map { f.records.rows[$0]!.data };try f.retain()
    XCTAssertEqual(f.queue.map { f.records.rows[$0]!.data }, original)
    for key in f.queue { try f.purge(key) };try f.retain()
    let archive = try XCTUnwrap(f.open());let audio = try XCTUnwrap(archive.audio(startMs: 10, endMs: 30, keys: f.keys, current: {}))
    XCTAssertEqual(audio.count, 44 + 640);XCTAssertEqual(audio.prefix(4), Data("RIFF".utf8))
    XCTAssertEqual(audio.subdata(in: 44..<364), Data(repeating: 1, count: 320));XCTAssertEqual(audio.suffix(320), Data(repeating: 2, count: 320))
  }
  func testIdempotentRetentionRecoversLostWriteReply() throws {
    let f = try fixture();f.records.failAfterWrite = true;try f.retain();let before = f.records.rows.mapValues(\.data);try f.retain();XCTAssertEqual(f.records.rows.mapValues(\.data), before)
  }
  func testMissingHistoricalAudioReturnsUnavailableWithoutReplacingQueue() throws {
    let f = try fixture();try f.purge(f.queue[0]);let before = f.queue.map { f.records.rows[$0]!.data };try f.retain();XCTAssertNil(try f.open());XCTAssertEqual(f.queue.map { f.records.rows[$0]!.data }, before)
  }
  func testWrongAccountWorkspaceAndSessionCannotOpenArchive() throws {
    let f = try fixture();try f.retain();XCTAssertNil(try f.open(account: String(repeating: "b", count: 64)));XCTAssertNil(try f.open(workspace: UUID()));XCTAssertNil(try f.open(session: UUID()))
  }
  func testMissingKeyDoesNotGenerateReplacement() throws {
    let f = try fixture();try f.retain();f.keys.rows.removeAll();XCTAssertThrowsError(try f.open()!.audio(startMs: 0, endMs: 10, keys: f.keys, current: {}));XCTAssertTrue(f.keys.rows.isEmpty)
  }
  func testBoundedThirtySecondsAndInvalidRanges() throws {
    let f = try fixture(chunks: 4, frames: 160_000);try f.retain();let archive = try XCTUnwrap(f.open())
    XCTAssertEqual(try archive.audio(startMs: 5_000, endMs: 35_000, keys: f.keys, current: {})?.count, 960_044)
    for range in [(-1, 10), (0, 30_001), (10, 10), (12_600_000, 12_600_001)] { XCTAssertThrowsError(try archive.audio(startMs: range.0, endMs: range.1, keys: f.keys, current: {})) }
  }
  func testMissingArchiveChunkAndOutOfRangeAudioReturnUnavailable() throws {
    let f = try fixture();try f.retain();let archive = try XCTUnwrap(f.open());XCTAssertNil(try archive.audio(startMs: 30, endMs: 50, keys: f.keys, current: {}))
    let key = try XCTUnwrap(f.records.rows.keys.first { $0.hasSuffix("chunk:0") });f.records.rows.removeValue(forKey: key);XCTAssertNil(try archive.audio(startMs: 0, endMs: 10, keys: f.keys, current: {}))
  }
  func testTamperedArchiveCiphertextIsRejected() throws {
    let f = try fixture();try f.retain();let archive = try XCTUnwrap(f.open());let key = try XCTUnwrap(f.records.rows.keys.first { $0.hasSuffix("chunk:0") })
    var row = try JSONSerialization.jsonObject(with: f.records.rows[key]!.data) as! [String: Any];row["digest"] = String(repeating: "0", count: 64)
    f.records.rows[key] = NativeRecordingStoredRecord(data: try JSONSerialization.data(withJSONObject: row), revision: 1)
    XCTAssertThrowsError(try archive.audio(startMs: 0, endMs: 10, keys: f.keys, current: {}))
  }
  func testCancellationDuringPlaybackDoesNotReturnAudio() throws {
    let f = try fixture();try f.retain();let archive = try XCTUnwrap(f.open());var checks = 0
    XCTAssertThrowsError(try archive.audio(startMs: 0, endMs: 40, keys: f.keys, current: { checks += 1;if checks == 4 { throw CancellationError() } }))
  }
  func testStorageFailureRetainsOriginalUploadCustody() throws {
    let f = try fixture();let before = f.records.rows.mapValues(\.data);f.records.failBeforeWrite = true;XCTAssertThrowsError(try f.retain());XCTAssertEqual(f.records.rows.mapValues(\.data), before)
  }
  func testMissingQueuePositionRefusesCompleteArchive() throws {
    let f = try fixture();f.records.rows.removeValue(forKey: f.queue[0]);XCTAssertThrowsError(try f.retain());XCTAssertNil(try f.open())
  }
  func testThreeHourRetentionAndFinalPassageCost() throws {
    let f = try fixture(chunks: 1080, frames: 160_000)
    let start = DispatchTime.now().uptimeNanoseconds
    try f.retain()
    let retained = DispatchTime.now().uptimeNanoseconds
    let archive = try XCTUnwrap(f.open())
    f.records.bindingReads = []
    let audio = try XCTUnwrap(archive.audio(startMs: 10_770_000, endMs: 10_800_000, keys: f.keys, current: {}))
    let played = DispatchTime.now().uptimeNanoseconds
    XCTAssertEqual(audio.count, 960_044)
    XCTAssertEqual(f.records.bindingReads.filter { $0.contains(":chunk:") }.count, 3)
    XCTAssertEqual(audio.suffix(320_000), Data(repeating: UInt8(truncatingIfNeeded: 1080), count: 320_000))
    print("synthetic_passage_cost chunks=1080 frames=172800000 retention_ms=\(Double(retained - start) / 1_000_000) late_passage_ms=\(Double(played - retained) / 1_000_000) storage=in_memory disk_cost_excluded=true")
  }

  func testIndexAbsentUsesOriginalAuthenticatedArchive() throws {
    let f = try fixture();try f.retain()
    let key = try XCTUnwrap(f.records.rows.keys.first { $0.hasSuffix("frame-index") })
    f.records.rows.removeValue(forKey: key)
    let archive = try XCTUnwrap(f.open())
    XCTAssertEqual(try archive.audio(startMs: 20, endMs: 40, keys: f.keys, current: {})?.count, 684)
  }
  func testIndexRejectsWrongManifestAndSelectedFrameMismatch() throws {
    for field in ["manifestSHA256", "frames"] {
      let f = try fixture();try f.retain()
      let key = try XCTUnwrap(f.records.rows.keys.first { $0.hasSuffix("frame-index") })
      var raw = try JSONSerialization.jsonObject(with: f.records.rows[key]!.data) as! [String: Any]
      raw[field] = field == "manifestSHA256" ? String(repeating: "0", count: 64) : [321, 320] as Any
      f.records.rows[key] = NativeRecordingStoredRecord(data: try JSONSerialization.data(withJSONObject: raw), revision: 1)
      if field == "manifestSHA256" { XCTAssertThrowsError(try f.open()) }
      else { let archive = try XCTUnwrap(f.open());XCTAssertThrowsError(try archive.audio(startMs: 0, endMs: 10, keys: f.keys, current: {})) }
    }
  }

}
