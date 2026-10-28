import Foundation

public enum NativeIdentityProfile: String, Sendable {
    case clerkOrganization = "clerk-organization-v1"
    case coreStagingPersonal = "core-staging-personal-v1"
}

public enum NativeWorkspaceOrigin: String, Sendable {
    case appleWebView = "capacitor://localhost"
    case desktopApp = "app://cosmas"

    public func accepts(bundleIdentifier: String) -> Bool {
        if self == .desktopApp && bundleIdentifier == NativeClerkConfiguration.desktopBundleIdentifier {
            return true
        }
        if self == .appleWebView && bundleIdentifier == "com.cosmaneura.scribe.beta" {
            return true
        }
        let pattern = self == .appleWebView
            ? "^com\\.cosmasos\\.synthetic(?:\\.w[1-9][0-9]*[a-z]?)?$"
            : "^com\\.cosmasos\\.synthetic\\.desktop\\.auth(?:\\.w[1-9][0-9]*[a-z]?)?$"
        return bundleIdentifier.range(of: pattern, options: .regularExpression) != nil
    }
}

public struct NativeClerkConfiguration: Sendable, Equatable {
    public static let nativeOrigin = "capacitor://localhost"
#if SCRIBE_MAC_APP_STORE_XPC
    // A separate signed auth application also separates Clerk's bundle-derived
    // identity/recovery services and the default DP biometric Keychain group.
    public static let desktopBundleIdentifier = "com.cosmaneura.scribe.beta.desktop.store.auth"
#else
    public static let desktopBundleIdentifier = "com.cosmaneura.scribe.beta.desktop.auth"
#endif
    public let publishableKey: String
    public let frontendOrigin: String
    public let organizationID: String?
    public let identityProfile: NativeIdentityProfile
    public let bundleIdentifier: String
    public let workspaceOrigin: NativeWorkspaceOrigin
    public let sessionClaimsReceiptSHA256: String?
    public let nativePolicyReceiptSHA256: String?

    public var callbackURL: String { bundleIdentifier + "://callback" }

    public var keychainAccessGroup: String? {
#if SCRIBE_MAC_APP_STORE_XPC
        return bundleIdentifier == Self.desktopBundleIdentifier ? "JVV65668U6." + bundleIdentifier : nil
#else
        return nil
#endif
    }

    public init(publishableKey: String, frontendOrigin: String, organizationID: String?,
                bundleIdentifier: String, workspaceOrigin: NativeWorkspaceOrigin = .appleWebView,
                identityProfile: NativeIdentityProfile = .clerkOrganization,
                sessionClaimsReceiptSHA256: String? = nil,
                nativePolicyReceiptSHA256: String? = nil) throws {
        let production = frontendOrigin == "https://clerk.cosmaneura.com"
#if !SCRIBE_PRODUCTION_ORGANIZATION
        guard !production else { throw NativeAuthError.unavailable }
#endif
        if production {
            guard identityProfile == .clerkOrganization,
                  let sessionClaimsReceiptSHA256, let nativePolicyReceiptSHA256,
                  sessionClaimsReceiptSHA256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
                  nativePolicyReceiptSHA256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
            else { throw NativeAuthError.unavailable }
        } else if sessionClaimsReceiptSHA256 != nil || nativePolicyReceiptSHA256 != nil {
            throw NativeAuthError.unavailable
        }
        switch identityProfile {
        case .clerkOrganization:
            guard let organizationID,
                  organizationID.range(of: "^org_[A-Za-z0-9_]{1,251}$", options: .regularExpression) != nil
            else { throw NativeAuthError.unavailable }
        case .coreStagingPersonal:
            guard organizationID == nil,
                  (workspaceOrigin == .appleWebView && bundleIdentifier == "com.cosmaneura.scribe.beta"
                   || workspaceOrigin == .desktopApp && bundleIdentifier == Self.desktopBundleIdentifier),
                  frontendOrigin == "https://resolved-emu-53.clerk.accounts.dev"
            else { throw NativeAuthError.unavailable }
        }
        let keyPrefix = production ? "pk_live_" : "pk_test_"
        guard publishableKey.hasPrefix(keyPrefix), publishableKey.utf8.count <= 1024,
              workspaceOrigin.accepts(bundleIdentifier: bundleIdentifier),
              let url = URLComponents(string: frontendOrigin), url.scheme == "https",
              let host = url.host, host == host.lowercased(), url.port == nil,
              (production && host == "clerk.cosmaneura.com"
               || !production && host.range(of: "^[a-z0-9][a-z0-9.-]*\\.clerk\\.accounts\\.dev$",
                         options: .regularExpression) != nil),
              frontendOrigin == "https://" + host, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil else { throw NativeAuthError.unavailable }
        var encoded = String(publishableKey.dropFirst(keyPrefix.count))
        encoded = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard let data = Data(base64Encoded: encoded),
              String(data: data, encoding: .utf8) == host + "$" else { throw NativeAuthError.unavailable }
        self.publishableKey = publishableKey
        self.frontendOrigin = frontendOrigin
        self.organizationID = organizationID
        self.identityProfile = identityProfile
        self.bundleIdentifier = bundleIdentifier
        self.workspaceOrigin = workspaceOrigin
        self.sessionClaimsReceiptSHA256 = sessionClaimsReceiptSHA256
        self.nativePolicyReceiptSHA256 = nativePolicyReceiptSHA256
    }

    public func prepareFrontendRequest(_ request: inout URLRequest) throws {
        guard let components = request.url.flatMap({ URLComponents(url: $0, resolvingAgainstBaseURL: false) }),
              let host = components.host, components.scheme == "https", components.port == nil,
              "https://" + host == frontendOrigin, components.user == nil, components.password == nil,
              components.fragment == nil,
              request.value(forHTTPHeaderField: "Origin") == nil else {
            throw NativeAuthError.unavailable
        }
        // Clerk's native SDK authenticates its client using Authorization.
        // A browser Origin alongside that credential is rejected by the native
        // API (origin_authorization_headers_conflict). Preserve native headers;
        // workspace-origin and JWT checks remain at the OS transport boundary.
    }
}
