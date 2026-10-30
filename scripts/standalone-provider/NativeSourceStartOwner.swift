import Foundation
import Security
import CosmasNativeAuth

/// Metadata comes from the authorized mount and saved flow. It does not grant capture.
struct NativeSourcePreparation: Equatable, Sendable {
    enum Source: String, Sendable { case desktop = "desktop_companion", ios = "ios_microphone" }
    let workspaceID: UUID
    let bindingRef: String
    let sessionID: UUID
    let leaseID: UUID
    let leaseReceiptID: UUID
    let leaseGeneration: Int
    let captureAuthorizedUntil: String
    let source: Source
    let firstSequenceNumber: Int

    init(workspaceID: UUID, bindingRef: String, sessionID: UUID, leaseID: UUID,
         leaseReceiptID: UUID, leaseGeneration: Int, captureAuthorizedUntil: String,
         source: Source, firstSequenceNumber: Int = 0) throws {
        guard bindingRef.range(of: "^scribe_capture_binding_[0-7][0-9a-hjkmnp-tv-z]{25}$",
                               options: .regularExpression) != nil,
              leaseGeneration > 0, (0..<2048).contains(firstSequenceNumber), let deadline = sourceDate(captureAuthorizedUntil),
              deadline > Date() else { throw ProviderNativeError.invalidRequest }
        self.workspaceID = workspaceID; self.bindingRef = bindingRef; self.sessionID = sessionID
        self.leaseID = leaseID; self.leaseReceiptID = leaseReceiptID
        self.leaseGeneration = leaseGeneration; self.captureAuthorizedUntil = captureAuthorizedUntil
        self.source = source
        self.firstSequenceNumber = firstSequenceNumber
    }
}

struct NativeSourceGrant: Sendable {
    let captureSessionID: String
    let actorID: String
    let consentRecordID: String
    let sourceLeaseID: String
    let source: NativeSourcePreparation.Source

    var desktopPayload: [String: Any] {
        ["captureSessionId": captureSessionID, "actorId": actorID,
         "consentRecordId": consentRecordID, "consentStatus": "granted",
         "sessionStatus": "authorized", "source": source.rawValue,
         "sourceLeaseId": sourceLeaseID]
    }
}

struct NativeSourceDecision: Sendable {
    let grant: NativeSourceGrant
    let capabilityID: String
    let secret: String
    let issuedAt: String
    let expiresAt: String
    let captureAuthorizedUntil: String

    // Main-process-only pipe output. Never use as a Capacitor return value.
    var desktopPayload: [String: Any] {
        var value = grant.desktopPayload
        value["schemaVersion"] = 1; value["decision"] = "authorized"
        value["issuedAt"] = issuedAt; value["expiresAt"] = expiresAt
        value["captureCapability"] = ["capabilityId": capabilityID, "secret": secret,
                                       "expiresAt": expiresAt]
        return value
    }
}

@MainActor private enum NativeSourceConsumption {
    static var consumed: Set<String> = []
}

/// Native-only owner. Persist original stop custody before dispatch. Restart
/// recovery is a separate stop-only path; it cannot replay start authority.
@MainActor final class NativeSourceStartOwner {
    private let connection: NativeProviderConnection
    private let revision: String
    private let preparation: NativeSourcePreparation
    private let now: @MainActor () -> Date
    private let stopRevision: (@MainActor () throws -> String)?
    private let attemptID = UUID().uuidString.lowercased()
    private let prepareKey = UUID().uuidString.lowercased()
    private let authorizeKey = UUID().uuidString.lowercased()
    private let cancelKey = UUID().uuidString.lowercased()
    private let stopKey = UUID().uuidString.lowercased()
    private let journal: NativeSourceProofJournal
    private let record: NativeSourceProofRecord
    private var proof: String
    private var grant: NativeSourceGrant?
    private(set) var preparationExpiresAt: String?
    private var busy = false
    private var closed = false
    private var issued = false
    private var retiring = false
    private var microphoneRunID: String?

    var recordingPreparation: NativeSourcePreparation { preparation }
#if os(macOS)
    private var desktopAuthorizationRequested = false
    private var desktopCombinedAttempted = false
    private var desktopLegacyFallback = false
    private var desktopPreparedDecision: NativeSourceDecision?
#endif

    init(connection: NativeProviderConnection, revision: String,
         preparation: NativeSourcePreparation, identity: NativeAuthIdentity,
         journal: NativeSourceProofJournal,
         now: @escaping @MainActor () -> Date = { Date() },
         stopRevision: (@MainActor () throws -> String)? = nil) throws {
        guard UUID(uuidString: revision)?.uuidString.lowercased() == revision else {
            throw ProviderNativeError.invalidRequest
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw ProviderNativeError.unavailable
        }
        proof = bytes.map { String(format: "%02x", $0) }.joined()
        _ = bytes.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) }
        self.connection = connection; self.revision = revision; self.preparation = preparation; self.now = now
        self.stopRevision = stopRevision; self.journal = journal
        record = NativeSourceProofRecord(attemptID: UUID(uuidString: attemptID)!,
            stopKey: UUID(uuidString: stopKey)!, proof: proof, identity: identity, preparation: preparation)
        // A failed write prevents construction/any prepare dispatch. Ambiguous
        // storage failure poisons the process journal until exclusive recovery.
        try journal.insertBeforeDispatch(record)
    }

    func prepare() async throws -> NativeSourceGrant {
        try enter(); defer { busy = false }
        let receipt = try await send(action: "prepare", key: prepareKey)
        let checked = try checkReceipt(receipt)
        guard receipt["state"] as? String == "prepared",
              let expires = receipt["preparation_expires_at"] as? String,
              let date = sourceDate(expires), date > now(), date.timeIntervalSince(now()) <= 120.001,
              let deadline = sourceDate(preparation.captureAuthorizedUntil), date <= deadline else {
            throw ProviderNativeError.response
        }
        grant = checked
        preparationExpiresAt = expires
        return checked
    }

    func authorize() async throws -> NativeSourceDecision {
        try enter(); defer { busy = false }
        guard let grant else { throw ProviderNativeError.unavailable }
#if os(macOS)
        // Once this method is entered, even a lost pipe reply may have exposed
        // authority. Preparation-only cleanup is no longer safe.
        desktopAuthorizationRequested = true
        if desktopCombinedAttempted && !desktopLegacyFallback {
            let prepared = desktopPreparedDecision
            desktopPreparedDecision = nil
            try Task.checkCancellation()
            guard let prepared,
                  try connection.stopRevision(userID: record.userID,
                      organizationID: record.organizationID) == revision,
                  let expiry = sourceDate(prepared.expiresAt), expiry > now() else {
                throw ProviderNativeError.unavailable
            }
            return prepared
        }
#endif
        // Preserve the server's original unissued preparation deadline. Ready
        // refresh must retire this owner, never renew it by changing metadata.
        guard let expires = preparationExpiresAt, let expiry = sourceDate(expires), expiry > now() else {
            throw ProviderNativeError.unavailable
        }
        let result = try await send(action: "authorize", key: authorizeKey)
        return try decision(result, grant: grant)
    }

    private func decision(_ result: [String: Any], grant: NativeSourceGrant) throws -> NativeSourceDecision {
        guard Set(result.keys) == ["receipt", "secret"],
              let receipt = result["receipt"] as? [String: Any],
              let secret = result["secret"] as? String, secret == proof else {
            throw ProviderNativeError.response
        }
        let checked = try checkReceipt(receipt)
        let now = now()
        guard checked.sourceLeaseID == grant.sourceLeaseID,
              checked.actorID == grant.actorID, checked.consentRecordID == grant.consentRecordID,
              receipt["state"] as? String == "issued",
              let issuedAt = receipt["issued_at"] as? String, let issue = sourceDate(issuedAt),
              let expiresAt = receipt["expires_at"] as? String, let expiry = sourceDate(expiresAt),
              issue <= now, expiry > now, expiry > issue, expiry.timeIntervalSince(issue) <= 15.001,
              let deadline = sourceDate(preparation.captureAuthorizedUntil), expiry <= deadline,
              let capabilityID = receipt["capability_id"] as? String,
              UUID(uuidString: capabilityID)?.uuidString.lowercased() == capabilityID else {
            throw ProviderNativeError.response
        }
        issued = true
        return NativeSourceDecision(grant: checked, capabilityID: capabilityID, secret: secret,
                                    issuedAt: issuedAt, expiresAt: expiresAt,
                                    captureAuthorizedUntil: preparation.captureAuthorizedUntil)
    }

#if os(macOS)
    /// Called only after deliberate Start and the trusted meeting-window choice.
    /// Retain the decision in native memory until the existing authorize RPC;
    /// returning the grant alone cannot start the audio helper.
    func prepareForDesktopStart() async throws -> NativeSourceGrant {
        if let ready = try await prepareAndAuthorizeDesktop() { return ready }
        // Only a known unsupported route permits the older separate decisions.
        return try await prepare()
    }

    private func prepareAndAuthorizeDesktop() async throws -> NativeSourceGrant? {
        try enter(); defer { busy = false }
        guard preparation.source == .desktop, grant == nil, !issued,
              !desktopCombinedAttempted else { throw ProviderNativeError.unavailable }
        desktopCombinedAttempted = true
        let nonce = UUID().uuidString.lowercased(), authorizeNonce = UUID().uuidString.lowercased()
        var body = envelope(action: "prepare", nonce: nonce)
        body["authorize_idempotency_key"] = authorizeKey
        body["authorize_request_nonce"] = authorizeNonce
        let request = try ProviderNativeRequest(nativeStartID: UUID(), revision: revision,
            key: prepareKey, body: JSONSerialization.data(withJSONObject: body), combinedPreparation: true)
        let reply = try await connection.sendFreshDesktopSourceStart(request, preparation: preparation)
        try Task.checkCancellation()
        guard !closed, !retiring else { throw ProviderNativeError.unavailable }
        if reply.status == 404 { desktopLegacyFallback = true; return nil }
        guard reply.status == 200,
              let pair = try JSONSerialization.jsonObject(with: reply.body) as? [String: Any],
              Set(pair.keys) == ["preparation", "authorization"],
              let prepared = pair["preparation"] as? [String: Any],
              let authorized = pair["authorization"] as? [String: Any] else {
            throw ProviderNativeError.response
        }
        let receipt = try responseReceipt(prepared, nonce: nonce)
        let checked = try checkReceipt(receipt)
        guard receipt["state"] as? String == "prepared",
              receipt["issued_at"] is NSNull, receipt["expires_at"] is NSNull,
              let expires = receipt["preparation_expires_at"] as? String,
              let expiry = sourceDate(expires), let deadline = sourceDate(preparation.captureAuthorizedUntil),
              now() < expiry, expiry <= deadline else { throw ProviderNativeError.response }
        let authorization = try responseReceipt(authorized, nonce: authorizeNonce)
        guard let issuedReceipt = authorization["receipt"] as? [String: Any],
              issuedReceipt["capability_id"] as? String == receipt["capability_id"] as? String,
              issuedReceipt["preparation_expires_at"] as? String == receipt["preparation_expires_at"] as? String else {
            throw ProviderNativeError.response
        }
        let ready = try decision(authorization, grant: checked)
        grant = checked
        desktopPreparedDecision = ready
        return checked
    }
#endif

    /// Called in the native microphone start path, immediately before acquiring
    /// audio. Returns metadata only. No permission can be manufactured in JavaScript.
    func consumeForMicrophone() async throws -> NativeCapturePermit {
        guard preparation.source == .ios else { throw ProviderNativeError.unavailable }
        let decision = try await authorize()
        guard let expiry = sourceDate(decision.expiresAt), expiry > Date(),
              NativeSourceConsumption.consumed.insert(decision.capabilityID).inserted else {
            throw ProviderNativeError.unavailable
        }
        guard let captureExpiry = sourceDate(decision.captureAuthorizedUntil) else {
            throw ProviderNativeError.response
        }
        let permit = try NativeCapturePermit(runID: decision.grant.sourceLeaseID,
                                             startExpiresAt: expiry, captureExpiresAt: captureExpiry)
        microphoneRunID = permit.runID
        return permit
    }

    /// Native continuation checks the original issued source and current account.
    /// Its renewed lease/monotonic PCM window owns the deadline after the first
    /// interval. Never replace the original proof or use it for a second start.
    func requireActiveMicrophone(runID: String) throws {
        try journal.requireUsable()
        guard preparation.source == .ios, issued, !closed, !retiring,
              microphoneRunID == runID, grant?.sourceLeaseID == runID,
              try connection.stopRevision(userID: record.userID,
                  organizationID: record.organizationID) == revision else {
            throw ProviderNativeError.authorityChanged
        }
    }

    func cancelPreparation() async throws {
        try enter(); defer { busy = false }
        guard !issued else { throw ProviderNativeError.unavailable }
        let receipt = try await send(action: "cancel", key: cancelKey)
        _ = try checkReceipt(receipt)
        guard receipt["state"] as? String == "cancelled" else { throw ProviderNativeError.response }
        try journal.removeAfterConfirmedStop(record)
        close()
    }

#if os(macOS)
    /// No decision was exposed to the audio owner, so physical start was
    /// impossible, including a combined request with an uncertain reply.
    func cancelUnstartedDesktopPreparation() async throws {
        guard !desktopAuthorizationRequested else { throw ProviderNativeError.unavailable }
        try await confirmStopped()
    }

#endif

    /// Caller must fence pending start and confirm physical native closure first.
    /// Keep the same proof/key after a lost response; never refresh start authority.
    func confirmStopped() async throws {
        retiring = true
        try enter(allowRetiring: true); defer { busy = false }
        let checked = try await record.stop(connection: connection)
        if let grant {
            guard let checked, checked.sourceLeaseID == grant.sourceLeaseID,
                  checked.actorID == grant.actorID, checked.consentRecordID == grant.consentRecordID else {
                throw ProviderNativeError.response
            }
        }
        try journal.removeAfterConfirmedStop(record)
        close()
    }

    /// Authentication loss irrevocably disables preparation/authorization for
    /// this owner. Its original proof remains usable only for confirmed stop.
    func retireForAuthenticationChange() {
        retiring = true
#if os(macOS)
        connection.abandonDesktopInitialWindow()
        desktopPreparedDecision = nil
#endif
    }

    func close() {
        closed = true; proof = ""; grant = nil; microphoneRunID = nil
#if os(macOS)
        connection.abandonDesktopInitialWindow()
        desktopPreparedDecision = nil
#endif
    }

    private func enter(allowRetiring: Bool = false) throws {
        try journal.requireUsable()
        guard !closed, !busy, (!retiring || allowRetiring), !proof.isEmpty else { throw ProviderNativeError.unavailable }
        busy = true
    }

    private func envelope(action: String, nonce: String) -> [String: Any] {
        var payload: [String: Any] = [
            "schema_version": "1.0", "attempt_id": attemptID, "owner_proof": proof,
            "source": preparation.source.rawValue,
            "lease_id": preparation.leaseID.uuidString.lowercased(),
            "lease_receipt_id": preparation.leaseReceiptID.uuidString.lowercased(),
            "lease_generation": preparation.leaseGeneration,
            "capture_authorized_until": preparation.captureAuthorizedUntil,
        ]
        if preparation.firstSequenceNumber > 0 { payload["first_sequence_number"] = preparation.firstSequenceNumber }
        return [
            "workspace_id": preparation.workspaceID.uuidString.lowercased(),
            "binding_ref": preparation.bindingRef, "request_nonce": nonce,
            "operation": ["kind": "source_start", "action": action, "payload": payload],
        ]
    }

    private func send(action: String, key: String) async throws -> [String: Any] {
        let nonce = UUID().uuidString.lowercased()
        let body = envelope(action: action, nonce: nonce)
        // Only the trusted host can supply a fresh, same-account revision, and
        // only cessation uses it. No start decision is rebound or refreshed.
        let requestRevision = action == "stop" ? try stopRevision?() ?? revision : revision
        let request = try ProviderNativeRequest(nativeStartID: UUID(), revision: requestRevision, key: key,
                                               body: JSONSerialization.data(withJSONObject: body))
        let reply = try await connection.send(request)
        guard !closed, (!retiring || action == "stop"), reply.status == 200,
              let value = try JSONSerialization.jsonObject(with: reply.body) as? [String: Any] else {
            throw ProviderNativeError.response
        }
        return try responseReceipt(value, nonce: nonce)
    }

    private func responseReceipt(_ value: [String: Any], nonce: String) throws -> [String: Any] {
        guard value["contract_version"] as? String == "1",
              value["operation"] as? String == "source_start",
              value["workspace_id"] as? String == preparation.workspaceID.uuidString.lowercased(),
              value["binding_ref"] as? String == preparation.bindingRef,
              value["request_nonce"] as? String == nonce,
              let receipt = value["receipt"] as? [String: Any] else {
            throw ProviderNativeError.response
        }
        return receipt
    }

    private func checkReceipt(_ receipt: [String: Any]) throws -> NativeSourceGrant {
        var keys: Set<String> = ["schema_version", "session_id", "attempt_id", "source_start_id",
            "creator_actor_id", "consent_record_id", "source", "lease_id", "lease_receipt_id",
            "lease_generation", "state", "preparation_expires_at", "capture_authorized_until",
            "issued_at", "expires_at", "capability_id"]
        if preparation.firstSequenceNumber > 0 { keys.insert("first_sequence_number") }
        guard Set(receipt.keys) == keys,
              try nativeSourceFirstSequence(receipt["first_sequence_number"]) == preparation.firstSequenceNumber,
              receipt["schema_version"] as? String == "1.0",
              receipt["session_id"] as? String == preparation.sessionID.uuidString.lowercased(),
              receipt["attempt_id"] as? String == attemptID,
              receipt["source"] as? String == preparation.source.rawValue,
              receipt["lease_id"] as? String == preparation.leaseID.uuidString.lowercased(),
              receipt["lease_receipt_id"] as? String == preparation.leaseReceiptID.uuidString.lowercased(),
              let generation = receipt["lease_generation"] as? NSNumber,
              CFGetTypeID(generation) != CFBooleanGetTypeID(),
              generation.doubleValue == Double(preparation.leaseGeneration),
              let deadline = receipt["capture_authorized_until"] as? String,
              sourceDate(deadline) == sourceDate(preparation.captureAuthorizedUntil),
              let actor = receipt["creator_actor_id"] as? String,
              actor.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil,
              let consent = receipt["consent_record_id"] as? String,
              UUID(uuidString: consent)?.uuidString.lowercased() == consent,
              let start = receipt["source_start_id"] as? String,
              UUID(uuidString: start)?.uuidString.lowercased() == start else {
            throw ProviderNativeError.response
        }
        return NativeSourceGrant(captureSessionID: preparation.sessionID.uuidString.lowercased(),
                                 actorID: actor, consentRecordID: consent,
                                 sourceLeaseID: start, source: preparation.source)
    }
}

/// Zero is represented by omission, preserving the accepted first-interval wire.
func nativeSourceFirstSequence(_ value: Any?) throws -> Int {
    guard let value else { return 0 }
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue == Double(number.intValue), (1..<2048).contains(number.intValue) else {
        throw ProviderNativeError.invalidRequest
    }
    return number.intValue
}

private func sourceDate(_ value: String) -> Date? {
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let parsed = format.date(from: value) { return parsed }
    format.formatOptions = [.withInternetDateTime]
    return format.date(from: value)
}
