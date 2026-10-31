import Foundation

// Client binding checks only: inert fixtures, no SDK, Keychain or network.
private enum Failure: Error { case failed }
@main struct CheckProductionIdentity {
    static func main() throws {
        let issuer = "https://clerk.cosmaneura.com"
        let key = "pk_live_" + Data("clerk.cosmaneura.com$".utf8).base64EncodedString()
        let claimsReceipt = String(repeating: "1", count: 64)
        let policyReceipt = String(repeating: "2", count: 64)
        func configuration(claims: String? = claimsReceipt,
                           policy: String? = policyReceipt) throws -> NativeClerkConfiguration {
            try NativeClerkConfiguration(publishableKey: key, frontendOrigin: issuer, organizationID: "org_fixture",
                bundleIdentifier: "com.cosmaneura.scribe.beta", sessionClaimsReceiptSHA256: claims,
                nativePolicyReceiptSHA256: policy)
        }
#if SCRIBE_PRODUCTION_ORGANIZATION
        let production = try configuration()
        do { _ = try configuration(claims: nil); throw Failure.failed }
        catch NativeAuthError.unavailable { }
        do { _ = try configuration(policy: nil); throw Failure.failed }
        catch NativeAuthError.unavailable { }
        do { _ = try configuration(policy: "2" + String(repeating: "g", count: 63)); throw Failure.failed }
        catch NativeAuthError.unavailable { }
        let selectedPolicyReceipt = production.nativePolicyReceiptSHA256
#else
        do { _ = try configuration(); throw Failure.failed }
        catch NativeAuthError.unavailable { }
        do {
            _ = try NativeClerkConfiguration(publishableKey: key, frontendOrigin: issuer,
                organizationID: nil, bundleIdentifier: "com.cosmaneura.scribe.beta",
                identityProfile: .coreProductionPersonal,
                sessionClaimsReceiptSHA256: claimsReceipt, nativePolicyReceiptSHA256: policyReceipt)
            throw Failure.failed
        } catch NativeAuthError.unavailable { }
        do {
            _ = try NativeTokenPolicy(issuer: issuer, audience: nil,
                identityProfile: .coreProductionPersonal,
                productionNativePolicyReceiptSHA256: policyReceipt)
            throw Failure.failed
        } catch NativeAuthError.unavailable { }
        let selectedPolicyReceipt: String? = nil
#endif
        guard let selectedPolicyReceipt else { return }
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let identity = try NativeAuthIdentity(userID: "user_fixture", sessionID: "sess_fixture", organizationID: "org_fixture")
        func token(_ changed: [String: Any], removing: String? = nil, personal: Bool = false) throws -> String {
            var claims: [String: Any] = ["iss": issuer, "aud": "fixture-audience", "org_id": "org_fixture",
                "sid": "sess_fixture", "sub": "user_fixture", "azp": "capacitor://localhost",
                "exp": 2_000_000_060, "iat": 2_000_000_000, "nbf": 2_000_000_000]
            if personal { claims.removeValue(forKey: "org_id"); claims.removeValue(forKey: "aud") }
            claims.merge(changed) { _, new in new }; if let removing { claims.removeValue(forKey: removing) }
            func part(_ value: [String: Any]) throws -> String {
                try JSONSerialization.data(withJSONObject: value).base64EncodedString()
                    .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
                    .replacingOccurrences(of: "=", with: "")
            }
            return try part(["alg": "RS256", "kid": "fixture"]) + "." + part(claims) + ".AA"
        }
        for party in NativeWorkspaceOrigin.allTestCases {
            let policy = try NativeTokenPolicy(issuer: issuer, audience: "fixture-audience",
                authorizedParty: party.rawValue,
                productionNativePolicyReceiptSHA256: selectedPolicyReceipt)
            let valid = try token(["azp": party.rawValue])
            try policy.validate(valid, identity: identity, now: now, nativeSessionWithoutOrigin: true)
            _ = try policy.initialWindowExpiration(valid, identity: identity, now: now)
            let missing = try token([:], removing: "azp")
            try policy.validate(missing, identity: identity, now: now, nativeSessionWithoutOrigin: true)
            _ = try policy.initialWindowExpiration(missing, identity: identity, now: now)
            do { try policy.validate(missing, identity: identity, now: now); throw Failure.failed }
            catch NativeAuthError.tokenUnavailable { }
            for invalid in [try token(["azp": NSNull()]), try token(["azp": "https://untrusted.example"]),
                try token(["iss": "https://untrusted.example", "azp": party.rawValue]),
                try token(["aud": "wrong-audience", "azp": party.rawValue]),
                try token(["org_id": "org_other", "azp": party.rawValue]),
                try token(["sub": "user_other", "azp": party.rawValue]),
                try token(["azp": party.rawValue], removing: "sid")] {
                do { try policy.validate(invalid, identity: identity, now: now, nativeSessionWithoutOrigin: true); throw Failure.failed }
                catch NativeAuthError.tokenUnavailable { }
            }
        }
        let personalIdentity = try NativeAuthIdentity(coreUserID: "user_fixture", sessionID: "sess_fixture")
        let state = NativeAuthState(phase: .ready, revision: UUID().uuidString.lowercased(), identity: personalIdentity)
        let payload = NativeAuthPayload.state(state, identityProfile: .coreProductionPersonal)
        guard (payload["identity"] as? [String: Any])?["identityProfile"] as? String == "core-production-personal-v1",
              state.identity == personalIdentity,
              personalIdentity.bridgePayload["identityProfile"] as? String == "core-staging-personal-v1"
        else { throw Failure.failed }
        for party in NativeWorkspaceOrigin.allTestCases {
            let bundle = party == .appleWebView ? "com.cosmaneura.scribe.beta" : NativeClerkConfiguration.desktopBundleIdentifier
            _ = try NativeClerkConfiguration(publishableKey: key, frontendOrigin: issuer,
                organizationID: nil, bundleIdentifier: bundle, workspaceOrigin: party,
                identityProfile: .coreProductionPersonal,
                sessionClaimsReceiptSHA256: claimsReceipt, nativePolicyReceiptSHA256: policyReceipt)
            let policy = try NativeTokenPolicy(issuer: issuer, audience: nil, authorizedParty: party.rawValue,
                identityProfile: .coreProductionPersonal, productionNativePolicyReceiptSHA256: policyReceipt)
            try policy.validate(token(["azp": party.rawValue], personal: true), identity: personalIdentity, now: now)
            try policy.validate(token([:], removing: "azp", personal: true), identity: personalIdentity,
                now: now, nativeSessionWithoutOrigin: true)
            _ = try policy.initialWindowExpiration(token([:], removing: "azp", personal: true), identity: personalIdentity, now: now)
            for invalid in [try token(["iss": "https://untrusted.example"], personal: true),
                try token(["azp": "https://app.cosmaneura.com"], personal: true),
                try token(["azp": NSNull()], personal: true),
                try token(["sid": "sess_other"], personal: true),
                try token(["sub": "user_other"], personal: true),
                try token(["org_id": "org_other"], personal: true),
                try token(["o": ["id": "org_other"]], personal: true),
                try token(["aud": "unobserved-audience"], personal: true),
                try token(["aud": NSNull()], personal: true),
                try token(["exp": 1_999_999_000], personal: true)] {
                do { try policy.validate(invalid, identity: personalIdentity, now: now, nativeSessionWithoutOrigin: true); throw Failure.failed }
                catch NativeAuthError.tokenUnavailable { }
            }
            let audiencePolicy = try NativeTokenPolicy(issuer: issuer, audience: "observed-audience", authorizedParty: party.rawValue,
                identityProfile: .coreProductionPersonal, productionNativePolicyReceiptSHA256: policyReceipt)
            try audiencePolicy.validate(token(["aud": "observed-audience", "azp": party.rawValue], personal: true),
                identity: personalIdentity, now: now)
            for invalid in [try token(["azp": party.rawValue], personal: true),
                try token(["aud": "other", "azp": party.rawValue], personal: true)] {
                do { try audiencePolicy.validate(invalid, identity: personalIdentity, now: now); throw Failure.failed }
                catch NativeAuthError.tokenUnavailable { }
            }
        }
        for receipt in [nil, "", "g" + String(repeating: "2", count: 63)] as [String?] {
            do {
                _ = try NativeTokenPolicy(issuer: issuer, audience: nil, identityProfile: .coreProductionPersonal,
                    productionNativePolicyReceiptSHA256: receipt)
                throw Failure.failed
            } catch NativeAuthError.unavailable { }
        }
        do {
            _ = try NativeClerkConfiguration(publishableKey: key, frontendOrigin: issuer,
                organizationID: "org_other", bundleIdentifier: "com.cosmaneura.scribe.beta",
                identityProfile: .coreProductionPersonal,
                sessionClaimsReceiptSHA256: claimsReceipt, nativePolicyReceiptSHA256: policyReceipt)
            throw Failure.failed
        } catch NativeAuthError.unavailable { }
        do {
            _ = try NativeTokenPolicy(issuer: issuer, audience: "fixture-audience",
                productionNativePolicyReceiptSHA256: nil)
            throw Failure.failed
        } catch NativeAuthError.unavailable { }
        do {
            _ = try NativeTokenPolicy(issuer: "https://resolved-emu-53.clerk.accounts.dev",
                audience: "fixture-audience", productionNativePolicyReceiptSHA256: policyReceipt)
            throw Failure.failed
        } catch NativeAuthError.unavailable { }
        print("Production organization and personal receipt/profile/issuer/audience/session/native-party bindings passed. No authentication or runtime operation.")
    }
}
private extension NativeWorkspaceOrigin {
    static var allTestCases: [NativeWorkspaceOrigin] { [.appleWebView, .desktopApp] }
}
