import Foundation
import CosmasNativeAuth

// One real URLSession/TLS/HTTP roundtrip with an offline SDK credential supplied
// over stdin. Only the test driver and access block are substitutes; the native
// session owner, token policy, fixed transport and receiver are the real code.
@MainActor final class OfflineDriver: NativeAuthDriver {
    var loaded = true
    var identity: NativeAuthIdentity?
    private let credential: String
    var tokens = 0
    init(identity: NativeAuthIdentity, token: String) { self.identity = identity; credential = token }
    func freshToken() async throws -> String? { tokens += 1; return credential }
    func signIn() async throws { throw NativeAuthError.signInFailed }
    func signOut() async throws { identity = nil }
}
@MainActor final class OfflineBlock: NativeAuthAccessBlock {
    var blocked = false
    func isBlocked() -> Bool { blocked }
    func setBlocked(_ value: Bool) { blocked = value }
}
enum RoundtripFailure: Error { case failed }
@main struct CheckNativeReceiver {
    @MainActor static func main() async throws {
        guard let config = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? [String: Any],
              let profile = config["profile"] as? [String: Any], let token = config["token"] as? String,
              let subject = config["subject"] as? String, let organization = config["organization"] as? String,
              let issuer = config["issuer"] as? String, let audience = config["audience"] as? String,
              let workspace = config["workspace"] as? String else { throw RoundtripFailure.failed }
        let identity = try NativeAuthIdentity(userID: subject, sessionID: "sess_invented", organizationID: organization)
        let driver = OfflineDriver(identity: identity, token: token)
        let auth = NativeWorkspaceAuth(enabled: true, organizationID: organization,
            tokenPolicy: try NativeTokenPolicy(issuer: issuer, audience: audience),
            driver: { driver }, accessBlock: { OfflineBlock() })
        let connection = NativeProviderConnection(auth: auth, wire: try ProviderNativeTransport(settings: profile))
        auth.onChange = { [weak connection] state in connection?.authChanged(state) }
        let revision = auth.state().revision
        func send(_ action: String, _ body: [String: Any]) async throws -> [String: Any] {
            let request = try ProviderNativeRequest(id: UUID().uuidString.lowercased(), revision: revision,
                action: action, key: UUID().uuidString.lowercased(),
                body: String(decoding: JSONSerialization.data(withJSONObject: body, options: .sortedKeys), as: UTF8.self))
            let reply = try await connection.send(request)
            guard reply.status == 200, let result = try JSONSerialization.jsonObject(with: reply.body) as? [String: Any]
            else { throw RoundtripFailure.failed }
            return result
        }
        let catalog = try await send("catalog", [:])
        guard let rows = catalog["encounters"] as? [[String: Any]], rows.count == 1,
              rows[0]["workspaceId"] as? String == workspace else { throw RoundtripFailure.failed }
        let mount = try await send("mount", ["workspace_id": workspace])
        guard let binding = mount["bindingRef"] as? String else { throw RoundtripFailure.failed }
        func scope() -> [String: Any] {
            ["workspace_id": workspace, "binding_ref": binding, "request_nonce": UUID().uuidString.lowercased()]
        }
        var admission = scope()
        admission["configured_capture"] = ["schema_version": "1.0", "language_mode": "en-US+es-US"]
        admission["attestation"] = ["modality": "in_person", "participant_regions": ["US-NY"],
            "method": "verbal_attestation", "all_parties_consented": true,
            "granted_at": ISO8601DateFormatter().string(from: Date())]
        let admitted = try await send("capture-admissions", admission)
        guard let session = admitted["session_id"] as? String else { throw RoundtripFailure.failed }
        var review = scope(); review["operation"] = ["kind": "creator_review"]
        _ = try await send("capture-operations", review)
        var notes = scope(); notes["action"] = "templates"; notes["expected_session_id"] = session
        _ = try await send("capture-notes", notes)
        guard driver.tokens == 5 else { throw RoundtripFailure.failed }
        var wrongPin = profile
        guard let originalPin = profile["leafSHA256"] as? String else { throw RoundtripFailure.failed }
        wrongPin["leafSHA256"] = (originalPin.first == "0" ? "1" : "0") + originalPin.dropFirst()
        let untrusted = NativeProviderConnection(auth: auth, wire: try ProviderNativeTransport(settings: wrongPin))
        let rejected = try ProviderNativeRequest(id: UUID().uuidString.lowercased(), revision: revision,
            action: "catalog", key: UUID().uuidString.lowercased(), body: "{}")
        do { _ = try await untrusted.send(rejected); throw RoundtripFailure.failed }
        catch is RoundtripFailure { throw RoundtripFailure.failed }
        catch { }
        untrusted.close()
        guard driver.tokens == 6 else { throw RoundtripFailure.failed }
        _ = try await auth.signOut()
        do { _ = try await send("catalog", [:]); throw RoundtripFailure.failed }
        catch is RoundtripFailure { throw RoundtripFailure.failed }
        catch { }
        connection.close()
        print("Native URLSession verified the pinned private certificate and completed catalog, Core mount, configured admission, review and note-template requests. Every attempt requested a fresh native token; a wrong certificate pin was rejected, and logout prevented another request. SDK, identity and Core data were offline fixtures; no Keychain, device, audio, real account or live Core service was used.")
    }
}
