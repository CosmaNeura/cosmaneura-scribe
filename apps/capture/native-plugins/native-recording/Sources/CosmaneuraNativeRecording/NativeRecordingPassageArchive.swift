import CoreFoundation
import CryptoKit
import Foundation

/// Native-only, device-encrypted review copies. Upload queue registration and
/// purge remain independent. The generic SecureQueue bridge rejects this prefix.
public final class NativeRecordingPassageArchive: Sendable {
  private struct Manifest: Codable, Equatable, Sendable {
    let version: Int, tenant: UUID, workspace: UUID, session: UUID, recovery: UUID
    let account: String, keyVersion: String, wrappedDEK: String
    let chunks: Int, complete: Bool
  }
  private struct Chunk: Codable, Equatable {
    let version: Int, object: UUID, sequence: Int, frames: Int
    let aad: String, envelope: Data, digest: String
  }
  private struct Index: Codable { let version: Int; let manifestSHA256: String; let frames: [Int] }
  private let frameIndex: [Int]?
  private let manifest: Manifest
  private let prefix: String
  private let records: any NativeRecordingBindingRecordStore
  private init(_ manifest: Manifest, frameIndex: [Int]?, prefix: String, records: any NativeRecordingBindingRecordStore) {
    self.frameIndex = frameIndex; self.manifest = manifest; self.prefix = prefix; self.records = records
  }
  private static func prefix(account: String, recovery: UUID, workspace: UUID, session: UUID) throws -> String {
    guard account.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
      throw NativeRecordingFailure.invalidBinding
    }
    // Hash only the lookup key, retaining every original authority component.
    let scope = "\(account):\(recovery):\(workspace):\(session)"
    return "scribe-native-passage:v1:" + SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined() + ":"
  }
  private static func encode<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; return try encoder.encode(value)
  }
  private static func write<T: Encodable>(_ value: T, key: String, records: any NativeRecordingBindingRecordStore) throws {
    let data = try encode(value)
    if let prior = try records.readBinding(key: key) {
      guard prior.revision == 1, prior.data == data else { throw NativeRecordingFailure.keyConflict }
      return
    }
    do { try records.createBinding(key: key, data: data) }
    catch {
      // A lost write response cannot authorize a second, different archive.
      guard let saved = try records.readBinding(key: key), saved.revision == 1, saved.data == data else { throw error }
    }
  }
  /// Called only after physical stop and native seal, before any upload purge.
  /// Old already-purged recordings stay uploadable but cannot invent review audio.
  public static func retain(encryption: NativeRecordingEncryption, recovery: UUID,
    chunks: Int, records: any NativeRecordingFlowStore, current: () throws -> Void) throws {
    try current()
    guard (1...2048).contains(chunks) else { throw NativeRecordingFailure.invalidPacket }
    let scope = encryption.scope, queue = scope.queuePrefix(recoveryScope: recovery)
    let archive = try prefix(account: scope.accountDigest, recovery: recovery, workspace: scope.workspaceID, session: scope.sessionID)
    let keys = try records.listRecordingKeys(prefix: queue)
    guard keys.count <= 2048, Set(keys).count == keys.count else { throw NativeRecordingFailure.invalidPacket }
    var positions = Set<Int>(), complete = true
    var frames = [Int](repeating: 0, count: chunks)
    for key in keys {
      try current()
      guard key.hasPrefix(queue), let object = UUID(uuidString: String(key.dropFirst(queue.count))),
        key == queue + object.uuidString.lowercased() else { throw NativeRecordingFailure.invalidBinding }
      try autoreleasepool {
        let stored = try records.read(key: key)
        guard stored.data.count <= 524_288, stored.revision > 0,
          let raw = try JSONSerialization.jsonObject(with: stored.data) as? [String: Any],
          let r = raw["reservation"] as? [String: Any],
          r["sessionId"] as? String == scope.sessionID.uuidString.lowercased(),
          r["objectId"] as? String == object.uuidString.lowercased(),
          r["channel"] as? String == "microphone", r["protocolVersion"] as? String == "1.0",
          let n = r["sequenceNumber"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
          (0..<2048).contains(n.intValue), n.doubleValue == Double(n.intValue),
          positions.insert(n.intValue).inserted, let state = raw["state"] as? String,
          let aad = r["additionalAuthenticatedData"] as? String,
          nativeBase64URLDecode(aad) == (try scope.additionalData(objectID: object, sequence: n.intValue))
        else { throw NativeRecordingFailure.invalidBinding }
        let sequence = n.intValue, key = archive + "chunk:\(sequence)"
        if sequence >= chunks {
          guard state == "reserved" else { throw NativeRecordingFailure.invalidPacket }; return
        }
        if state == "purged" {
          if let saved = try records.readBinding(key: key) {
            let chunk = try decodeChunk(saved, sequence: sequence)
            guard chunk.object == object, chunk.aad == aad else { throw NativeRecordingFailure.invalidBinding }
            frames[sequence] = chunk.frames
          } else { complete = false }
          return
        }
        guard ["encrypted", "uploading", "uploaded", "registered"].contains(state),
          let text = raw["envelope"] as? String, let envelope = nativeBase64URLDecode(text),
          let length = raw["byteLength"] as? NSNumber, CFGetTypeID(length) != CFBooleanGetTypeID(),
          length.doubleValue == Double(envelope.count), let digest = raw["sha256"] as? String,
          digest == SHA256.hash(data: envelope).map({ String(format: "%02x", $0) }).joined()
        else { throw NativeRecordingFailure.invalidPacket }
        let bytes = try encryption.authenticatedPlaintextBytes(envelope: envelope, objectID: object,
          sequence: sequence, additionalAuthenticatedData: aad)
        try current()
        frames[sequence] = (bytes - 44) / 2
        guard try records.availableBytes() >= 67_108_864 + envelope.count * 4 else { throw NativeRecordingFailure.storageUnavailable }
        try write(Chunk(version: 1, object: object, sequence: sequence, frames: (bytes - 44) / 2,
          aad: aad, envelope: envelope, digest: digest), key: key, records: records)
      }
    }
    guard (0..<chunks).allSatisfy({ positions.contains($0) }) else { throw NativeRecordingFailure.invalidPacket }
    try current()
    let manifest = Manifest(version: 1, tenant: scope.tenantID, workspace: scope.workspaceID,
      session: scope.sessionID, recovery: recovery, account: scope.accountDigest,
      keyVersion: encryption.receipt.keyVersion, wrappedDEK: encryption.receipt.wrappedDEK, chunks: chunks, complete: complete)
    if complete {
      guard frames.allSatisfy({ (1...160_000).contains($0) }) else { throw NativeRecordingFailure.invalidPacket }
      let digest = SHA256.hash(data: try encode(manifest)).map { String(format: "%02x", $0) }.joined()
      try write(Index(version: 1, manifestSHA256: digest, frames: frames), key: archive + "frame-index", records: records)
    }
    try current()
    try write(manifest, key: archive + "manifest", records: records)
  }
  /// Native caller must freshly authorize this exact current account, mount,
  /// session and server segment before calling audio(). No capture authority.
  public static func open(account: String, recovery: UUID, workspace: UUID, session: UUID,
    records: any NativeRecordingBindingRecordStore) throws -> NativeRecordingPassageArchive? {
    let prefix = try prefix(account: account, recovery: recovery, workspace: workspace, session: session)
    guard let saved = try records.readBinding(key: prefix + "manifest") else { return nil }
    guard saved.revision == 1, saved.data.count <= 4096 else { throw NativeRecordingFailure.invalidBinding }
    let m = try JSONDecoder().decode(Manifest.self, from: saved.data)
    guard m.version == 1, m.account == account, m.recovery == recovery, m.workspace == workspace,
      m.session == session, (1...2048).contains(m.chunks) else { throw NativeRecordingFailure.invalidBinding }
    guard m.complete else { return nil }
    var frameIndex: [Int]?
    if let savedIndex = try records.readBinding(key: prefix + "frame-index") {
      guard savedIndex.revision == 1, savedIndex.data.count <= 32_768 else { throw NativeRecordingFailure.invalidPacket }
      let index = try JSONDecoder().decode(Index.self, from: savedIndex.data)
      guard index.version == 1, index.frames.count == m.chunks,
        index.frames.allSatisfy({ (1...160_000).contains($0) }),
        index.manifestSHA256 == SHA256.hash(data: saved.data).map({ String(format: "%02x", $0) }).joined()
      else { throw NativeRecordingFailure.invalidPacket }
      frameIndex = index.frames
    }
    return NativeRecordingPassageArchive(m, frameIndex: frameIndex, prefix: prefix, records: records)
  }
  private static func decodeChunk(_ saved: NativeRecordingStoredRecord, sequence: Int) throws -> Chunk {
    guard saved.revision == 1, saved.data.count <= 524_288 else { throw NativeRecordingFailure.invalidPacket }
    let c = try JSONDecoder().decode(Chunk.self, from: saved.data)
    guard c.version == 1, c.sequence == sequence, (1...160_000).contains(c.frames),
      (72...327_680).contains(c.envelope.count), c.envelope.prefix(8) == Data("CSCRIBE1".utf8),
      c.digest == SHA256.hash(data: c.envelope).map({ String(format: "%02x", $0) }).joined()
    else { throw NativeRecordingFailure.invalidPacket }
    let header = c.envelope[8..<12].reduce(0) { ($0 << 8) | Int($1) }
    guard (1...4096).contains(header), c.envelope.count == 12 + header + 16 + 44 + c.frames * 2 else {
      throw NativeRecordingFailure.invalidPacket
    }
    return c
  }
  /// Up to 30 seconds from the server-selected segment. Keys never leave Swift;
  /// the caller owns the returned in-memory WAV and must clear it after playback
  /// preparation. No URL, file path, renderer time range or plaintext disk API.
  public func audio(startMs: Int, endMs: Int, keys: any NativeRecordingKeyStorage = KeychainNativeRecordingStorage(),
    current: () throws -> Void) throws -> Data? {
    try current()
    guard startMs >= 0, endMs > startMs, endMs <= 12_600_000, endMs - startMs <= 30_000 else {
      throw NativeRecordingFailure.invalidPacket
    }
    let scope = try NativeRecordingScope(tenantID: manifest.tenant, sessionID: manifest.session,
      workspaceID: manifest.workspace, accountDigest: manifest.account)
    let encryption = try NativeRecordingEncryption.reopen(scope: scope,
      expected: NativeRecordingKeyReceipt(keyVersion: manifest.keyVersion, wrappedDEK: manifest.wrappedDEK), storage: keys)
    let from = startMs * 16, until = endMs * 16
    var samples = Data(); defer { samples.resetBytes(in: 0..<samples.count) }
    var position = 0
    for sequence in 0..<manifest.chunks {
      try current()
      if let frameIndex, position + frameIndex[sequence] <= from {
        position += frameIndex[sequence]; continue
      }
      guard let saved = try records.readBinding(key: prefix + "chunk:\(sequence)") else { return nil }
      let c = try Self.decodeChunk(saved, sequence: sequence)
      if let frameIndex, c.frames != frameIndex[sequence] { throw NativeRecordingFailure.invalidPacket }
      if position + c.frames > from && position < until {
        var wav = try encryption.authenticatedWav(envelope: c.envelope, objectID: c.object,
          sequence: sequence, additionalAuthenticatedData: c.aad)
        defer { wav.resetBytes(in: 0..<wav.count) }
        guard (wav.count - 44) / 2 == c.frames else { throw NativeRecordingFailure.invalidPacket }
        try current()
        let lo = max(0, from - position), hi = min(c.frames, until - position)
        samples.append(wav.subdata(in: (44 + lo * 2)..<(44 + hi * 2)))
      }
      position += c.frames
      if position >= until { break }
    }
    guard position >= until, samples.count == (until - from) * 2 else { return nil }
    try current()
    var wav = Data("RIFF".utf8)
    func append(_ value: Int, bytes: Int = 4) { wav.append(contentsOf: (0..<bytes).map { UInt8((value >> ($0 * 8)) & 255) }) }
    append(36 + samples.count); wav.append(Data("WAVEfmt ".utf8)); append(16); append(1, bytes: 2); append(1, bytes: 2)
    append(16_000); append(32_000); append(2, bytes: 2); append(16, bytes: 2); wav.append(Data("data".utf8)); append(samples.count); wav.append(samples)
    return wav
  }
}
