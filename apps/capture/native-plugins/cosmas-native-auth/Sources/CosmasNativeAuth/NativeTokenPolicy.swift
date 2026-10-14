import Foundation

/// Client-side binding checks only. The OS API still verifies the signature and
/// current human/Box authority; this decoder cannot authenticate a JWT itself.
public struct NativeTokenPolicy: Sendable {
    public let issuer: String
    public let audience: String?
    public let identityProfile: NativeIdentityProfile
    public let authorizedParty: String

    public init(issuer: String, audience: String?,
                authorizedParty: String = NativeClerkConfiguration.nativeOrigin,
                identityProfile: NativeIdentityProfile = .clerkOrganization) throws {
        switch identityProfile {
        case .clerkOrganization:
            guard let audience, !audience.isEmpty, audience.utf8.count <= 255,
                  audience.unicodeScalars.allSatisfy({ $0.isASCII && $0.value >= 33 && $0.value <= 126 })
            else { throw NativeAuthError.unavailable }
        case .coreStagingPersonal:
            guard audience == nil, issuer == "https://resolved-emu-53.clerk.accounts.dev",
                  (authorizedParty == NativeWorkspaceOrigin.appleWebView.rawValue
                   || authorizedParty == NativeWorkspaceOrigin.desktopApp.rawValue)
            else { throw NativeAuthError.unavailable }
        }
        guard let origin = URLComponents(string: issuer), origin.scheme == "https",
              let host = origin.host, issuer == "https://" + host,
              origin.user == nil, origin.password == nil, origin.port == nil,
              origin.query == nil, origin.fragment == nil,
              NativeWorkspaceOrigin(rawValue: authorizedParty) != nil else {
            throw NativeAuthError.unavailable
        }
        self.issuer = issuer
        self.audience = audience
        self.identityProfile = identityProfile
        self.authorizedParty = authorizedParty
    }

    public func validate(_ token: String, identity: NativeAuthIdentity, now: Date = Date(),
                         nativeSessionWithoutOrigin: Bool = false) throws {
        guard !nativeSessionWithoutOrigin || authorizedParty == NativeWorkspaceOrigin.appleWebView.rawValue
            || (identityProfile == .coreStagingPersonal
                && authorizedParty == NativeWorkspaceOrigin.desktopApp.rawValue)
        else { throw NativeAuthError.tokenUnavailable }
        guard token.utf8.count <= 8192 else { throw NativeAuthError.tokenUnavailable }
        let pieces = token.split(separator: ".", omittingEmptySubsequences: false)
        guard pieces.count == 3, let header = object(pieces[0]), let claims = object(pieces[1]),
              bytes(pieces[2]) != nil,
              header["alg"] as? String == "RS256", let kid = header["kid"] as? String,
              !kid.isEmpty, kid.utf8.count <= 255,
              claims["iss"] as? String == issuer,
              (claims["azp"] as? String == authorizedParty ||
               (nativeSessionWithoutOrigin && claims["azp"] == nil)),
              claims["sub"] as? String == identity.userID,
              claims["sid"] as? String == identity.sessionID else { throw NativeAuthError.tokenUnavailable }
        switch identityProfile {
        case .clerkOrganization:
            let audiences = (claims["aud"] as? String).map { [$0] } ?? claims["aud"] as? [String] ?? []
            let legacy = claims["org_id"] as? String
            let compact = (claims["o"] as? [String: Any])?["id"] as? String
            let organizations = [legacy, compact].compactMap { $0 }
            guard let audience, audiences.contains(audience), !organizations.isEmpty,
                  organizations.allSatisfy({ $0 == identity.organizationID })
            else { throw NativeAuthError.tokenUnavailable }
        case .coreStagingPersonal:
            // Core verifies its Clerk session without a workload audience.
            // Tenant/provider authority is rechecked by Core, never derived here.
            guard identity.organizationID == nil,
                  claims["org_id"] == nil || claims["org_id"] is NSNull,
                  claims["o"] == nil || claims["o"] is NSNull
            else { throw NativeAuthError.tokenUnavailable }
        }
        guard let expiration = time(claims["exp"]), let issued = time(claims["iat"]),
              let notBefore = time(claims["nbf"]), expiration > now.timeIntervalSince1970,
              issued <= now.timeIntervalSince1970 + 5,
              notBefore <= now.timeIntervalSince1970 + 5 else { throw NativeAuthError.tokenUnavailable }
    }

    public func initialWindowExpiration(_ token: String, identity: NativeAuthIdentity,
                                        now: Date = Date()) throws -> Date {
        try validate(token, identity: identity, now: now, nativeSessionWithoutOrigin: true)
        let pieces = token.split(separator: ".", omittingEmptySubsequences: false)
        guard pieces.count == 3, let claims = object(pieces[1]), let expiration = time(claims["exp"])
        else { throw NativeAuthError.tokenUnavailable }
        return Date(timeIntervalSince1970: expiration)
    }

    private func bytes(_ value: Substring) -> Data? {
        guard !value.isEmpty, value.unicodeScalars.allSatisfy({
            $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_")
        }) else { return nil }
        var encoded = String(value).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        return Data(base64Encoded: encoded)
    }

    private func object(_ value: Substring) -> [String: Any]? {
        guard let data = bytes(value) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private func time(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let result = number.doubleValue
        return result.isFinite && result >= 0 && result.rounded(.down) == result ? result : nil
    }
}
