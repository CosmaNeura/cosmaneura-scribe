import Foundation
import CosmasNativeAuth

@main struct ObservationCheck {
    @MainActor static func main() async throws {
        let identity = try NativeAuthIdentity(userID: "user_fixture", sessionID: "sess_fixture", organizationID: "org_fixture")
        let policy = try NativeTokenPolicy(issuer: "https://fixture.clerk.accounts.dev", audience: "fixture-api")
        let now = Int(Date().timeIntervalSince1970)
        let claims: [String: Any] = ["iss": policy.issuer, "aud": policy.audience, "azp": policy.authorizedParty,
            "sub": identity.userID, "sid": identity.sessionID, "org_id": identity.organizationID,
            "iat": now, "nbf": now, "exp": now + 60]
        func token(_ claims: [String: Any]) throws -> String {
            func part(_ object: [String: Any]) throws -> String {
                try JSONSerialization.data(withJSONObject: object).base64EncodedString()
                    .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
                    .replacingOccurrences(of: "=", with: "")
            }
            return try part(["alg": "RS256", "kid": "offline-fixture"]) + "." + part(claims) + ".AQ"
        }
        var missing = claims; missing.removeValue(forKey: "azp")
        var mismatch = claims; mismatch["azp"] = "https://unapproved.invalid"
        let missingToken = try token(missing)
        let mismatchToken = try token(mismatch)
        let validToken = try token(claims)
        precondition(W13ObservedAuthDriver.check(missingToken, identity: identity, policy: policy) == "app_binding_missing")
        precondition(W13ObservedAuthDriver.check(mismatchToken, identity: identity, policy: policy) == "app_binding_mismatch")
        precondition(W13ObservedAuthDriver.check(validToken, identity: identity, policy: policy) == "policy_passed")
        precondition(W13ObservedAuthDriver.check("invalid", identity: identity, policy: policy) == "policy_rejected")
        let base = FixtureDriver(identity: identity, token: missingToken)
        let driver = W13ObservedAuthDriver(base: base, policy: policy)
        let auth = NativeWorkspaceAuth(enabled: true, organizationID: identity.organizationID, tokenPolicy: policy,
            driver: { driver }, accessBlock: { FixtureBlock() })
        let ready = auth.state()
        let observation = driver.beginObservation()
        do { _ = try await auth.token(expectedRevision: ready.revision); preconditionFailure("Rejected token was authorized") }
        catch { precondition(error as? NativeAuthError == .tokenUnavailable) }
        precondition(driver.failureCode(for: observation) == "workspace_token_app_binding_missing")
        precondition(base.requests == 1)
        let next = driver.beginObservation()
        let unchangedToken = try await driver.freshToken()
        precondition(unchangedToken == missingToken)
        precondition(driver.failureCode(for: observation) == "workspace_token_unavailable")
        precondition(driver.failureCode(for: next) == "workspace_token_app_binding_missing")
        base.fail = true
        let failed = driver.beginObservation()
        do { _ = try await driver.freshToken(); preconditionFailure("SDK failure was swallowed") }
        catch { precondition(error is FixtureError) }
        precondition(driver.failureCode(for: failed) == "workspace_token_request_failed")
        print("Fixed token categories pass; original rejection and SDK result/error semantics remain unchanged. No live identity request made.")
    }
}

enum FixtureError: Error { case unavailable }
@MainActor final class FixtureDriver: NativeAuthDriver {
    let loaded = true
    let identity: NativeAuthIdentity?
    let token: String
    var requests = 0
    var fail = false
    init(identity: NativeAuthIdentity, token: String) { self.identity = identity; self.token = token }
    func freshToken() async throws -> String? { requests += 1; if fail { throw FixtureError.unavailable }; return token }
    func signIn() async throws { throw FixtureError.unavailable }
    func signOut() async throws { throw FixtureError.unavailable }
}
@MainActor final class FixtureBlock: NativeAuthAccessBlock {
    func isBlocked() throws -> Bool { false }
    func setBlocked(_ blocked: Bool) throws { }
}
