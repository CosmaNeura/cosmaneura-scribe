import Foundation
import Testing
@testable import CosmasNativeAuth

@Suite @MainActor struct NativeSessionPolicyTests {
    private let identity = try! NativeAuthIdentity(userID: "user_fixture", sessionID: "sess_fixture", organizationID: "org_fixture")
    private let policy = try! NativeTokenPolicy(issuer: "https://fixture.clerk.accounts.dev", audience: "fixture-api")

    private func token(_ changes: [String: Any] = [:], omit: Set<String> = [], algorithm: String = "RS256") throws -> String {
        let now = Int(Date().timeIntervalSince1970)
        var claims: [String: Any] = ["iss": policy.issuer, "aud": policy.audience, "sub": identity.userID,
            "sid": identity.sessionID, "org_id": identity.organizationID, "iat": now, "nbf": now, "exp": now + 60]
        claims.merge(changes) { _, new in new }
        for key in omit { claims.removeValue(forKey: key) }
        func part(_ value: [String: Any]) throws -> String {
            try JSONSerialization.data(withJSONObject: value).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        return try part(["alg": algorithm, "kid": "offline-only"]) + "." + part(claims) + ".AQ"
    }

    @Test func onlyExplicitNativeCatalogModeAcceptsAbsence() throws {
        let value = try token()
        #expect(throws: NativeAuthError.tokenUnavailable) { try policy.validate(value, identity: identity) }
        try policy.validate(value, identity: identity, nativeSessionWithoutOrigin: true)
        try policy.validate(token(["azp": "capacitor://localhost"]), identity: identity, nativeSessionWithoutOrigin: true)
        for origin: Any in [NSNull(), "", "https://unapproved.invalid", "app://cosmas", 42, ["capacitor://localhost"]] {
            #expect(throws: NativeAuthError.tokenUnavailable) {
                try policy.validate(token(["azp": origin]), identity: identity, nativeSessionWithoutOrigin: true)
            }
        }
        let desktop = try NativeTokenPolicy(issuer: policy.issuer, audience: policy.audience, authorizedParty: "app://cosmas")
        #expect(throws: NativeAuthError.tokenUnavailable) {
            try desktop.validate(value, identity: identity, nativeSessionWithoutOrigin: true)
        }
    }

    @Test func allOtherBindingsAndTimeChecksRemainRequired() throws {
        let future = Int(Date().timeIntervalSince1970) + 600
        for changes: [String: Any] in [
            ["iss": "https://other.clerk.accounts.dev"], ["aud": "other-api"], ["sub": "user_other"],
            ["sid": "sess_other"], ["org_id": "org_other"], ["o": ["id": "org_other"]],
            ["exp": 1], ["iat": future], ["nbf": future], ["exp": true],
        ] {
            #expect(throws: NativeAuthError.tokenUnavailable) {
                try policy.validate(token(changes), identity: identity, nativeSessionWithoutOrigin: true)
            }
        }
        for missing in ["iss", "aud", "sub", "sid", "org_id", "iat", "nbf", "exp"] {
            #expect(throws: NativeAuthError.tokenUnavailable) {
                try policy.validate(token(omit: [missing]), identity: identity, nativeSessionWithoutOrigin: true)
            }
        }
        #expect(throws: NativeAuthError.tokenUnavailable) {
            try policy.validate(token(algorithm: "HS256"), identity: identity, nativeSessionWithoutOrigin: true)
        }
        try policy.validate(token(["o": ["id": identity.organizationID]], omit: ["org_id"]),
            identity: identity, nativeSessionWithoutOrigin: true)
    }

    @Test func coordinatorKeepsTheDefaultStrictAndBindsNativeIdentity() async throws {
        let driver = NativeFixtureDriver(identity: identity, token: try token())
        func coordinator() -> NativeWorkspaceAuth {
            NativeWorkspaceAuth(enabled: true, organizationID: identity.organizationID, tokenPolicy: policy,
                driver: { driver }, accessBlock: { NativeFixtureBlock() })
        }
        let strict = coordinator()
        await #expect(throws: NativeAuthError.tokenUnavailable) { try await strict.token(expectedRevision: strict.state().revision) }
        let native = coordinator()
        #expect(try await native.token(expectedRevision: native.state().revision, nativeSessionWithoutOrigin: true) == driver.value)
        let changed = coordinator()
        let revision = changed.state().revision
        driver.beforeReturn = { driver.identity = try! NativeAuthIdentity(userID: "user_other", sessionID: "sess_other", organizationID: "org_fixture") }
        await #expect(throws: NativeAuthError.tokenUnavailable) {
            try await changed.token(expectedRevision: revision, nativeSessionWithoutOrigin: true)
        }
    }

    @Test func observerDoesNotMislabelAnotherFailureAsMissingOrigin() throws {
        #expect(W13ObservedAuthDriver.check(try token(), identity: identity, policy: policy) == "policy_passed")
        #expect(W13ObservedAuthDriver.check(try token(["aud": "wrong-api"]), identity: identity,
            policy: policy) == "policy_rejected")
        #expect(W13ObservedAuthDriver.check(try token(["azp": "https://wrong.invalid"]), identity: identity,
            policy: policy) == "app_binding_mismatch")
    }
}

@MainActor private final class NativeFixtureDriver: NativeAuthDriver {
    let loaded = true
    var identity: NativeAuthIdentity?
    let value: String
    var beforeReturn: (() -> Void)?
    init(identity: NativeAuthIdentity, token: String) { self.identity = identity; value = token }
    func freshToken() async throws -> String? { beforeReturn?(); return value }
    func signIn() async throws { throw NativeAuthError.unavailable }
    func signOut() async throws { identity = nil }
}
@MainActor private final class NativeFixtureBlock: NativeAuthAccessBlock {
    func isBlocked() throws -> Bool { false }
    func setBlocked(_ blocked: Bool) throws { }
}
