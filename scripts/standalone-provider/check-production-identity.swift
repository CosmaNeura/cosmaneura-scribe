import Foundation

// Client binding checks only: inert fixtures, no SDK, Keychain or network.
private enum Failure: Error { case failed }
@main struct CheckProductionIdentity {
    static func main() throws {
        let issuer = "https://clerk.cosmaneura.com"
        let key = "pk_live_" + Data("clerk.cosmaneura.com$".utf8).base64EncodedString()
        func configuration(receipt: String? = String(repeating: "1", count: 64)) throws -> NativeClerkConfiguration {
            try NativeClerkConfiguration(publishableKey: key, frontendOrigin: issuer, organizationID: "org_fixture",
                bundleIdentifier: "com.cosmaneura.scribe.beta", sessionClaimsReceiptSHA256: receipt)
        }
#if SCRIBE_PRODUCTION_ORGANIZATION
        _ = try configuration()
        do { _ = try configuration(receipt: nil); throw Failure.failed }
        catch NativeAuthError.unavailable { }
#else
        do { _ = try configuration(); throw Failure.failed }
        catch NativeAuthError.unavailable { }
#endif
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let identity = try NativeAuthIdentity(userID: "user_fixture", sessionID: "sess_fixture", organizationID: "org_fixture")
        func token(_ changed: [String: Any], removing: String? = nil) throws -> String {
            var claims: [String: Any] = ["iss": issuer, "aud": "fixture-audience", "org_id": "org_fixture",
                "sid": "sess_fixture", "sub": "user_fixture", "azp": "capacitor://localhost",
                "exp": 2_000_000_060, "iat": 2_000_000_000, "nbf": 2_000_000_000]
            claims.merge(changed) { _, new in new }; if let removing { claims.removeValue(forKey: removing) }
            func part(_ value: [String: Any]) throws -> String {
                try JSONSerialization.data(withJSONObject: value).base64EncodedString()
                    .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
                    .replacingOccurrences(of: "=", with: "")
            }
            return try part(["alg": "RS256", "kid": "fixture"]) + "." + part(claims) + ".AA"
        }
        for party in NativeWorkspaceOrigin.allTestCases {
            let policy = try NativeTokenPolicy(issuer: issuer, audience: "fixture-audience", authorizedParty: party.rawValue)
            let valid = try token(["azp": party.rawValue])
            try policy.validate(valid, identity: identity, now: now, nativeSessionWithoutOrigin: true)
            _ = try policy.initialWindowExpiration(valid, identity: identity, now: now)
            for invalid in [try token([:], removing: "azp"), try token(["azp": "https://untrusted.example"]),
                try token(["aud": "wrong-audience", "azp": party.rawValue]),
                try token(["org_id": "org_other", "azp": party.rawValue]), try token(["azp": party.rawValue], removing: "sid")] {
                do { try policy.validate(invalid, identity: identity, now: now, nativeSessionWithoutOrigin: true); throw Failure.failed }
                catch NativeAuthError.tokenUnavailable { }
            }
        }
        print("Production identity compile gate and strict issuer/audience/org/session/authorized-party bindings passed. No authentication or runtime operation.")
    }
}
private extension NativeWorkspaceOrigin {
    static var allTestCases: [NativeWorkspaceOrigin] { [.appleWebView, .desktopApp] }
}
