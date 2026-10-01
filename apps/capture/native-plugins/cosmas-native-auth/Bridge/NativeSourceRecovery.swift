// INERT PROPOSAL. Shared native stop-only recovery; no renderer proof surface.
import Foundation
import CryptoKit
import CosmasNativeAuth

extension NativeSourceProofRecord {
    @MainActor func stop(connection: NativeProviderConnection) async throws -> NativeSourceGrant? {
        let revision = try connection.stopRevision(userID: userID, organizationID: organizationID)
        let nonce = UUID().uuidString.lowercased()
        var payload: [String: Any] = [
            "schema_version": "1.0", "attempt_id": attemptID.uuidString.lowercased(),
            "owner_proof": ownerProof, "source": source,
            "lease_id": leaseID.uuidString.lowercased(), "lease_receipt_id": leaseReceiptID.uuidString.lowercased(),
            "lease_generation": leaseGeneration, "capture_authorized_until": captureAuthorizedUntil,
        ]
        if firstSequenceNumber > 0 { payload["first_sequence_number"] = firstSequenceNumber }
        let body: [String: Any] = ["workspace_id": workspaceID.uuidString.lowercased(),
            "binding_ref": bindingRef, "request_nonce": nonce,
            "operation": ["kind": "source_start", "action": "stop", "payload": payload]]
        let request = try ProviderNativeRequest(nativeStartID: UUID(), revision: revision,
            key: stopKey.uuidString.lowercased(), body: JSONSerialization.data(withJSONObject: body))
        let reply = try await connection.send(request)
        guard try connection.stopRevision(userID: userID, organizationID: organizationID) == revision,
              reply.status == 200,
              let value = try JSONSerialization.jsonObject(with: reply.body) as? [String: Any],
              Set(value.keys) == ["contract_version", "operation", "workspace_id", "binding_ref", "request_nonce", "receipt", "checked_at"],
              value["contract_version"] as? String == "1", value["operation"] as? String == "source_start",
              value["workspace_id"] as? String == workspaceID.uuidString.lowercased(),
              value["binding_ref"] as? String == bindingRef, value["request_nonce"] as? String == nonce,
              let checked = value["checked_at"] as? String, nativeRecoveryDate(checked) != nil,
              let receipt = value["receipt"] as? [String: Any] else { throw ProviderNativeError.response }
        return try checkTerminalReceipt(receipt)
    }

    func checkTerminalReceipt(_ receipt: [String: Any]) throws -> NativeSourceGrant? {
        var keys: Set<String> = ["schema_version", "session_id", "attempt_id", "creator_actor_id",
            "consent_record_id", "source", "lease_id", "lease_receipt_id", "lease_generation", "state", "capture_authorized_until"]
        let unstarted = receipt["state"] as? String == "unstarted"
        keys.formUnion(unstarted ? ["retirement_id", "owner_proof_sha256", "retired_at"] :
            ["source_start_id", "preparation_expires_at", "issued_at", "expires_at", "capability_id"])
        if firstSequenceNumber > 0 { keys.insert("first_sequence_number") }
        func uuid(_ key: String) -> Bool {
            guard let value = receipt[key] as? String else { return false }
            return UUID(uuidString: value)?.uuidString.lowercased() == value
        }
        guard Set(receipt.keys) == keys, receipt["schema_version"] as? String == "1.0",
              receipt["session_id"] as? String == sessionID.uuidString.lowercased(),
              receipt["attempt_id"] as? String == attemptID.uuidString.lowercased(),
              receipt["source"] as? String == source,
              receipt["lease_id"] as? String == leaseID.uuidString.lowercased(),
              receipt["lease_receipt_id"] as? String == leaseReceiptID.uuidString.lowercased(),
              try nativeSourceFirstSequence(receipt["first_sequence_number"]) == firstSequenceNumber,
              let generation = receipt["lease_generation"] as? NSNumber,
              CFGetTypeID(generation) != CFBooleanGetTypeID(), generation.doubleValue == Double(leaseGeneration),
              let deadline = receipt["capture_authorized_until"] as? String,
              nativeRecoveryDate(deadline) == nativeRecoveryDate(captureAuthorizedUntil),
              let actor = receipt["creator_actor_id"] as? String,
              actor.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil,
              uuid("consent_record_id") else { throw ProviderNativeError.response }
        if unstarted {
            let digest = SHA256.hash(data: Data(ownerProof.utf8)).map { String(format: "%02x", $0) }.joined()
            guard uuid("retirement_id"), receipt["owner_proof_sha256"] as? String == digest,
                  let time = receipt["retired_at"] as? String, let retired = nativeRecoveryDate(time),
                  retired <= Date() else { throw ProviderNativeError.response }
            return nil
        } else {
            guard let state = receipt["state"] as? String, ["stopped", "cancelled", "expired"].contains(state),
                  uuid("source_start_id"), uuid("capability_id"),
                  let preparation = receipt["preparation_expires_at"] as? String,
                  nativeRecoveryDate(preparation) != nil else { throw ProviderNativeError.response }
            for name in ["issued_at", "expires_at"] {
                guard receipt[name] is NSNull || (receipt[name] as? String).flatMap(nativeRecoveryDate) != nil else {
                    throw ProviderNativeError.response
                }
            }
            guard let kind = NativeSourcePreparation.Source(rawValue: source) else { throw ProviderNativeError.response }
            return NativeSourceGrant(captureSessionID: sessionID.uuidString.lowercased(), actorID: actor,
                consentRecordID: receipt["consent_record_id"] as! String,
                sourceLeaseID: receipt["source_start_id"] as! String, source: kind)
        }
    }
}

/// Construct once per native process. No live owner may be created until this
/// boot barrier completes. Subsequent normal owners own their physical stop.
@MainActor final class NativeSourceRecovery {
    let journal: NativeSourceProofJournal
    private var ready = false
    private var recovering = false
    #if os(macOS)
    private var coordinator: NativeCaptureProcessCoordinator?
    #endif
    private let desktopDirectory: String?
    init(journal: NativeSourceProofJournal, desktopDirectory: String? = nil) {
        self.journal = journal; self.desktopDirectory = desktopDirectory
    }
    func recover(connection: NativeProviderConnection) async throws {
        #if !os(macOS)
        // A desktop path never substitutes for the mobile process's idle gate.
        guard desktopDirectory == nil else { throw ProviderNativeError.unavailable }
        #endif
        try journal.requireUsable()
        if ready { return }
        guard !recovering else { throw ProviderNativeError.unavailable }
        recovering = true; defer { recovering = false }
        #if os(macOS)
        if let desktopDirectory {
            if coordinator == nil {
                let expected = journal.anchor
                let acquired = try NativeCaptureProcessCoordinator(privateDirectory: desktopDirectory, expectedAnchor: expected)
                try journal.reloadWhileExclusive(expectedAnchor: expected)
                try journal.initializeAnchor(acquired.anchor)
                coordinator = acquired
            }
            try await retireSavedOwners(connection)
            try coordinator!.allowCaptureAfterConfirmedRecovery()
        } else {
            try await recoverWhileIdle(connection)
        }
        #else
        try await recoverWhileIdle(connection)
        #endif
        ready = true
    }
    func requireReady() throws { guard ready else { throw ProviderNativeError.unavailable }; try journal.requireUsable() }
    var processFence: [String: Any] {
        get throws {
            try requireReady()
            #if os(macOS)
            guard let coordinator else { throw ProviderNativeError.unavailable }
            return coordinator.wireValue
            #else
            throw ProviderNativeError.unavailable
            #endif
        }
    }
    private func recoverWhileIdle(_ connection: NativeProviderConnection) async throws {
        try await NativeCaptureStartGate.recoverWhileIdle {
            try await self.retireSavedOwners(connection)
        }
    }
    private func retireSavedOwners(_ connection: NativeProviderConnection) async throws {
        for record in journal.pending {
            _ = try await record.stop(connection: connection)
            try journal.removeAfterConfirmedStop(record)
        }
    }
}
