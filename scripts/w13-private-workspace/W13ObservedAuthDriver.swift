import Foundation
import CosmasNativeAuth

/// Observes one existing token request without changing its result or policy.
/// Only a fixed failure category survives the call; no token or claim is stored.
@MainActor final class W13ObservedAuthDriver: NativeAuthDriver {
    private let base: any NativeAuthDriver
    private let policy: NativeTokenPolicy
    private var observation = UUID()
    private var requests = 0
    private var category = "unavailable"

    init(base: any NativeAuthDriver, policy: NativeTokenPolicy) {
        self.base = base; self.policy = policy
    }

    var loaded: Bool { base.loaded }
    var identity: NativeAuthIdentity? { base.identity }
    func signIn() async throws { try await base.signIn() }
    func signOut() async throws { try await base.signOut() }

    func beginObservation() -> UUID {
        observation = UUID(); requests = 0; category = "unavailable"
        return observation
    }

    func failureCode(for expected: UUID?) -> String {
        guard expected == observation, requests == 1 else { return "workspace_token_unavailable" }
        return "workspace_token_" + category
    }

    func freshToken() async throws -> String? {
        let current = observation
        requests += 1
        category = "request_pending"
        do {
            let token = try await base.freshToken()
            if current == observation {
                if let token, let identity = base.identity {
                    category = Self.check(token, identity: identity, policy: policy)
                } else { category = token == nil ? "empty" : "identity_changed" }
            }
            return token
        } catch {
            if current == observation { category = "request_failed" }
            throw error
        }
    }

    static func check(_ token: String, identity: NativeAuthIdentity, policy: NativeTokenPolicy) -> String {
        do { try policy.validate(token, identity: identity); return "policy_passed" }
        catch {
            // This decode only classifies the already-rejected token. It grants
            // no authority; NativeWorkspaceAuth still applies the original policy.
            guard token.utf8.count <= 8192 else { return "policy_rejected" }
            let pieces = token.split(separator: ".", omittingEmptySubsequences: false)
            guard pieces.count == 3 else { return "policy_rejected" }
            var encoded = String(pieces[1]).replacingOccurrences(of: "-", with: "+")
                .replacingOccurrences(of: "_", with: "/")
            encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
            guard let data = Data(base64Encoded: encoded),
                  let claims = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            else { return "policy_rejected" }
            if claims["azp"] == nil || claims["azp"] is NSNull { return "app_binding_missing" }
            if claims["azp"] as? String != policy.authorizedParty { return "app_binding_mismatch" }
            return "policy_rejected"
        }
    }
}
