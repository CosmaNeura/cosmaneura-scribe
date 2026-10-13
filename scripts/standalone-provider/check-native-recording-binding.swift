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
  let reservationDeadline = ISO8601DateFormatter().string(from: Date().addingTimeInterval(900))
  var replyBytes = 0
  var fault = "none"
  var admissionSupported = false
  var preparationDelay = false
  var requests: [ProviderNativeRequest] = []
  init(_ modulus: String) { self.modulus = modulus }
  func setFault(_ value: String) { fault = value }
  func supportAdmission(_ value: Bool, delay: Bool = false) {
    admissionSupported = value
    preparationDelay = delay
  }
  func send(_ request: ProviderNativeRequest, token: String) async throws -> ProviderNativeReply {
    try require(token.split(separator: ".").count == 3)
    requests.append(request)
    let body = try JSONSerialization.jsonObject(with: request.body) as! [String: Any]
    if request.action == .mount {
      let appointment = "appointment_01j00000000000000000000000"
      return ProviderNativeReply(
        status: 200,
        body: try JSONSerialization.data(withJSONObject: [
          "revision": request.revision, "workspaceId": workspace.uuidString.lowercased(),
          "recoveryScope": UUID().uuidString.lowercased(), "bindingRef": binding,
          "appointmentRef": appointment,
          "encounter": [
            "appointmentRef": appointment,
            "native_recording_preparation_v1": true,
            "admission_native_preparation_v1": admissionSupported,
          ],
        ]))
    }
    if request.action == .admission {
      let combined = body["native_recording_preparation"] as? Bool == true
      try require(
        Set(body.keys)
          == Set(
            ["workspace_id", "binding_ref", "request_nonce", "attestation", "configured_capture"]
              + (combined ? ["native_recording_preparation"] : [])))
      if preparationDelay { try await Task.sleep(for: .milliseconds(300)) }
      var answer: [String: Any] = [
        "contract_version": "1", "workspace_id": workspace.uuidString.lowercased(),
        "binding_ref": binding, "request_nonce": body["request_nonce"]!,
        "checked_at": ISO8601DateFormatter().string(from: Date()),
        "appointment_ref": "appointment_01j00000000000000000000000",
        "operation_ref": "scribe_admission_01j00000000000000000000000",
        "consent_record_id": UUID().uuidString.lowercased(),
        "session_id": session.uuidString.lowercased(), "status": "admitted",
        "configured_capture": body["configured_capture"]!,
      ]
      if combined {
        var context: [String: Any] = [
          "schema_version": "1.0", "workspace_id": workspace.uuidString.lowercased(),
          "tenant_id": tenant.uuidString.lowercased(),
          "session_id": session.uuidString.lowercased(), "status": "created",
        ]
        if fault == "admission_session" { context["session_id"] = UUID().uuidString.lowercased() }
        var metadata: [String: Any] = [
          "schema_version": "1.0", "context": context,
          "encryption_key": [
            "key_version": "synthetic-v1", "algorithm": "RSA-OAEP-256",
            "public_jwk": [
              "kty": "RSA", "n": modulus, "e": "AQAB", "alg": "RSA-OAEP-256", "ext": true,
              "key_ops": ["wrapKey"],
            ],
          ],
        ]
        if fault == "admission_extra" { metadata["permission"] = true }
        if fault != "admission_absent" { answer["native_recording_preparation"] = metadata }
        if fault == "admission_lost" { throw ProviderNativeError.response }
      }
      return ProviderNativeReply(
        status: 200, body: try JSONSerialization.data(withJSONObject: answer))
    }
    try require(Set(body.keys) == ["workspace_id", "binding_ref", "request_nonce", "operation"])
    try require(body["binding_ref"] as? String == binding)
    try require(body["workspace_id"] as? String == workspace.uuidString.lowercased())
    let operation = body["operation"] as! [String: Any]
    let kind = operation["kind"] as! String
    var receipt: [String: Any]
    if kind == "native_recording_context" || kind == "native_recording_preparation" {
      if preparationDelay { try await Task.sleep(for: .milliseconds(300)) }
      receipt = [
        "schema_version": "1.0", "workspace_id": workspace.uuidString.lowercased(),
        "tenant_id": tenant.uuidString.lowercased(), "session_id": session.uuidString.lowercased(),
        "status": "created",
      ]
      if kind == "native_recording_preparation" {
        receipt = [
          "schema_version": "1.0", "context": receipt,
          "encryption_key": [
            "key_version": "synthetic-v1", "algorithm": "RSA-OAEP-256",
            "public_jwk": [
              "kty": "RSA", "n": modulus, "e": "AQAB", "alg": "RSA-OAEP-256",
              "ext": true, "key_ops": ["wrapKey"],
            ],
          ],
        ]
      }
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
    } else if kind == "prepare_recording_window" || kind == "prepare_continuation_window" {
      let resumed = kind == "prepare_continuation_window"
      try require(Set(operation.keys) == ["kind", "payload"])
      let payload = operation["payload"] as! [String: Any]
      let fields: Set<String> =
        resumed
        ? [
          "schema_version", "channel", "first_sequence_number", "previous_lease_id",
          "previous_lease_generation", "renew_idempotency_key", "reservation_idempotency_key",
        ]
        : [
          "schema_version", "binding", "bind_idempotency_key", "lease_idempotency_key",
          "reserve_idempotency_key", "channel", "reservation_count",
        ]
      try require(
        Set(payload.keys) == fields && payload["schema_version"] as? String == "1.0"
          && payload["channel"] as? String == "microphone")
      let first = resumed ? payload["first_sequence_number"] as! Int : 0
      let count = resumed ? 17 : payload["reservation_count"] as! Int
      if !resumed, fault == "none",
        let path = ProcessInfo.processInfo.environment["SCRIBE_NATIVE_WINDOW_FIXTURE_PATH"],
        !FileManager.default.fileExists(atPath: path)
      {
        // Synthetic wire fixture for the actual Core boundary; no token or context.
        try JSONSerialization.data(
          withJSONObject: ["idempotency_key": request.key, "operation": operation],
          options: [.sortedKeys]
        ).write(to: URL(fileURLWithPath: path), options: .atomic)
      }
      let componentFields =
        resumed
        ? ["renew_idempotency_key", "reservation_idempotency_key"]
        : ["bind_idempotency_key", "lease_idempotency_key", "reserve_idempotency_key"]
      let componentKeys = try componentFields.map { field -> String in
        guard let key = payload[field] as? String, UUID(uuidString: key) != nil else {
          throw CheckFailure.failed
        }
        return key
      }
      // Match Core's actual contract: the outer request may not alias a component.
      try require(Set(componentKeys + [request.key]).count == componentKeys.count + 1)
      if resumed {
        try require(
          payload["previous_lease_id"] as? String == lease.uuidString.lowercased()
            && payload["previous_lease_generation"] as? Int == 1)
      } else {
        try require(count == 30)
        let binding = payload["binding"] as! [String: String]
        try require(
          Set(binding.keys) == ["key_version", "wrapped_dek"]
            && binding["wrapped_dek"]?.count == 512)
      }
      let formatter = ISO8601DateFormatter()
      let issued = Date()
      let issuedAt = formatter.string(from: issued)
      let expiresAt = formatter.string(from: issued.addingTimeInterval(900))
      let leaseReceipt: [String: Any] = [
        "protocol_version": "1.0", "receipt_id": UUID().uuidString.lowercased(),
        "lease_id": fault == "aggregate_lease"
          ? UUID().uuidString.lowercased() : lease.uuidString.lowercased(),
        "session_id": session.uuidString.lowercased(),
        "generation": fault == "aggregate_generation" ? 3 : resumed ? 2 : 1,
        "issued_at": issuedAt, "expires_at": expiresAt,
      ]
      var rows: [[String: Any]] = []
      for sequence in first..<(first + count) {
        let object = UUID()
        let aad = try JSONSerialization.data(
          withJSONObject: [
            "tenant_id": tenant.uuidString.lowercased(),
            "session_id": session.uuidString.lowercased(),
            "object_id": object.uuidString.lowercased(),
            "channel": "microphone", "sequence_number": sequence,
          ], options: [.sortedKeys, .withoutEscapingSlashes]
        )
        .base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(
          of: "/", with: "_"
        ).replacingOccurrences(of: "=", with: "")
        rows.append([
          "protocol_version": "1.0", "object_id": object.uuidString.lowercased(),
          "session_id": session.uuidString.lowercased(), "channel": "microphone",
          "sequence_number": fault == "aggregate_position" ? sequence + 1 : sequence,
          "additional_authenticated_data": aad, "created_at": issuedAt,
        ])
      }
      let reservations: [String: Any] = [
        "protocol_version": "1.0", "batch_id": UUID().uuidString.lowercased(),
        "session_id": session.uuidString.lowercased(), "capture_authorized_until": expiresAt,
        "reservations": fault == "aggregate_count" ? [] : rows,
      ]
      receipt = [
        "schema_version": fault == "aggregate_schema" ? "2.0" : "1.0", "lease": leaseReceipt,
        "reservations": reservations,
      ]
      if !resumed {
        receipt["binding"] = [
          "session_id": fault == "aggregate_binding"
            ? UUID().uuidString.lowercased() : session.uuidString.lowercased(),
          "key_version": fault == "aggregate_key" ? "wrong-key" : "synthetic-v1",
          "created_at": issuedAt,
        ]
      }
      if fault == "aggregate_fields" { receipt["unexpected"] = true }
      if fault == "lost_window" { throw ProviderNativeError.response }
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
    } else if kind == "reserve_chunks" {
      try require(Set(operation.keys) == ["kind", "payload"])
      let payload = operation["payload"] as! [String: Any]
      try require(
        Set(payload.keys) == [
          "protocol_version", "capture_lease_id", "capture_lease_generation", "channel",
          "first_sequence_number", "count",
        ])
      try require(payload["protocol_version"] as? String == "1.0")
      try require(payload["capture_lease_id"] as? String == lease.uuidString.lowercased())
      try require(payload["capture_lease_generation"] as? Int == 1)
      try require(payload["channel"] as? String == "microphone")
      let first = payload["first_sequence_number"] as! Int
      let count = payload["count"] as! Int
      try require(first >= 0 && count > 0 && count <= 90 && first <= 2048 - count)
      try require(UUID(uuidString: request.key) != nil)
      let duplicateID = UUID()
      var rows: [[String: Any]] = []
      for sequence in first..<(first + count) {
        let objectID = fault == "duplicate_object" ? duplicateID : UUID()
        let aad = try JSONSerialization.data(
          withJSONObject: [
            "tenant_id": tenant.uuidString.lowercased(),
            "session_id": session.uuidString.lowercased(),
            "object_id": objectID.uuidString.lowercased(), "channel": "microphone",
            "sequence_number": sequence,
          ], options: [.sortedKeys, .withoutEscapingSlashes]
        ).base64EncodedString()
          .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
          .replacingOccurrences(of: "=", with: "")
        var row: [String: Any] = [
          "protocol_version": "1.0", "object_id": objectID.uuidString.lowercased(),
          "session_id": session.uuidString.lowercased(), "channel": "microphone",
          "sequence_number": sequence, "additional_authenticated_data": aad,
          "created_at": "2026-09-26T00:00:00Z",
        ]
        switch fault {
        case "row_protocol": row["protocol_version"] = "2.0"
        case "row_session": row["session_id"] = UUID().uuidString.lowercased()
        case "channel": row["channel"] = "system"
        case "sequence": row["sequence_number"] = sequence + 1
        case "boolean_sequence": row["sequence_number"] = true
        case "fractional_sequence": row["sequence_number"] = Double(sequence) + 0.5
        case "object": row["object_id"] = "invalid"
        case "aad": row["additional_authenticated_data"] = "e30"
        case "created_at": row["created_at"] = "invalid"
        case "extra_row": row["unexpected"] = true
        case "oversized": row["created_at"] = String(repeating: "x", count: 131_072)
        default: break
        }
        rows.append(row)
      }
      receipt = [
        "protocol_version": fault == "protocol" ? "2.0" : "1.0",
        "batch_id": fault == "batch" ? "invalid" : UUID().uuidString.lowercased(),
        "session_id": fault == "session"
          ? UUID().uuidString.lowercased() : session.uuidString.lowercased(),
        "capture_authorized_until": fault == "deadline"
          ? "2026-09-26T00:00:00Z" : reservationDeadline,
        "reservations": fault == "count" ? Array(rows.dropLast()) : rows,
      ]
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
    let encoded = try JSONSerialization.data(withJSONObject: envelope)
    replyBytes = encoded.count
    return ProviderNativeReply(
      status: [
        "denied": 403, "unauthorized": 401, "conflict": 409, "invalid": 422,
        "unavailable": 503,
      ][fault] ?? 200,
      body: encoded)
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

private final class BindingRecords: NativeRecordingBindingRecordStore, NativeRecordingRecordStore,
  NativeRecordingLeaseRecordStore,
  @unchecked Sendable
{
  private let lock = NSLock()
  private var values: [String: NativeRecordingStoredRecord] = [:]
  func readBinding(key: String) throws -> NativeRecordingStoredRecord? {
    lock.withLock { values[key] }
  }
  func createBinding(key: String, data: Data) throws { try write(key, data, 0) }
  func readLease(key: String) throws -> NativeRecordingStoredRecord? { try readBinding(key: key) }
  func createLease(key: String, data: Data) throws { try write(key, data, 0) }
  func compareAndSwapLease(key: String, expectedRevision: UInt64, data: Data) throws {
    try write(key, data, expectedRevision)
  }
  func compareAndSwapBinding(key: String, expectedRevision: UInt64, data: Data) throws {
    try write(key, data, expectedRevision)
  }
  func read(key: String) throws -> NativeRecordingStoredRecord {
    guard let value = try readBinding(key: key) else {
      throw NativeRecordingFailure.storageUnavailable
    }
    return value
  }
  func compareAndSwap(key: String, expectedRevision: UInt64, data: Data) throws {
    try write(key, data, expectedRevision)
  }
  func availableBytes() -> Int { 1_000_000_000 }
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
  @MainActor private static func make(
    _ modulus: String, combined: Bool = false, ticket: Bool = false,
    contextNow: @escaping @MainActor () -> ContinuousClock.Instant = { .now }
  ) async throws
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
    let connection = NativeProviderConnection(auth: auth, wire: wire, contextNow: contextNow)
    auth.onChange = { [weak connection] state in connection?.authChanged(state) }
    if combined {
      _ = try await connection.send(
        CheckNativeProvider.request(
          auth, action: "mount",
          body:
            String(
              decoding: JSONSerialization.data(withJSONObject: [
                "workspace_id": wire.workspace.uuidString.lowercased()
              ]), as: UTF8.self)))
    }
    let context: NativeProviderRecordingContext
    if ticket {
      let nonce = UUID()
      let revision = auth.state().revision
      _ = try await connection.prepareRecordingContext(
        CheckNativeProvider.request(
          auth,
          action: "recorder-context",
          body: String(
            decoding: JSONSerialization.data(withJSONObject: [
              "workspace_id": wire.workspace.uuidString.lowercased(), "binding_ref": wire.binding,
              "session_id": wire.session.uuidString.lowercased(),
              "request_nonce": nonce.uuidString.lowercased(),
            ]), as: UTF8.self)))
      guard
        let prepared = try connection.takePreparedRecordingContext(
          nonce: nonce,
          workspaceID: wire.workspace, bindingRef: wire.binding, sessionID: wire.session,
          revision: revision)
      else { throw CheckFailure.failed }
      context = prepared
    } else {
      context = try await connection.recordingContext(
        workspaceID: wire.workspace, bindingRef: wire.binding,
        sessionID: wire.session, revision: auth.state().revision)
    }
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
    for round in 1...3 {
      var measurements: [Int] = []
      for supported in [false, true] {
        let driver = Driver()
        let wire = BindingWire(modulus)
        await wire.supportAdmission(supported, delay: true)
        let auth = NativeWorkspaceAuth(
          enabled: true, organizationID: "org_offline",
          tokenPolicy: try NativeTokenPolicy(
            issuer: "https://identity.clerk.accounts.dev", audience: "offline-provider"),
          driver: { driver }, accessBlock: { Block() })
        let connection = NativeProviderConnection(
          auth: auth, wire: wire, nativeAdmissionPreparationEnabled: true)
        _ = try await connection.send(
          CheckNativeProvider.request(
            auth, action: "mount",
            body: String(
              decoding:
                try JSONSerialization.data(withJSONObject: [
                  "workspace_id": wire.workspace.uuidString.lowercased()
                ]), as: UTF8.self)))
        let started = ContinuousClock.now
        let before = await wire.requests.count
        let tokens = driver.tokens
        _ = try await connection.send(
          CheckNativeProvider.request(
            auth, action: "capture-admissions",
            body: String(
              decoding:
                try JSONSerialization.data(withJSONObject: [
                  "workspace_id": wire.workspace.uuidString.lowercased(),
                  "binding_ref": wire.binding,
                  "request_nonce": UUID().uuidString.lowercased(),
                  "attestation": ["all_parties_consented": true],
                  "configured_capture": ["schema_version": "1.0", "language_mode": "en-US"],
                ]), as: UTF8.self)))
        _ = try await connection.prepareRecordingContext(
          CheckNativeProvider.request(
            auth, action: "recorder-context",
            body: String(
              decoding:
                try JSONSerialization.data(withJSONObject: [
                  "workspace_id": wire.workspace.uuidString.lowercased(),
                  "binding_ref": wire.binding,
                  "session_id": wire.session.uuidString.lowercased(),
                  "request_nonce": UUID().uuidString.lowercased(),
                ]), as: UTF8.self)))
        let elapsed = ProviderNativeRequestTiming.milliseconds(from: started, to: .now)
        try require(await wire.requests.count == before + (supported ? 1 : 2))
        try require(driver.tokens == tokens + (supported ? 1 : 2))
        measurements.append(elapsed)
        connection.close()
        checks += 1
      }
      try require(measurements[0] - measurements[1] >= 250)
      print(
        "Synthetic admission timing round=\(round) original_ms=\(measurements[0]) combined_ms=\(measurements[1]) injected_request_wait_ms=300; no device timing claim."
      )
    }
    for supported in [false, true] {
      for fault in [
        "none", "expired", "transfer_expiry", "cancelled", "early_cancel", "task_cancel",
        "revision", "remount",
        "admission_session", "admission_extra", "admission_absent", "admission_lost",
      ] {
        var instant = ContinuousClock.now
        let driver = Driver()
        let wire = BindingWire(modulus)
        await wire.supportAdmission(supported)
        let auth = NativeWorkspaceAuth(
          enabled: true, organizationID: "org_offline",
          tokenPolicy: try NativeTokenPolicy(
            issuer: "https://identity.clerk.accounts.dev", audience: "offline-provider"),
          driver: { driver }, accessBlock: { Block() })
        let connection = NativeProviderConnection(
          auth: auth, wire: wire, nativeAdmissionPreparationEnabled: true, contextNow: { instant })
        auth.onChange = { [weak connection] state in connection?.authChanged(state) }
        let mountRequest = try CheckNativeProvider.request(
          auth, action: "mount",
          body: String(
            decoding:
              try JSONSerialization.data(withJSONObject: [
                "workspace_id": wire.workspace.uuidString.lowercased()
              ]), as: UTF8.self))
        _ = try await connection.send(mountRequest)
        let admission = try CheckNativeProvider.request(
          auth, action: "capture-admissions",
          body: String(
            decoding:
              try JSONSerialization.data(withJSONObject: [
                "workspace_id": wire.workspace.uuidString.lowercased(),
                "binding_ref": wire.binding, "request_nonce": UUID().uuidString.lowercased(),
                "attestation": ["all_parties_consented": true],
                "configured_capture": ["schema_version": "1.0", "language_mode": "en-US"],
              ]), as: UTF8.self))
        await wire.setFault(fault)
        if supported && fault.hasPrefix("admission_") {
          try await CheckNativeProvider.rejected(Task { try await connection.send(admission) })
          try require(await wire.requests.count == 2)
        } else {
          let answer = try await connection.send(admission)
          let published = try JSONSerialization.jsonObject(with: answer.body) as! [String: Any]
          try require(published["native_recording_preparation"] == nil)
          if fault == "expired" { instant = instant.advanced(by: .seconds(6)) }
          if fault == "transfer_expiry" { instant = instant.advanced(by: .seconds(4)) }
          if fault == "cancelled" { connection.cancel(admission.id) }
          if fault == "revision" {
            driver.identity = try .init(
              userID: "user_offline", sessionID: "sess_new", organizationID: "org_offline")
            _ = auth.state()
          }
          if fault == "remount" {
            _ = try await connection.send(
              CheckNativeProvider.request(
                auth, action: "mount", body: String(decoding: mountRequest.body, as: UTF8.self)))
          }
          let before = await wire.requests.count
          let tokens = driver.tokens
          let nonce = UUID()
          let preparation = try CheckNativeProvider.request(
            auth, action: "recorder-context",
            body: String(
              decoding:
                try JSONSerialization.data(withJSONObject: [
                  "workspace_id": wire.workspace.uuidString.lowercased(),
                  "binding_ref": wire.binding,
                  "session_id": wire.session.uuidString.lowercased(),
                  "request_nonce": nonce.uuidString.lowercased(),
                ]), as: UTF8.self))
          if fault == "early_cancel" {
            connection.cancel(preparation.id)
            try await CheckNativeProvider.rejected(
              Task { try await connection.prepareRecordingContext(preparation) })
            try require(await wire.requests.count == before && driver.tokens == tokens)
          } else if fault == "task_cancel" {
            let cancelled = Task { try await connection.prepareRecordingContext(preparation) }
            cancelled.cancel()
            try await CheckNativeProvider.rejected(cancelled)
            try require(await wire.requests.count == before && driver.tokens == tokens)
          } else if fault == "revision" {
            try await CheckNativeProvider.rejected(
              Task { try await connection.prepareRecordingContext(preparation) })
          } else {
            _ = try await connection.prepareRecordingContext(preparation)
            let reused = supported && ["none", "transfer_expiry"].contains(fault)
            try require(await wire.requests.count == before + (reused ? 0 : 1))
            try require(driver.tokens == tokens + (reused ? 0 : 1))
            if fault == "transfer_expiry" { instant = instant.advanced(by: .seconds(2)) }
            let context = try connection.takePreparedRecordingContext(
              nonce: nonce, workspaceID: wire.workspace, bindingRef: wire.binding,
              sessionID: wire.session, revision: auth.state().revision)
            try require((context == nil) == (supported && fault == "transfer_expiry"))
            try require(context == nil || context?.tenantID == wire.tenant)
            try await CheckNativeProvider.rejected(
              Task {
                try connection.takePreparedRecordingContext(
                  nonce: nonce, workspaceID: wire.workspace,
                  bindingRef: wire.binding, sessionID: wire.session, revision: auth.state().revision
                )
              })
          }
        }
        connection.close()
        checks += 1
      }
    }
    for ticket in [false, true] {
      for fault in ["none", "expired", "revision", "account", "cancelled", "remount"] {
        var instant = ContinuousClock.now
        let (auth, driver, wire, connection, service) = try await make(
          modulus, combined: true, ticket: ticket, contextNow: { instant })
        let before = await wire.requests.count
        if fault == "expired" { instant = instant.advanced(by: .seconds(6)) }
        if fault == "revision" {
          driver.identity = try .init(
            userID: "user_offline", sessionID: "sess_restarted", organizationID: "org_offline")
          _ = auth.state()
        }
        if fault == "account" {
          driver.identity = nil
          _ = auth.state()
        }
        if fault == "remount" {
          _ = try await connection.send(
            CheckNativeProvider.request(
              auth, action: "mount",
              body:
                String(
                  decoding: JSONSerialization.data(withJSONObject: [
                    "workspace_id": wire.workspace.uuidString.lowercased()
                  ]), as: UTF8.self)))
        }
        if fault == "cancelled" {
          let pending = Task { try await service.publishedKey() }
          pending.cancel()
          try await CheckNativeProvider.rejected(pending)
          try require(await wire.requests.count == before)
        } else if fault == "account" {
          try await CheckNativeProvider.rejected(Task { try await service.publishedKey() })
          try require(await wire.requests.count == before)
        } else {
          try require(try await service.publishedKey().version == "synthetic-v1")
          try require(
            await wire.requests.count == before + (fault == "none" ? 0 : fault == "remount" ? 2 : 1)
          )
          _ = try await service.publishedKey()
          try require(
            await wire.requests.count == before + (fault == "none" ? 1 : fault == "remount" ? 3 : 2)
          )
        }
        connection.close()
        checks += 1
      }
    }
    let envelopeFaults = [
      "none", "nonce", "binding", "workspace", "operation", "contract", "old", "future",
      "date", "extra", "large", "denied", "extra_receipt",
    ]
    do {
      let (auth, driver, wire, connection, service) = try await make(modulus)
      let before = await wire.requests.count
      let scope = try await service.recordingScope()
      for _ in 0..<10 { try require(try await service.recordingScope() == scope) }
      try require(await wire.requests.count == before && driver.tokens == before)
      _ = try await auth.signOut()
      try await CheckNativeProvider.rejected(Task { try await service.recordingScope() })
      try require(await wire.requests.count == before)
      connection.close()
      checks += 1
    }
    for fault in ["denied", "unauthorized", "conflict", "invalid", "unavailable"] {
      let (auth, _, wire, connection, service) = try await make(modulus)
      await wire.setFault(fault)
      do {
        _ = try await service.requestLease(previous: nil, intent: UUID())
        throw CheckFailure.failed
      } catch NativeRecordingBindingFailure.authorityChanged {
        try require(fault != "unavailable")
      } catch ProviderNativeError.unavailable {
        try require(fault == "unavailable")
      }
      do {
        _ = try await connection.recordingContext(
          workspaceID: wire.workspace, bindingRef: wire.binding,
          sessionID: wire.session, revision: auth.state().revision)
        throw CheckFailure.failed
      } catch ProviderNativeError.authorityChanged {
        try require(fault != "unavailable")
      } catch ProviderNativeError.unavailable {
        try require(fault == "unavailable")
      }
      connection.close()
      checks += 1
    }
    for fault in ["nonce", "binding", "generation", "extra_receipt"] {
      let (_, _, wire, connection, service) = try await make(modulus)
      await wire.setFault(fault)
      do {
        _ = try await service.requestLease(previous: nil, intent: UUID())
        throw CheckFailure.failed
      } catch NativeRecordingBindingFailure.receiptMismatch {}
      connection.close()
      checks += 1
    }
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
    for resumed in [false, true] {
      for fault in envelopeFaults + [
        "aggregate_count", "aggregate_position", "aggregate_generation", "aggregate_schema",
        "aggregate_fields",
      ] + (resumed ? ["aggregate_lease"] : ["aggregate_binding", "aggregate_key"]) {
        let (_, driver, wire, connection, service) = try await make(modulus)
        await wire.setFault(fault)
        let task = Task {
          if resumed {
            let formatter = ISO8601DateFormatter()
            let now = Date()
            let previous = try NativeRecordingLease(
              receiptID: UUID(), leaseID: wire.lease, sessionID: wire.session,
              generation: 1, issuedAt: formatter.string(from: now.addingTimeInterval(-600)),
              expiresAt: formatter.string(from: now.addingTimeInterval(300)))
            let value = try await service.prepareResumeWindow(
              NativeRecordingResumeWindowRequest(
                previous: previous, first: 7, intent: UUID(), renewIntent: UUID(),
                reserveIntent: UUID()))
            try require(
              value.lease.generation == 2 && value.batch.reservations.count == 17
                && value.batch.reservations.first?.sequence == 7)
          } else {
            let value = try await service.prepareInitialWindow(
              NativeRecordingWindowRequest(
                keyVersion: "synthetic-v1", wrappedDEK: receipt.wrappedDEK, bindIntent: UUID(),
                leaseIntent: UUID(), reserveIntent: UUID(), count: 30))
            try require(value.lease.generation == 1 && value.batch.reservations.count == 30)
          }
        }
        if fault == "none" {
          try await task.value
        } else {
          try await CheckNativeProvider.rejected(task)
        }
        try require(await wire.requests.count == 2 && driver.tokens == 2)
        connection.close()
        checks += 1
      }
    }
    for preparation in ["legacy", "combined", "ticket"] {
      let combined = preparation != "legacy"
      let (_, driver, wire, connection, service) = try await make(
        modulus, combined: combined, ticket: preparation == "ticket")
      let scope = try await service.recordingScope()
      let records = BindingRecords()
      let keys = BindingKeys()
      let recovery = UUID()
      let window = NativeRecordingWindowOwner(
        scope: scope, recoveryScope: recovery, service: service, records: records)
      try await window.initialize()
      let binding = NativeRecordingBindingOwner(
        scope: scope, service: window, records: records, keys: keys)
      await wire.setFault("lost_window")
      try await CheckNativeProvider.rejected(Task { try await binding.open() })
      // Reconstruct owners from the same version-one journals after a lost reply.
      // No new recipe or encryption key may replace the retained pending request.
      let reopenedWindow = NativeRecordingWindowOwner(
        scope: scope, recoveryScope: recovery, service: service, records: records)
      try await reopenedWindow.initialize()
      let reopenedBinding = NativeRecordingBindingOwner(
        scope: scope, service: reopenedWindow, records: records, keys: keys)
      await wire.setFault("none")
      _ = try await reopenedBinding.open()
      let requests = await wire.requests
      let decoded = try requests.filter { $0.action == .operation }.map {
        request -> (ProviderNativeRequest, [String: Any]) in
        let body = try JSONSerialization.jsonObject(with: request.body) as! [String: Any]
        return (request, body["operation"] as! [String: Any])
      }
      let windows = decoded.filter { $0.1["kind"] as? String == "prepare_recording_window" }
      try require(windows.count == 2 && windows[0].0.key == windows[1].0.key)
      try require(
        decoded.filter { $0.1["kind"] as? String == "encryption_key" }.count == (combined ? 0 : 1))
      try require(
        JSONSerialization.data(withJSONObject: windows[0].1, options: [.sortedKeys])
          == JSONSerialization.data(withJSONObject: windows[1].1, options: [.sortedKeys]))
      let payload = windows[0].1["payload"] as! [String: Any]
      try require(
        windows[0].0.key == "native-initial-window-v1:"
          + (payload["bind_idempotency_key"] as! String))
      try require(driver.tokens == requests.count)
      // The same actual binding/window/reservation writer encrypts fictional
      // PCM using the combined public key, including lost-response recovery.
      if combined {
        let cipher = try await reopenedBinding.open()
        let leases = NativeRecordingLeaseOwner(scope: scope, service: service, records: records)
        let reservations = NativeRecordingReservationOwner(
          scope: scope, recoveryScope: recovery,
          service: service, records: records)
        try await reopenedWindow.adopt(leases: leases, reservations: reservations)
        let lease = try await leases.open()
        let prepared = try await reservations.reserve(lease: lease, first: 0, count: 30)
        guard let row = prepared.reservations.first else { throw CheckFailure.failed }
        let writer = try NativeRecordingQueueWriter(
          encryption: cipher, recoveryScope: recovery,
          store: records, firstSequence: 0, priorPlaintextBytes: 0,
          maximumPlaintextBytes: 402_653_184)
        var pcm = Data([1, 0, 255, 127])
        _ = try writer.persist(pcm16: &pcm, objectID: row.objectID, sequence: row.sequence)
        try require(pcm.allSatisfy { $0 == 0 })
      }
      connection.close()
      checks += 1
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
    for fault in envelopeFaults + [
      "protocol", "batch", "session", "deadline", "count", "row_protocol", "row_session",
      "channel", "sequence", "boolean_sequence", "fractional_sequence", "object", "aad",
      "created_at", "extra_row", "duplicate_object", "oversized",
    ] {
      let (_, driver, wire, connection, service) = try await make(modulus)
      let lease = try NativeRecordingLease(
        receiptID: UUID(), leaseID: wire.lease, sessionID: wire.session, generation: 1,
        issuedAt: ISO8601DateFormatter().string(from: Date()), expiresAt: wire.reservationDeadline)
      await wire.setFault(fault)
      let operation = Task {
        try await service.reserve(lease: lease, first: 0, count: 90, intent: UUID())
      }
      if fault == "none" {
        let batch = try await operation.value
        let bytes = await wire.replyBytes
        try require(batch.reservations.count == 90 && bytes > 8192 && bytes <= 131_072)
      } else {
        try await CheckNativeProvider.rejected(operation)
      }
      let requests = await wire.requests
      try require(driver.tokens == 2 && requests.count == 2)
      connection.close()
      checks += 1
    }
    do {
      let (_, _, wire, connection, service) = try await make(modulus)
      let lease = try NativeRecordingLease(
        receiptID: UUID(), leaseID: wire.lease, sessionID: wire.session, generation: 1,
        issuedAt: ISO8601DateFormatter().string(from: Date()), expiresAt: wire.reservationDeadline)
      let before = await wire.requests.count
      for (first, count) in [(-1, 1), (2040, 90), (0, 0), (0, 91)] {
        try await CheckNativeProvider.rejected(
          Task {
            try await service.reserve(lease: lease, first: first, count: count, intent: UUID())
          })
      }
      try require(await wire.requests.count == before)
      connection.close()
      checks += 1
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
      let recovery = UUID()
      let lease = try NativeRecordingLease(
        receiptID: UUID(), leaseID: wire.lease, sessionID: wire.session, generation: 1,
        issuedAt: ISO8601DateFormatter().string(from: Date()), expiresAt: wire.reservationDeadline)
      let reservationOwner = NativeRecordingReservationOwner(
        scope: scope, recoveryScope: recovery, service: service, records: records)
      let batch = try await reservationOwner.reserve(lease: lease, first: 0, count: 3)
      let writer = try NativeRecordingQueueWriter(
        encryption: cipher, recoveryScope: recovery, store: records, firstSequence: 0,
        priorPlaintextBytes: 0, maximumPlaintextBytes: 402_653_184)
      for row in batch.reservations {
        var pcm = Data([1, 0, 255, 127])
        let result = try writer.persist(pcm16: &pcm, objectID: row.objectID, sequence: row.sequence)
        try require(pcm.allSatisfy { $0 == 0 } && result.sequence == row.sequence)
        let key =
          "scribe-provider-queue:v1:\(recovery.uuidString.lowercased()):\(scope.workspaceID.uuidString.lowercased()):\(scope.sessionID.uuidString.lowercased()):\(row.objectID.uuidString.lowercased())"
        let saved = try records.read(key: key)
        let value = try JSONSerialization.jsonObject(with: saved.data) as! [String: Any]
        try require(saved.revision == 2 && value["state"] as? String == "encrypted")
        if row.sequence == 2,
          let path = ProcessInfo.processInfo.environment["SCRIBE_NATIVE_RESERVED_FIXTURE_PATH"]
        {
          try saved.data.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
      }
      connection.close()
      checks += 1
    }
    print(
      "Native Core recording binding: \(checks) offline checks passed; synthetic only, no device or live services."
    )
  }
}
