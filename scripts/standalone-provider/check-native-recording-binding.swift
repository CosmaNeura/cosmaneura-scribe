import CosmaneuraNativeRecording
import CosmasNativeAuth
import Foundation
import Security

// Offline integration: real native auth policy, Core client, binding journal and
// Apple encryption, with synthetic replies and in-memory custody/storage only.
private actor BindingWire: ProviderNativeWire {
  let workspace = UUID(), session = UUID(), tenant = UUID()
  let binding = "scribe_capture_binding_01j00000000000000000000000"
  let modulus: String
  let lease = UUID()
  var fault = "none"
  var requests: [ProviderNativeRequest] = []
  init(_ modulus: String) { self.modulus = modulus }
  func setFault(_ value: String) { fault = value }
  func send(_ request: ProviderNativeRequest, token: String) async throws -> ProviderNativeReply {
    try require(token.split(separator: ".").count == 3)
    requests.append(request)
    let body = try JSONSerialization.jsonObject(with: request.body) as! [String: Any]
    try require(Set(body.keys) == ["workspace_id", "binding_ref", "request_nonce", "operation"])
    try require(body["binding_ref"] as? String == binding)
    try require(body["workspace_id"] as? String == workspace.uuidString.lowercased())
    let operation = body["operation"] as! [String: Any]
    let kind = operation["kind"] as! String
    var receipt: [String: Any]
    if kind == "native_recording_context" {
      receipt = [
        "schema_version": "1.0", "workspace_id": workspace.uuidString.lowercased(),
        "tenant_id": tenant.uuidString.lowercased(), "session_id": session.uuidString.lowercased(),
        "status": "created",
      ]
    } else if kind == "encryption_key" {
      try require(Set(operation.keys) == ["kind"])
      var jwk: [String: Any] = [
        "kty": "RSA", "alg": "RSA-OAEP-256", "e": "AQAB",
        "key_ops": ["wrapKey"], "n": modulus, "ext": true,
      ]
      switch fault {
      case "exponent": jwk["e"] = "Aw"
      case "modulus": jwk["n"] = "bad"
      case "key_ops": jwk["key_ops"] = ["encrypt"]
      case "numeric_ext": jwk["ext"] = 1
      case "false_ext": jwk["ext"] = false
      case "extra_jwk": jwk["d"] = "private-input-refused"
      default: break
      }
      receipt = [
        "key_version": fault == "key_version" ? "bad version" : "synthetic-v1",
        "algorithm": fault == "algorithm" ? "RSA1_5" : "RSA-OAEP-256", "public_jwk": jwk,
      ]
    } else if kind == "issue_lease" || kind == "renew_lease" {
      let renewing = kind == "renew_lease"
      try require(
        Set(operation.keys) == (renewing ? ["kind", "payload", "lease_id"] : ["kind", "payload"]))
      let payload = operation["payload"] as! [String: Any]
      try require(
        Set(payload.keys)
          == (renewing ? ["protocol_version", "expected_generation"] : ["protocol_version"]))
      try require(
        payload["protocol_version"] as? String == "1.0" && UUID(uuidString: request.key) != nil)
      if renewing {
        try require(operation["lease_id"] as? String == lease.uuidString.lowercased())
        try require(payload["expected_generation"] as? Int == 1)
      }
      let issued = Date()
      receipt = [
        "protocol_version": "1.0", "receipt_id": UUID().uuidString.lowercased(),
        "lease_id": lease.uuidString.lowercased(), "session_id": session.uuidString.lowercased(),
        "generation": renewing ? 2 : 1,
        "issued_at": ISO8601DateFormatter().string(from: issued),
        "expires_at": ISO8601DateFormatter().string(from: issued.addingTimeInterval(900)),
      ]
      switch fault {
      case "lease_id": receipt["lease_id"] = UUID().uuidString.lowercased()
      case "receipt_id": receipt["receipt_id"] = "invalid"
      case "session": receipt["session_id"] = UUID().uuidString.lowercased()
      case "generation": receipt["generation"] = 3
      case "boolean_generation": receipt["generation"] = true
      case "issued_at": receipt["issued_at"] = "invalid"
      case "expires_at":
        receipt["expires_at"] = ISO8601DateFormatter().string(from: issued.addingTimeInterval(901))
      case "protocol": receipt["protocol_version"] = "2.0"
      default: break
      }
    } else {
      try require(kind == "bind_key" && Set(operation.keys) == ["kind", "payload"])
      let payload = operation["payload"] as! [String: String]
      try require(Set(payload.keys) == ["key_version", "wrapped_dek"])
      try require(UUID(uuidString: request.key) != nil)
      if fault == "lost" { throw ProviderNativeError.response }
      receipt = [
        "session_id": fault == "session"
          ? UUID().uuidString.lowercased() : session.uuidString.lowercased(),
        "key_version": fault == "key_version" ? "other" : payload["key_version"]!,
        "created_at": fault == "created_at"
          ? "invalid" : ISO8601DateFormatter().string(from: Date()),
      ]
    }
    if fault == "extra_receipt" { receipt["unexpected"] = true }
    var envelope: [String: Any] = [
      "contract_version": "1", "workspace_id": workspace.uuidString.lowercased(),
      "binding_ref": binding, "request_nonce": body["request_nonce"]!, "operation": kind,
      "checked_at": ISO8601DateFormatter().string(from: Date()), "receipt": receipt,
    ]
    switch fault {
    case "nonce": envelope["request_nonce"] = UUID().uuidString.lowercased()
    case "binding": envelope["binding_ref"] = "scribe_capture_binding_01j00000000000000000000001"
    case "workspace": envelope["workspace_id"] = UUID().uuidString.lowercased()
    case "operation": envelope["operation"] = "other"
    case "contract": envelope["contract_version"] = "2"
    case "old", "future":
      envelope["checked_at"] = ISO8601DateFormatter().string(
        from: Date().addingTimeInterval(fault == "old" ? -60 : 60))
    case "date": envelope["checked_at"] = 123
    case "extra": envelope["unexpected"] = true
    case "large": envelope["padding"] = String(repeating: "x", count: 8192)
    default: break
    }
    return ProviderNativeReply(
      status: fault == "denied" ? 403 : 200,
      body: try JSONSerialization.data(withJSONObject: envelope))
  }
}

private final class BindingKeys: NativeRecordingKeyStorage, @unchecked Sendable {
  private let lock = NSLock()
  private var values: [String: Data] = [:]
  func read(account: String) throws -> Data? { lock.withLock { values[account] } }
  func insert(account: String, value: Data) throws {
    try lock.withLock {
      guard values[account] == nil else { throw NativeRecordingFailure.keyConflict }
      values[account] = value
    }
  }
}

private final class BindingRecords: NativeRecordingBindingRecordStore, @unchecked Sendable {
  private let lock = NSLock()
  private var values: [String: NativeRecordingStoredRecord] = [:]
  func readBinding(key: String) throws -> NativeRecordingStoredRecord? {
    lock.withLock { values[key] }
  }
  func createBinding(key: String, data: Data) throws { try write(key, data, 0) }
  func compareAndSwapBinding(key: String, expectedRevision: UInt64, data: Data) throws {
    try write(key, data, expectedRevision)
  }
  private func write(_ key: String, _ data: Data, _ revision: UInt64) throws {
    try lock.withLock {
      guard values[key]?.revision ?? 0 == revision else {
        throw NativeRecordingFailure.storageUnavailable
      }
      values[key] = NativeRecordingStoredRecord(data: data, revision: revision + 1)
    }
  }
}

@main struct CheckNativeRecordingBinding {
  @MainActor private static func make(_ modulus: String) async throws
    -> (
      NativeWorkspaceAuth, Driver, BindingWire, NativeProviderConnection,
      NativeProviderRecordingService
    )
  {
    let driver = Driver()
    let wire = BindingWire(modulus)
    let policy = try NativeTokenPolicy(
      issuer: "https://identity.clerk.accounts.dev", audience: "offline-provider")
    let auth = NativeWorkspaceAuth(
      enabled: true, organizationID: "org_offline", tokenPolicy: policy,
      driver: { driver }, accessBlock: { Block() })
    let connection = NativeProviderConnection(auth: auth, wire: wire)
    auth.onChange = { [weak connection] state in connection?.authChanged(state) }
    let context = try await connection.recordingContext(
      workspaceID: wire.workspace, bindingRef: wire.binding,
      sessionID: wire.session, revision: auth.state().revision)
    try require(context.bindingRef == wire.binding)
    return (
      auth, driver, wire, connection,
      NativeProviderRecordingService(connection: connection, context: context)
    )
  }

  @MainActor static func main() async throws {
    let key = SecKeyCreateRandomKey(
      [
        kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeySizeInBits: 3072,
        kSecAttrIsPermanent: false,
      ] as CFDictionary, nil)!
    let der = SecKeyCopyExternalRepresentation(SecKeyCopyPublicKey(key)!, nil)! as Data
    let modulus = der.subdata(in: 9..<393).base64EncodedString().replacingOccurrences(
      of: "+", with: "-"
    )
    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    let receipt = NativeRecordingKeyReceipt(
      keyVersion: "synthetic-v1", wrappedDEK: String(repeating: "A", count: 512))
    var checks = 0
    let envelopeFaults = [
      "none", "nonce", "binding", "workspace", "operation", "contract", "old", "future",
      "date", "extra", "large", "denied", "extra_receipt",
    ]
    for action in ["key", "bind"] {
      let faults =
        envelopeFaults
        + (action == "key"
          ? [
            "exponent", "modulus", "key_ops", "numeric_ext", "false_ext", "extra_jwk",
            "key_version", "algorithm",
          ]
          : ["session", "key_version", "created_at"])
      for fault in faults {
        let (_, driver, wire, connection, service) = try await make(modulus)
        await wire.setFault(fault)
        let operation = Task {
          if action == "key" {
            _ = try await service.publishedKey()
          } else {
            _ = try await service.bind(key: receipt, intent: UUID())
          }
        }
        if fault == "none" {
          try await operation.value
        } else {
          try await CheckNativeProvider.rejected(operation)
        }
        let requests = await wire.requests
        try require(driver.tokens == 2 && requests.count == 2)
        connection.close()
        checks += 1
      }
    }
    for renewing in [false, true] {
      for fault in envelopeFaults + [
        "receipt_id", "session", "generation", "boolean_generation", "issued_at", "expires_at",
        "protocol",
      ] + (renewing ? ["lease_id"] : []) {
        let (_, driver, wire, connection, service) = try await make(modulus)
        let formatter = ISO8601DateFormatter()
        let now = Date()
        let previous = try NativeRecordingLease(
          receiptID: UUID(), leaseID: wire.lease,
          sessionID: wire.session, generation: 1,
          issuedAt: formatter.string(from: now.addingTimeInterval(-600)),
          expiresAt: formatter.string(from: now.addingTimeInterval(300)))
        await wire.setFault(fault)
        let operation = Task {
          try await service.requestLease(previous: renewing ? previous : nil, intent: UUID())
        }
        if fault == "none" {
          _ = try await operation.value
        } else {
          try await CheckNativeProvider.rejected(operation)
        }
        let leaseRequests = await wire.requests
        try require(driver.tokens == 2 && leaseRequests.count == 2)
        connection.close()
        checks += 1
      }
    }
    do {
      let (auth, driver, wire, connection, service) = try await make(modulus)
      let scope = try await service.recordingScope()
      let before = await wire.requests.count
      for invalid in [
        NativeRecordingKeyReceipt(keyVersion: "invalid version", wrappedDEK: receipt.wrappedDEK),
        NativeRecordingKeyReceipt(keyVersion: receipt.keyVersion, wrappedDEK: "bad"),
      ] {
        try await CheckNativeProvider.rejected(
          Task { try await service.bind(key: invalid, intent: UUID()) })
      }
      let old = auth.state().revision
      driver.identity = try .init(
        userID: "user_offline", sessionID: "sess_new", organizationID: "org_offline")
      try require(connection.recordingRevision(accountDigest: scope.accountDigest) != old)
      driver.identity = try .init(
        userID: "user_other", sessionID: "sess_other", organizationID: "org_offline")
      try await CheckNativeProvider.rejected(Task { try await service.publishedKey() })
      try await CheckNativeProvider.rejected(
        Task { try await service.bind(key: receipt, intent: UUID()) })
      try require(await wire.requests.count == before)
      connection.close()
      checks += 1
    }
    do {
      let (_, driver, wire, connection, service) = try await make(modulus)
      let scope = try await service.recordingScope()
      let keys = BindingKeys()
      let records = BindingRecords()
      await wire.setFault("lost")
      let owner = NativeRecordingBindingOwner(
        scope: scope, service: service, records: records, keys: keys)
      try await CheckNativeProvider.rejected(Task { try await owner.open() })
      await wire.setFault("none")
      let reopened = NativeRecordingBindingOwner(
        scope: scope, service: service, records: records, keys: keys)
      let cipher = try await reopened.open()
      let again = try await reopened.open()
      try require(again.receipt == cipher.receipt)
      let requests = await wire.requests
      var binds: [ProviderNativeRequest] = []
      var keyReads = 0
      for request in requests {
        let body = try JSONSerialization.jsonObject(with: request.body) as! [String: Any]
        let operation = body["operation"] as! [String: Any]
        if operation["kind"] as? String == "bind_key" { binds.append(request) }
        if operation["kind"] as? String == "encryption_key" { keyReads += 1 }
      }
      try require(binds.count == 2 && keyReads == 1 && binds[0].key == binds[1].key)
      let first = try JSONSerialization.jsonObject(with: binds[0].body) as! [String: Any]
      let second = try JSONSerialization.jsonObject(with: binds[1].body) as! [String: Any]
      try require(
        JSONSerialization.data(withJSONObject: first["operation"]!, options: [.sortedKeys])
          == JSONSerialization.data(withJSONObject: second["operation"]!, options: [.sortedKeys]))
      try require(driver.tokens == requests.count)
      connection.close()
      checks += 1
    }
    print(
      "Native Core recording binding: \(checks) offline checks passed; synthetic only, no device or live services."
    )
  }
}
