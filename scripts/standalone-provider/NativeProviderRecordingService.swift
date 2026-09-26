import CoreFoundation
import CosmaneuraNativeRecording
import Foundation

/// Uses the same native token owner and fixed Core transport as the provider
/// app. Construction requires a context minted by a verified Core response.
@MainActor final class NativeProviderRecordingService: NativeRecordingBindingService {
  private let connection: NativeProviderConnection
  private let context: NativeProviderRecordingContext
  private var bindingRef: String { context.bindingRef }

  init(connection: NativeProviderConnection, context: NativeProviderRecordingContext) {
    self.connection = connection
    self.context = context
  }

  func recordingScope() async throws -> NativeRecordingScope {
    let fresh = try await connection.recordingContext(
      workspaceID: context.workspaceID, bindingRef: bindingRef, sessionID: context.sessionID,
      revision: connection.recordingRevision(accountDigest: context.accountDigest))
    return try NativeRecordingScope(
      tenantID: fresh.tenantID, sessionID: fresh.sessionID,
      workspaceID: fresh.workspaceID, accountDigest: fresh.accountDigest)
  }

  func publishedKey() async throws -> NativeRecordingPublicKey {
    let value = try await operation(kind: "encryption_key", intent: UUID())
    guard Set(value.keys) == ["key_version", "algorithm", "public_jwk"],
      let version = value["key_version"] as? String, Self.validVersion(version),
      value["algorithm"] as? String == "RSA-OAEP-256",
      let jwk = value["public_jwk"] as? [String: Any],
      Set(jwk.keys) == ["kty", "n", "e", "alg", "ext", "key_ops"],
      jwk["kty"] as? String == "RSA", jwk["alg"] as? String == "RSA-OAEP-256",
      jwk["e"] as? String == "AQAB", jwk["key_ops"] as? [String] == ["wrapKey"],
      let ext = jwk["ext"] as? NSNumber, CFGetTypeID(ext) == CFBooleanGetTypeID(),
      ext.boolValue, let modulus = jwk["n"] as? String
    else {
      throw ProviderNativeError.response
    }
    return try NativeRecordingPublicKey(version: version, modulusBase64URL: modulus)
  }

  func bind(key: NativeRecordingKeyReceipt, intent: UUID) async throws
    -> NativeRecordingBindingAcknowledgement
  {
    guard Self.validVersion(key.keyVersion), key.wrappedDEK.utf8.count == 512,
      key.wrappedDEK.range(of: "^[A-Za-z0-9_-]{512}$", options: .regularExpression) != nil
    else {
      throw ProviderNativeError.invalidRequest
    }
    let value = try await operation(
      kind: "bind_key", intent: intent,
      payload: ["key_version": key.keyVersion, "wrapped_dek": key.wrappedDEK])
    guard Set(value.keys) == ["session_id", "key_version", "created_at"],
      value["session_id"] as? String == context.sessionID.uuidString.lowercased(),
      value["key_version"] as? String == key.keyVersion,
      let created = value["created_at"] as? String, Self.date(created) != nil
    else {
      throw ProviderNativeError.response
    }
    return NativeRecordingBindingAcknowledgement(
      sessionID: context.sessionID,
      keyVersion: key.keyVersion)
  }

  private func operation(kind: String, intent: UUID, payload: [String: String]? = nil)
    async throws -> [String: Any]
  {
    let revision = try connection.recordingRevision(accountDigest: context.accountDigest)
    let nonce = UUID().uuidString.lowercased()
    var operation: [String: Any] = ["kind": kind]
    if let payload { operation["payload"] = payload }
    let body = try JSONSerialization.data(withJSONObject: [
      "workspace_id": context.workspaceID.uuidString.lowercased(), "binding_ref": bindingRef,
      "request_nonce": nonce, "operation": operation,
    ])
    let request = try ProviderNativeRequest(
      id: UUID().uuidString.lowercased(), revision: revision,
      action: "capture-operations", key: intent.uuidString.lowercased(),
      body: String(decoding: body, as: UTF8.self))
    let reply = try await connection.send(request)
    guard try connection.recordingRevision(accountDigest: context.accountDigest) == revision,
      reply.status == 200, reply.body.count <= 8192,
      let envelope = try JSONSerialization.jsonObject(with: reply.body) as? [String: Any],
      Set(envelope.keys) == [
        "contract_version", "binding_ref", "workspace_id", "request_nonce",
        "checked_at", "operation", "receipt",
      ],
      envelope["contract_version"] as? String == "1",
      envelope["workspace_id"] as? String == context.workspaceID.uuidString.lowercased(),
      envelope["binding_ref"] as? String == bindingRef,
      envelope["request_nonce"] as? String == nonce,
      envelope["operation"] as? String == kind,
      let timestamp = envelope["checked_at"] as? String, let checked = Self.date(timestamp),
      (-5...30).contains(Date().timeIntervalSince(checked)),
      let receipt = envelope["receipt"] as? [String: Any]
    else {
      throw ProviderNativeError.response
    }
    return receipt
  }

  private static func validVersion(_ value: String) -> Bool {
    value.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil
  }

  private static func date(_ value: String) -> Date? {
    guard value.utf8.count <= 40 else { return nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)
  }
}
