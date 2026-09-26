import CryptoKit
import Foundation
import Security

public enum NativeRecordingFailure: Error {
  case invalidBinding, invalidKey, keyUnavailable, keyConflict, invalidPacket, storageUnavailable
}

/// Supplied by the authenticated native host. It is not capture permission.
public struct NativeRecordingScope: Equatable, Sendable {
  public let tenantID: UUID
  public let sessionID: UUID
  public let workspaceID: UUID
  public let accountDigest: String

  public init(tenantID: UUID, sessionID: UUID, workspaceID: UUID, accountDigest: String) throws {
    guard accountDigest.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
      throw NativeRecordingFailure.invalidBinding
    }
    self.tenantID = tenantID
    self.sessionID = sessionID
    self.workspaceID = workspaceID
    self.accountDigest = accountDigest
  }

  var keyAccount: String {
    let value =
      "scribe-native-recording:v1:\(accountDigest):\(workspaceID.uuidString.lowercased()):\(tenantID.uuidString.lowercased()):\(sessionID.uuidString.lowercased())"
    return SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

public struct NativeRecordingPublicKey: Sendable {
  public let version: String
  let modulus: Data

  public init(version: String, modulusBase64URL: String) throws {
    guard !version.isEmpty, version.utf8.count <= 256, modulusBase64URL.utf8.count == 512,
      let modulus = nativeBase64URLDecode(modulusBase64URL), modulus.count == 384,
      modulus.first.map({ $0 & 0x80 != 0 }) == true,
      modulus.last.map({ $0 & 1 == 1 }) == true
    else { throw NativeRecordingFailure.invalidKey }
    self.version = version
    self.modulus = modulus
  }

  func wrappingKey() throws -> SecKey {
    // Apple's Security framework accepts the PKCS#1 public-key representation.
    func field(_ tag: UInt8, _ bytes: Data) -> Data {
      let length = bytes.count
      let prefix =
        length < 128
        ? Data([UInt8(length)])
        : Data([0x82, UInt8(length >> 8), UInt8(length & 255)])
      return Data([tag]) + prefix + bytes
    }
    let der = field(0x30, field(0x02, Data([0]) + modulus) + field(0x02, Data([1, 0, 1])))
    guard
      let key = SecKeyCreateWithData(
        der as CFData,
        [
          kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeyClass: kSecAttrKeyClassPublic,
          kSecAttrKeySizeInBits: 3072,
        ] as CFDictionary, nil), SecKeyGetBlockSize(key) == 384,
      SecKeyIsAlgorithmSupported(key, .encrypt, .rsaEncryptionOAEPSHA256)
    else { throw NativeRecordingFailure.invalidKey }
    return key
  }
}

public struct NativeRecordingKeyReceipt: Equatable, Sendable {
  public let keyVersion: String
  public let wrappedDEK: String
  public init(keyVersion: String, wrappedDEK: String) {
    self.keyVersion = keyVersion
    self.wrappedDEK = wrappedDEK
  }
}

/// A native-only adapter. No key export, replace, delete, or bridge methods.
public protocol NativeRecordingKeyStorage: Sendable {
  func read(account: String) throws -> Data?
  func insert(account: String, value: Data) throws
}

public struct KeychainNativeRecordingStorage: NativeRecordingKeyStorage {
  public init() {}

  static func query(_ account: String) -> [CFString: Any] {
    [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: "com.cosmaneura.capture.native-session-key.v1",
      kSecAttrAccount: account, kSecAttrSynchronizable: false,
    ]
  }

  public func read(account: String) throws -> Data? {
    var query = Self.query(account)
    query[kSecReturnData] = true
    query[kSecMatchLimit] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw NativeRecordingFailure.keyUnavailable
    }
    return data
  }

  public func insert(account: String, value: Data) throws {
    var query = Self.query(account)
    query[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    query[kSecValueData] = value
    let status = SecItemAdd(query as CFDictionary, nil)
    if status == errSecDuplicateItem { throw NativeRecordingFailure.keyConflict }
    guard status == errSecSuccess else { throw NativeRecordingFailure.keyUnavailable }
  }
}

/// Generates the session DEK natively and retains it in device-only Keychain.
/// The public result contains only the existing server-wrapped key contract.
public final class NativeRecordingEncryption: Sendable {
  public let scope: NativeRecordingScope
  public let receipt: NativeRecordingKeyReceipt
  private let key: SymmetricKey

  private struct StoredKey: Codable {
    let version: Int
    let account: String
    let keyVersion: String
    let publicKeyDigest: String
    var raw: Data
    let wrapped: Data
    let bindingIntent: UUID?
  }

  private init(scope: NativeRecordingScope, stored: StoredKey) throws {
    guard stored.version == 1, stored.account == scope.keyAccount,
      stored.raw.count == 32, stored.wrapped.count == 384,
      !stored.keyVersion.isEmpty, stored.keyVersion.utf8.count <= 256,
      stored.publicKeyDigest.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    else { throw NativeRecordingFailure.keyUnavailable }
    self.scope = scope
    key = SymmetricKey(data: stored.raw)
    receipt = NativeRecordingKeyReceipt(
      keyVersion: stored.keyVersion,
      wrappedDEK: nativeBase64URL(stored.wrapped))
  }

  /// Only call for an explicitly new, admitted session before server key binding.
  /// Existing or ambiguously written keys are never silently replaced.
  public static func create(
    scope: NativeRecordingScope, published: NativeRecordingPublicKey,
    storage: any NativeRecordingKeyStorage = KeychainNativeRecordingStorage()
  ) throws -> NativeRecordingEncryption {
    try create(scope: scope, published: published, storage: storage, bindingIntent: nil)
  }

  /// The native host must retain this intent before a new session's key bind.
  /// Replaying that exact intent recovers an interrupted creation; it cannot
  /// adopt a legacy key, change wrapping keys, or replace missing bound custody.
  /// This is not the reopen path for an already-bound recording.
  public static func prepareBindingCandidate(
    scope: NativeRecordingScope, published: NativeRecordingPublicKey, intent: UUID,
    storage: any NativeRecordingKeyStorage = KeychainNativeRecordingStorage()
  ) throws -> NativeRecordingEncryption {
    if let retained = try retainedCandidate(
      scope: scope, published: published, intent: intent, storage: storage)
    {
      return retained
    }
    do {
      return try create(
        scope: scope, published: published, storage: storage, bindingIntent: intent)
    } catch {
      // An insert may commit before reporting failure. Read back the immutable
      // candidate under the same intent; never generate again in this call.
      if let retained = try retainedCandidate(
        scope: scope, published: published, intent: intent, storage: storage)
      {
        return retained
      }
      throw error
    }
  }

  private static func retainedCandidate(
    scope: NativeRecordingScope, published: NativeRecordingPublicKey, intent: UUID,
    storage: any NativeRecordingKeyStorage
  ) throws -> NativeRecordingEncryption? {
    guard var encoded = try storage.read(account: scope.keyAccount) else { return nil }
    defer { encoded.resetBytes(in: 0..<encoded.count) }
    guard encoded.count <= 4096 else { throw NativeRecordingFailure.keyUnavailable }
    var stored: StoredKey
    do { stored = try PropertyListDecoder().decode(StoredKey.self, from: encoded) } catch {
      throw NativeRecordingFailure.keyUnavailable
    }
    defer { stored.raw.resetBytes(in: 0..<stored.raw.count) }
    guard stored.bindingIntent == intent, stored.keyVersion == published.version,
      stored.publicKeyDigest
        == SHA256.hash(data: published.modulus)
        .map({ String(format: "%02x", $0) }).joined()
    else { throw NativeRecordingFailure.keyConflict }
    return try NativeRecordingEncryption(scope: scope, stored: stored)
  }

  private static func create(
    scope: NativeRecordingScope, published: NativeRecordingPublicKey,
    storage: any NativeRecordingKeyStorage, bindingIntent: UUID?
  ) throws -> NativeRecordingEncryption {
    guard try storage.read(account: scope.keyAccount) == nil else {
      throw NativeRecordingFailure.keyConflict
    }
    let wrapping = try published.wrappingKey()
    var raw = Data(count: 32)
    defer { raw.resetBytes(in: 0..<raw.count) }
    let status = raw.withUnsafeMutableBytes { buffer in
      SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
    }
    guard status == errSecSuccess,
      let encrypted = SecKeyCreateEncryptedData(
        wrapping, .rsaEncryptionOAEPSHA256, raw as CFData, nil)
    else { throw NativeRecordingFailure.keyUnavailable }
    var stored = StoredKey(
      version: 1, account: scope.keyAccount, keyVersion: published.version,
      publicKeyDigest: SHA256.hash(data: published.modulus).map { String(format: "%02x", $0) }
        .joined(),
      raw: raw, wrapped: encrypted as Data, bindingIntent: bindingIntent)
    defer { stored.raw.resetBytes(in: 0..<stored.raw.count) }
    let result = try NativeRecordingEncryption(scope: scope, stored: stored)
    var encoded = try PropertyListEncoder().encode(stored)
    defer { encoded.resetBytes(in: 0..<encoded.count) }
    try storage.insert(account: scope.keyAccount, value: encoded)
    return result
  }

  /// Recovery never generates a replacement if the retained key is missing.
  public static func reopen(
    scope: NativeRecordingScope, expected: NativeRecordingKeyReceipt,
    storage: any NativeRecordingKeyStorage = KeychainNativeRecordingStorage()
  ) throws -> NativeRecordingEncryption {
    guard var encoded = try storage.read(account: scope.keyAccount), encoded.count <= 4096 else {
      throw NativeRecordingFailure.keyUnavailable
    }
    defer { encoded.resetBytes(in: 0..<encoded.count) }
    var stored: StoredKey
    do { stored = try PropertyListDecoder().decode(StoredKey.self, from: encoded) } catch {
      throw NativeRecordingFailure.keyUnavailable
    }
    defer { stored.raw.resetBytes(in: 0..<stored.raw.count) }
    let result = try NativeRecordingEncryption(scope: scope, stored: stored)
    guard result.receipt == expected else { throw NativeRecordingFailure.keyConflict }
    return result
  }

  /// Input is the existing 16-kHz mono PCM16 packet. Consume and clear it even
  /// on failure; only authenticated ciphertext leaves this method.
  public func seal(
    pcm16: inout Data, objectID: UUID, sequence: Int,
    additionalAuthenticatedData: String
  ) throws -> Data {
    defer { pcm16.resetBytes(in: 0..<pcm16.count) }
    guard (0..<2048).contains(sequence), additionalAuthenticatedData.utf8.count <= 1024,
      !pcm16.isEmpty, pcm16.count <= 320_000,
      pcm16.count.isMultiple(of: 2)
    else { throw NativeRecordingFailure.invalidPacket }
    let aad = try JSONSerialization.data(
      withJSONObject: [
        "channel": "microphone", "object_id": objectID.uuidString.lowercased(),
        "sequence_number": sequence, "session_id": scope.sessionID.uuidString.lowercased(),
        "tenant_id": scope.tenantID.uuidString.lowercased(),
      ], options: [.sortedKeys, .withoutEscapingSlashes])
    guard nativeBase64URLDecode(additionalAuthenticatedData) == aad else {
      throw NativeRecordingFailure.invalidBinding
    }
    var wav = Data("RIFF".utf8)
    func little(_ value: UInt32, width: Int = 4) -> Data {
      Data((0..<width).map { UInt8((value >> ($0 * 8)) & 255) })
    }
    wav.append(little(UInt32(36 + pcm16.count)))
    wav.append(Data("WAVEfmt ".utf8))
    wav.append(little(16))
    wav.append(little(1, width: 2))
    wav.append(little(1, width: 2))
    wav.append(little(16_000))
    wav.append(little(32_000))
    wav.append(little(2, width: 2))
    wav.append(little(16, width: 2))
    wav.append(Data("data".utf8))
    wav.append(little(UInt32(pcm16.count)))
    wav.append(pcm16)
    defer { wav.resetBytes(in: 0..<wav.count) }
    let sealed = try AES.GCM.seal(wav, using: key, authenticating: aad)
    let nonce = sealed.nonce.withUnsafeBytes { Data($0) }
    let header = try JSONSerialization.data(
      withJSONObject: [
        "schema_version": "1.0", "content_encryption": "A256GCM",
        "nonce": nativeBase64URL(nonce), "media_type": "audio/wav",
      ], options: [.sortedKeys, .withoutEscapingSlashes])
    var envelope = Data("CSCRIBE1".utf8)
    let length = UInt32(header.count)
    envelope.append(contentsOf: [
      UInt8(length >> 24), UInt8((length >> 16) & 255),
      UInt8((length >> 8) & 255), UInt8(length & 255),
    ])
    envelope.append(header)
    envelope.append(sealed.ciphertext)
    envelope.append(sealed.tag)
    guard envelope.count <= 327_680 else { throw NativeRecordingFailure.invalidPacket }
    return envelope
  }
}

func nativeBase64URL(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

func nativeBase64URLDecode(_ value: String) -> Data? {
  guard value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { return nil }
  let base = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  let padded = base + String(repeating: "=", count: (4 - base.count % 4) % 4)
  guard let bytes = Data(base64Encoded: padded), nativeBase64URL(bytes) == value else { return nil }
  return bytes
}
