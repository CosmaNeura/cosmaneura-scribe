import CosmasNativeAuth
import Foundation

// Real native session owner/connection, synthetic consent and an in-memory wire.
// No SDK account, Keychain, network, microphone or clinical content is accessed.
private struct Failure: Error { let line: UInt }
private func require(_ value: Bool, line: UInt = #line) throws {
    if !value { throw Failure(line: line) }
}
private func encoded(_ value: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
}
@MainActor private final class Clock {
    var instant = ContinuousClock.now
    var wall = Date()
    var expireAtTokenTiming = false, timingReads = 0
    var timings: [ProviderNativeRequestTiming] = []
    func advance(_ seconds: Double) {
        instant = instant.advanced(by: .seconds(seconds)); wall = wall.addingTimeInterval(seconds)
    }
}
@MainActor private final class Block: NativeAuthAccessBlock {
    var blocked = false
    func isBlocked() -> Bool { blocked }
    func setBlocked(_ value: Bool) { blocked = value }
}
@MainActor private final class Driver: NativeAuthDriver {
    var loaded = true
    var identity: NativeAuthIdentity? = try! .init(coreUserID: "user_synthetic", sessionID: "sess_synthetic")
    var tokens = 0, revoked = false
    var lifetime = 120
    var onToken: (() -> Void)?
    func signIn() async throws { throw NativeAuthError.signInFailed }
    func signOut() async throws { identity = nil }
    func freshToken() async throws -> String? {
        tokens += 1
        onToken?()
        if revoked { throw NativeAuthError.tokenUnavailable }
        let now = Int(Date().timeIntervalSince1970)
        func base64(_ data: Data) -> String {
            data.base64EncodedString().replacingOccurrences(of: "=", with: "")
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        }
        return try base64(encoded(["alg": "RS256", "kid": "synthetic"])) + "." + base64(encoded([
            "iss": "https://resolved-emu-53.clerk.accounts.dev", "sub": identity!.userID,
            "sid": identity!.sessionID, "iat": now - 10, "nbf": now - 10, "exp": now + lifetime,
        ])) + "." + base64(Data("synthetic-signature".utf8))
    }
}
@MainActor private final class Wire: ProviderNativeWire {
    let workspace = UUID().uuidString.lowercased(), session = UUID().uuidString.lowercased()
    let recovery = UUID().uuidString.lowercased()
    let binding = "scribe_capture_binding_01j00000000000000000000000"
    let appointment = "appointment_01j00000000000000000000000"
    let clock: Clock
    var calls: [ProviderNativeRequest] = []
    var admissionFault = "none", checkedAge = 0.0
    var holdAction: ProviderNativeAction?, wait: CheckedContinuation<Void, Never>?
    var loseWindowReply = false, windowStatus = 200
    init(_ clock: Clock) { self.clock = clock }
    func send(_ request: ProviderNativeRequest, token: String) async throws -> ProviderNativeReply {
        try require(token.split(separator: ".").count == 3)
        calls.append(request)
        if holdAction == request.action { await withCheckedContinuation { wait = $0 } }
        let body = try JSONSerialization.jsonObject(with: request.body) as! [String: Any]
        let date = ISO8601DateFormatter()
        date.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if request.action == .mount {
            return ProviderNativeReply(status: 200, body: try encoded([
                "revision": request.revision, "workspaceId": workspace, "bindingRef": binding,
                "recoveryScope": recovery, "appointmentRef": appointment,
                "encounter": ["appointmentRef": appointment, "admission_metadata_v1": true],
            ]))
        }
        if request.action == .admission {
            var metadata: [String: Any] = ["schema_version": "1.0",
                "review": ["schema_version": "1.0", "session_id": session,
                    "status": admissionFault == "capturing" ? "capturing" : "created",
                    "source": NSNull(), "working": NSNull(), "review_queue": NSNull(), "translation_progress": []],
                "encryption_key": ["key_version": "synthetic-v1", "algorithm": "RSA-OAEP-256",
                    "public_jwk": ["kty": "RSA", "n": String(repeating: "_", count: 512), "e": "AQAB",
                        "alg": "RSA-OAEP-256", "ext": true, "key_ops": ["wrapKey"]]],
                "capabilities": ["protocol_version": "1.0", "media": ["media_type": "audio/wav",
                    "encoding": "pcm_s16le", "channels": 1, "sample_rate_hz": 16000],
                    "target_chunk_duration_ms": 3000, "max_envelope_bytes": 200000, "max_chunks": 1000,
                    "remaining_aggregate_plaintext_bytes": 67108864, "capture_lease_ttl_seconds": 600,
                    "reservation_window_seconds": 900, "max_reservations_per_batch": 30, "upload_concurrency": 2],
            ]
            if admissionFault == "metadata-extra" { metadata["permission"] = true }
            if admissionFault == "legacy-key" {
                var key = metadata["encryption_key"] as! [String: Any]
                key["algorithm"] = "invalid"; metadata["encryption_key"] = key
            }
            if admissionFault == "review-session" {
                var review = metadata["review"] as! [String: Any]; review["session_id"] = UUID().uuidString.lowercased()
                metadata["review"] = review
            }
            if admissionFault == "capability-bool" {
                var capabilities = metadata["capabilities"] as! [String: Any]; capabilities["max_chunks"] = true
                metadata["capabilities"] = capabilities
            }
            var answer: [String: Any] = ["contract_version": "1", "workspace_id": workspace, "binding_ref": binding,
                "request_nonce": body["request_nonce"]!, "checked_at": date.string(from: clock.wall.addingTimeInterval(-checkedAge)),
                "appointment_ref": appointment, "operation_ref": "scribe_admission_01j00000000000000000000000",
                "consent_record_id": UUID().uuidString.lowercased(), "session_id": session, "status": "admitted",
                "configured_capture": body["configured_capture"]!, "preparation_metadata": metadata]
            if admissionFault == "appointment" { answer["appointment_ref"] = "appointment_01j00000000000000000000001" }
            if admissionFault == "nonce" || admissionFault == "legacy-nonce" { answer["request_nonce"] = UUID().uuidString.lowercased() }
            if admissionFault.hasPrefix("legacy") || admissionFault == "missing-status" { answer.removeValue(forKey: "status") }
            if admissionFault.hasPrefix("legacy") || admissionFault == "missing-configuration" { answer.removeValue(forKey: "configured_capture") }
            if admissionFault == "different-configuration" { answer["configured_capture"] = ["schema_version": "1.0", "language_mode": "es-US"] }
            if admissionFault == "extra-admission-field" { answer["unused_extension"] = true }
            return ProviderNativeReply(status: 200, body: try encoded(answer))
        }
        if loseWindowReply { throw ProviderNativeError.response }
        if windowStatus != 200 { return ProviderNativeReply(status: windowStatus, body: Data("{}".utf8)) }
        return ProviderNativeReply(status: 200, body: try encoded(["contract_version": "1", "workspace_id": workspace,
            "binding_ref": binding, "request_nonce": body["request_nonce"] ?? UUID().uuidString.lowercased(),
            "checked_at": date.string(from: clock.wall), "operation": "prepare_recording_window", "receipt": [:]]))
    }
}
@MainActor private final class Fixture {
    let clock = Clock(), driver = Driver()
    let auth: NativeWorkspaceAuth, wire: Wire, connection: NativeProviderConnection
    var admissionKey = "admission:" + UUID().uuidString.lowercased()
    var admissionNonce = UUID().uuidString.lowercased(), receipt = Data()
    init(enabled: Bool = true) throws {
        wire = Wire(clock)
        let policy = try NativeTokenPolicy(issuer: "https://resolved-emu-53.clerk.accounts.dev", audience: nil,
            authorizedParty: NativeWorkspaceOrigin.desktopApp.rawValue, identityProfile: .coreStagingPersonal)
        let driver = self.driver
        auth = NativeWorkspaceAuth(enabled: true, organizationID: nil, tokenPolicy: policy,
            driver: { driver }, accessBlock: { Block() })
        let clock = self.clock
        connection = NativeProviderConnection(auth: auth, wire: wire, desktopInitialWindowEnabled: enabled,
            desktopWallNow: { clock.wall }, contextNow: { clock.instant }, timingNow: {
                if clock.expireAtTokenTiming {
                    clock.timingReads += 1
                    if clock.timingReads == 2 { clock.advance(6) }
                }
                return clock.instant
            }, requestTiming: { clock.timings.append($0) })
        auth.onChange = { [weak connection] state in connection?.authChanged(state) }
    }
    func request(action: String, key: String, body: [String: Any]) throws -> ProviderNativeRequest {
        try ProviderNativeRequest(id: UUID().uuidString.lowercased(), revision: auth.state().revision,
            action: action, key: key, body: String(decoding: encoded(body), as: UTF8.self))
    }
    func mount() async throws {
        _ = try await connection.send(request(action: "mount", key: "mount:" + UUID().uuidString.lowercased(),
            body: ["workspace_id": wire.workspace]))
    }
    func admit() async throws {
        let response = try await connection.send(request(action: "capture-admissions", key: admissionKey,
            body: ["workspace_id": wire.workspace, "binding_ref": wire.binding, "request_nonce": admissionNonce,
                "attestation": ["all_parties_consented": true], "configured_capture": ["schema_version": "1.0", "language_mode": "en-US"],
                "preparation_metadata": true]))
        receipt = response.body
    }
    func prepare() async throws { try await mount(); try await admit(); try require(driver.tokens == 2) }
    func window(fault: String = "none") throws -> ProviderNativeRequest {
        var binding: [String: Any] = ["key_version": "synthetic-v1", "wrapped_dek": String(repeating: "_", count: 512)]
        if fault == "key-version" { binding["key_version"] = "foreign-v2" }
        var payload: [String: Any] = ["schema_version": "1.0", "binding": binding,
            "bind_idempotency_key": "bind-key:" + UUID().uuidString.lowercased(),
            "lease_idempotency_key": "lease:" + UUID().uuidString.lowercased(),
            "reserve_idempotency_key": "reserve:" + UUID().uuidString.lowercased(), "channel": "mixed", "reservation_count": 30]
        if fault == "channel" { payload["channel"] = "microphone" }
        if fault == "count" { payload["reservation_count"] = true }
        if fault == "extra" { payload["first_sequence_number"] = 0 }
        if fault == "recipe" { payload["lease_idempotency_key"] = payload["bind_idempotency_key"] }
        return try request(action: "capture-operations", key: "prepare-window:" + UUID().uuidString.lowercased(), body: [
            "workspace_id": wire.workspace, "binding_ref": wire.binding, "request_nonce": UUID().uuidString.lowercased(),
            "operation": ["kind": fault == "kind" ? "creator_review" : "prepare_recording_window", "payload": payload]])
    }
    func claim(_ request: ProviderNativeRequest? = nil, receipt: Data? = nil, nonce: String? = nil,
               beforeDispatch: @MainActor () async throws -> Void = {}) async throws -> ProviderNativeReply {
        try await connection.sendFreshDesktopInitialWindow(request ?? window(), admissionKey: admissionKey,
            admissionNonce: nonce ?? admissionNonce, admissionReceipt: receipt ?? self.receipt, beforeDispatch: beforeDispatch)
    }
}
private func rejected(_ run: () async throws -> Void) async throws {
    do { try await run(); throw Failure(line: #line) } catch is Failure { throw Failure(line: #line) } catch { }
}
@MainActor private func until(_ condition: () -> Bool) async throws {
    for _ in 0..<2000 { if condition() { return }; try await Task.sleep(for: .milliseconds(1)) }
    throw Failure(line: #line)
}
@main private struct CheckDesktopInitialWindow {
    @MainActor static func main() async throws {
        var checks = 0
        do {
            let f = try Fixture(); try await f.prepare(); _ = try await f.claim()
            try require(f.driver.tokens == 2 && f.wire.calls.count == 3)
            _ = try await f.claim(); try require(f.driver.tokens == 3 && f.wire.calls.count == 4)
            f.connection.close(); checks += 1
        }
        for extensionShape in ["legacy", "missing-status", "missing-configuration", "different-configuration", "extra-admission-field"] {
            let f = try Fixture(); f.wire.admissionFault = extensionShape
            try await f.prepare()
            let published = try JSONSerialization.jsonObject(with: f.receipt) as! [String: Any]
            try require(published["request_nonce"] as? String == f.admissionNonce)
            try require(published["session_id"] as? String == f.wire.session)
            _ = try await f.claim()
            try require(f.driver.tokens == 3 && f.wire.calls.count == 3)
            _ = try await f.connection.send(f.window())
            try require(f.driver.tokens == 4 && f.wire.calls.count == 4)
            f.connection.close(); checks += 1
        }
        for mandatoryFault in ["legacy-nonce", "legacy-key"] {
            let f = try Fixture(); f.wire.admissionFault = mandatoryFault
            try await f.mount(); try await rejected { try await f.admit() }
            try require(f.receipt.isEmpty && f.driver.tokens == 2 && f.wire.calls.count == 2)
            f.connection.close(); checks += 1
        }
        do {
            let f = try Fixture(); try await f.prepare()
            f.clock.expireAtTokenTiming = true
            f.driver.onToken = { f.clock.advance(0.25) }
            _ = try await f.claim()
            try require(f.driver.tokens == 3 && f.wire.calls.count == 3)
            try require(f.clock.timings.last?.tokenMilliseconds == 6250)
            f.connection.close(); checks += 1
        }
        for fault in ["disabled", "nonce", "receipt", "key-version", "channel", "count", "extra", "recipe", "kind", "abandon", "recovery", "deadline", "clock-back", "wall-back", "wall-forward", "checked-deadline", "jwt-deadline", "capturing"] {
            let f = try Fixture(enabled: fault != "disabled")
            if fault == "checked-deadline" { f.wire.checkedAge = 29.5 }
            if fault == "jwt-deadline" { f.driver.lifetime = 2 }
            if fault == "capturing" { f.wire.admissionFault = "capturing" }
            try await f.prepare()
            if fault == "abandon" { f.connection.abandonDesktopInitialWindow() }
            if fault == "deadline" { f.clock.advance(5) }
            if fault == "checked-deadline" { f.clock.advance(0.6) }
            if fault == "jwt-deadline" { f.clock.advance(2.1) }
            if fault == "clock-back" { f.clock.instant = f.clock.instant.advanced(by: .seconds(-1)) }
            if fault == "wall-back" { f.clock.wall = f.clock.wall.addingTimeInterval(-1) }
            if fault == "wall-forward" { f.clock.wall = f.clock.wall.addingTimeInterval(1) }
            _ = try await f.claim(f.window(fault: fault), receipt: fault == "receipt" ? encoded(["invented": true]) : nil,
                nonce: fault == "nonce" ? UUID().uuidString.lowercased() : nil,
                beforeDispatch: { if fault == "recovery" { f.connection.abandonDesktopInitialWindow() } })
            try require(f.driver.tokens == 3 && f.wire.calls.count == 3)
            f.connection.close(); checks += 1
        }
        for fault in ["metadata-extra", "review-session", "capability-bool", "appointment", "nonce"] {
            let f = try Fixture(); f.wire.admissionFault = fault; try await f.mount()
            try await rejected { try await f.admit() }; try require(f.wire.calls.count == 2)
            f.connection.close(); checks += 1
        }
        do {
            let f = try Fixture(); try await f.prepare(); f.driver.revoked = true
            _ = try await f.claim(); try require(f.driver.tokens == 2 && f.wire.calls.count == 3)
            let source = try ProviderNativeRequest(nativeStartID: UUID(), revision: f.auth.state().revision,
                key: "synthetic-source:" + UUID().uuidString.lowercased(), body: Data("{}".utf8))
            try await rejected { _ = try await f.connection.send(source) }
            try require(f.driver.tokens == 3 && f.wire.calls.count == 3)
            f.connection.close(); checks += 1
        }
        for boundary in ["admission-abandon", "window-abandon", "window-auth", "window-cancel", "reply-loss", "denied", "late-response", "concurrent", "changed-mount"] {
            let f = try Fixture()
            if boundary == "admission-abandon" {
                try await f.mount(); f.wire.holdAction = .admission
                let admission = Task { try await f.admit() }; try await until { f.wire.wait != nil }
                f.connection.abandonDesktopInitialWindow(); f.wire.wait?.resume(); f.wire.wait = nil
                try await admission.value; _ = try await f.claim(); try require(f.driver.tokens == 3)
            } else {
                try await f.prepare()
                if boundary == "changed-mount" {
                    try await f.mount(); _ = try await f.claim(); try require(f.driver.tokens == 4)
                } else if boundary == "reply-loss" {
                    f.wire.loseWindowReply = true; try await rejected { _ = try await f.claim() }
                    try require(f.wire.calls.count == 3 && f.driver.tokens == 2)
                } else if boundary == "denied" {
                    f.wire.windowStatus = 403; let reply = try await f.claim(); try require(reply.status == 403)
                    try require(f.wire.calls.count == 3 && f.driver.tokens == 2)
                } else {
                    f.wire.holdAction = .operation
                    let input = try f.window(), first = Task { try await f.claim(input) }
                    try await until { f.wire.wait != nil }
                    if boundary == "window-abandon" { f.connection.abandonDesktopInitialWindow() }
                    if boundary == "window-auth" { f.driver.identity = try .init(coreUserID: "user_foreign", sessionID: "sess_foreign"); _ = f.auth.state() }
                    if boundary == "window-cancel" { f.connection.cancel(input.id) }
                    if boundary == "late-response" { f.clock.advance(6) }
                    if boundary == "concurrent" {
                        f.wire.holdAction = nil; _ = try await f.claim()
                        try require(f.driver.tokens == 3 && f.wire.calls.count == 4)
                    }
                    f.wire.wait?.resume(); f.wire.wait = nil
                    if boundary == "late-response" { _ = try await first.value; try require(f.driver.tokens == 2) }
                    else { try await rejected { _ = try await first.value } }
                }
            }
            f.connection.close(); checks += 1
        }
        print("Desktop initial WINDOW: \(checks) fake native checks passed; SOURCE remains fresh. No accounts, network, Keychain or audio.")
    }
}
