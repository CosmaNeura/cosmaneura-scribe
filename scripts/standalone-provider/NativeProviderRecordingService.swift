import CoreFoundation
import CosmaneuraNativeRecording
import Foundation

/// Uses the same native token owner and fixed Core transport as the provider
/// app. Construction requires a context minted by a verified Core response.
@MainActor
final class NativeProviderRecordingService: NativeRecordingBindingService,
  NativeRecordingLeaseService, NativeRecordingReservationService, NativeRecordingWindowService,
  NativeRecordingResumeWindowService
{
  private let connection: NativeProviderConnection
  private let context: NativeProviderRecordingContext
  private var preparedPublicKey: NativeProviderRecordingPublicKey?
  private var bindingRef: String { context.bindingRef }

  init(connection: NativeProviderConnection, context: NativeProviderRecordingContext) {
    self.connection = connection
    self.context = context
    self.preparedPublicKey = context.preparedPublicKey
  }

  func recordingScope() async throws -> NativeRecordingScope {
    // Construction already required a verified Core context. Every operation
    // below authenticates again and checks its Core envelope. Journal ownership
    // checks need the current native account, not another round trip to rediscover
    // immutable IDs. Cached keys/leases still cannot start a source.
    _ = try connection.recordingRevision(accountDigest: context.accountDigest)
    return try NativeRecordingScope(
      tenantID: context.tenantID, sessionID: context.sessionID,
      workspaceID: context.workspaceID, accountDigest: context.accountDigest)
  }

  func publishedKey() async throws -> NativeRecordingPublicKey {
    if let prepared = preparedPublicKey {
      preparedPublicKey = nil
      // Single-use native metadata only. Expiry or a new SDK revision requires
      // the original fresh key read; no source permission is cached here.
      if try connection.recordingPreparationKeyIsCurrent(context) {
        return try NativeRecordingPublicKey(
          version: prepared.version, modulusBase64URL: prepared.modulusBase64URL)
      }
    }
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

  func requestLease(previous: NativeRecordingLease?, intent: UUID) async throws
    -> NativeRecordingLease
  {
    var payload: [String: Any] = ["protocol_version": "1.0"]
    if let previous {
      guard previous.sessionID == context.sessionID,
        (1..<9_007_199_254_740_990).contains(previous.generation)
      else { throw ProviderNativeError.invalidRequest }
      payload["expected_generation"] = previous.generation
    }
    let value = try await operation(
      kind: previous == nil ? "issue_lease" : "renew_lease",
      intent: intent, payload: payload, leaseID: previous?.leaseID)
    return try parseLease(value, previous: previous)
  }

  private func parseLease(_ value: [String: Any], previous: NativeRecordingLease?) throws
    -> NativeRecordingLease
  {
    guard
      Set(value.keys) == [
        "protocol_version", "receipt_id", "lease_id", "session_id",
        "generation", "issued_at", "expires_at",
      ],
      value["protocol_version"] as? String == "1.0",
      value["session_id"] as? String == context.sessionID.uuidString.lowercased(),
      let receiptID = Self.uuid(value["receipt_id"]), let leaseID = Self.uuid(value["lease_id"]),
      let generation = value["generation"] as? NSNumber,
      CFGetTypeID(generation) != CFBooleanGetTypeID(),
      generation.doubleValue == Double((previous?.generation ?? 0) + 1),
      previous == nil || previous?.leaseID == leaseID,
      let issued = value["issued_at"] as? String, let expires = value["expires_at"] as? String
    else { throw NativeRecordingBindingFailure.receiptMismatch }
    return try NativeRecordingLease(
      receiptID: receiptID, leaseID: leaseID,
      sessionID: context.sessionID, generation: generation.intValue, issuedAt: issued,
      expiresAt: expires)
  }

  func reserve(lease: NativeRecordingLease, first: Int, count: Int, intent: UUID) async throws
    -> NativeRecordingReservationBatch
  {
    guard lease.sessionID == context.sessionID,
      (1..<9_007_199_254_740_991).contains(lease.generation),
      (0..<2048).contains(first), (1...90).contains(count), first <= 2048 - count
    else { throw ProviderNativeError.invalidRequest }
    let receipt = try await operation(
      kind: "reserve_chunks", intent: intent,
      payload: [
        "protocol_version": "1.0", "capture_lease_id": lease.leaseID.uuidString.lowercased(),
        "capture_lease_generation": lease.generation, "channel": "microphone",
        "first_sequence_number": first, "count": count,
      ], maximumResponseBytes: 131_072)
    return try parseReservations(receipt, lease: lease, first: first, count: count)
  }

  private func parseReservations(
    _ receipt: [String: Any], lease: NativeRecordingLease, first: Int, count: Int
  ) throws -> NativeRecordingReservationBatch {
    guard
      Set(receipt.keys) == [
        "protocol_version", "batch_id", "session_id", "capture_authorized_until", "reservations",
      ],
      receipt["protocol_version"] as? String == "1.0", let batchID = Self.uuid(receipt["batch_id"]),
      receipt["session_id"] as? String == context.sessionID.uuidString.lowercased(),
      receipt["capture_authorized_until"] as? String == lease.expiresAt,
      let rows = receipt["reservations"] as? [[String: Any]], rows.count == count
    else { throw NativeRecordingBindingFailure.receiptMismatch }
    let scope = try NativeRecordingScope(
      tenantID: context.tenantID, sessionID: context.sessionID,
      workspaceID: context.workspaceID, accountDigest: context.accountDigest)
    var reservations: [NativeRecordingReservation] = []
    for (offset, row) in rows.enumerated() {
      guard
        Set(row.keys) == [
          "protocol_version", "object_id", "session_id", "channel", "sequence_number",
          "additional_authenticated_data", "created_at",
        ],
        row["protocol_version"] as? String == "1.0", let objectID = Self.uuid(row["object_id"]),
        row["session_id"] as? String == context.sessionID.uuidString.lowercased(),
        row["channel"] as? String == "microphone",
        let sequence = row["sequence_number"] as? NSNumber,
        CFGetTypeID(sequence) != CFBooleanGetTypeID(),
        sequence.doubleValue == Double(first + offset),
        let aad = row["additional_authenticated_data"] as? String,
        let created = row["created_at"] as? String
      else { throw NativeRecordingBindingFailure.receiptMismatch }
      reservations.append(
        try NativeRecordingReservation(
          scope: scope, objectID: objectID,
          sequence: first + offset, additionalData: aad, createdAt: created))
    }
    guard Set(reservations.map(\.objectID)).count == count else {
      throw NativeRecordingBindingFailure.receiptMismatch
    }
    return NativeRecordingReservationBatch(
      batchID: batchID, sessionID: context.sessionID,
      authorizedUntil: lease.expiresAt, reservations: reservations)
  }

  func prepareInitialWindow(_ request: NativeRecordingWindowRequest) async throws
    -> NativeRecordingWindowReceipt
  {
    guard request.count == 30, Self.validVersion(request.keyVersion),
      request.wrappedDEK.range(of: "^[A-Za-z0-9_-]{512}$", options: .regularExpression) != nil
    else { throw ProviderNativeError.invalidRequest }
    let value = try await operation(
      kind: "prepare_recording_window", intent: request.bindIntent,
      payload: [
        "schema_version": "1.0",
        "binding": ["key_version": request.keyVersion, "wrapped_dek": request.wrappedDEK],
        "bind_idempotency_key": request.bindIntent.uuidString.lowercased(),
        "lease_idempotency_key": request.leaseIntent.uuidString.lowercased(),
        "reserve_idempotency_key": request.reserveIntent.uuidString.lowercased(),
        "channel": "microphone", "reservation_count": request.count,
      ], maximumResponseBytes: 131_072)
    guard Set(value.keys) == ["schema_version", "binding", "lease", "reservations"],
      value["schema_version"] as? String == "1.0",
      let binding = value["binding"] as? [String: Any],
      Set(binding.keys) == ["session_id", "key_version", "created_at"],
      binding["session_id"] as? String == context.sessionID.uuidString.lowercased(),
      binding["key_version"] as? String == request.keyVersion,
      let created = binding["created_at"] as? String, Self.date(created) != nil,
      let rawLease = value["lease"] as? [String: Any],
      let rawReservations = value["reservations"] as? [String: Any]
    else { throw NativeRecordingBindingFailure.receiptMismatch }
    let lease = try parseLease(rawLease, previous: nil)
    let batch = try parseReservations(rawReservations, lease: lease, first: 0, count: request.count)
    return NativeRecordingWindowReceipt(
      sessionID: context.sessionID,
      keyVersion: request.keyVersion, lease: lease, batch: batch)
  }

  func prepareResumeWindow(_ request: NativeRecordingResumeWindowRequest) async throws
    -> NativeRecordingResumeWindowReceipt
  {
    guard request.previous.sessionID == context.sessionID, (0..<2048).contains(request.first),
      (1..<9_007_199_254_740_990).contains(request.previous.generation)
    else { throw ProviderNativeError.invalidRequest }
    let value = try await operation(
      kind: "prepare_continuation_window", intent: request.intent,
      payload: [
        "schema_version": "1.0", "channel": "microphone",
        "first_sequence_number": request.first,
        "previous_lease_id": request.previous.leaseID.uuidString.lowercased(),
        "previous_lease_generation": request.previous.generation,
        "renew_idempotency_key": request.renewIntent.uuidString.lowercased(),
        "reservation_idempotency_key": request.reserveIntent.uuidString.lowercased(),
      ],
      maximumResponseBytes: 131_072)
    guard Set(value.keys) == ["schema_version", "lease", "reservations"],
      value["schema_version"] as? String == "1.0",
      let rawLease = value["lease"] as? [String: Any],
      let rawReservations = value["reservations"] as? [String: Any],
      let rows = rawReservations["reservations"] as? [[String: Any]],
      (1...90).contains(rows.count), rows.count <= 2048 - request.first
    else { throw NativeRecordingBindingFailure.receiptMismatch }
    let lease = try parseLease(rawLease, previous: request.previous)
    let batch = try parseReservations(
      rawReservations, lease: lease, first: request.first, count: rows.count)
    return NativeRecordingResumeWindowReceipt(lease: lease, batch: batch)
  }

  private static func uuid(_ value: Any?) -> UUID? {
    guard let value = value as? String, let parsed = UUID(uuidString: value),
      parsed.uuidString.lowercased() == value
    else { return nil }
    return parsed
  }

  private func operation(
    kind: String, intent: UUID, payload: [String: Any]? = nil,
    leaseID: UUID? = nil, maximumResponseBytes: Int = 8192
  )
    async throws -> [String: Any]
  {
    let revision = try connection.recordingRevision(accountDigest: context.accountDigest)
    let nonce = UUID().uuidString.lowercased()
    var operation: [String: Any] = ["kind": kind]
    if let payload { operation["payload"] = payload }
    if let leaseID { operation["lease_id"] = leaseID.uuidString.lowercased() }
    let body = try JSONSerialization.data(withJSONObject: [
      "workspace_id": context.workspaceID.uuidString.lowercased(), "binding_ref": bindingRef,
      "request_nonce": nonce, "operation": operation,
    ])
    // Core requires the aggregate request key to differ from every component.
    // Derive it from the retained bind intent so existing pending journals can
    // reopen with the same recipe, without replacing keys or component intents.
    let operationKey =
      kind == "prepare_recording_window"
      ? "native-initial-window-v1:\(intent.uuidString.lowercased())"
      : intent.uuidString.lowercased()
    let request = try ProviderNativeRequest(
      id: UUID().uuidString.lowercased(), revision: revision,
      action: "capture-operations", key: operationKey,
      body: String(decoding: body, as: UTF8.self))
    let reply: ProviderNativeReply
    do { reply = try await connection.send(request) } catch ProviderNativeError.response {
      throw NativeRecordingBindingFailure.receiptMismatch
    }
    do {
      try NativeProviderConnection.requireRecordingResponse(reply.status)
    } catch ProviderNativeError.authorityChanged {
      throw NativeRecordingBindingFailure.authorityChanged
    }
    guard try connection.recordingRevision(accountDigest: context.accountDigest) == revision,
      reply.status == 200, reply.body.count <= maximumResponseBytes,
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
      throw NativeRecordingBindingFailure.receiptMismatch
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
