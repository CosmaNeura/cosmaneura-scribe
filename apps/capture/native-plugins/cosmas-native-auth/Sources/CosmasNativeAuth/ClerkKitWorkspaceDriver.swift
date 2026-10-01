#if canImport(ClerkKit)
import ClerkKit
import Foundation

/// The local qualification composition supplies the pinned ClerkKit 1.5.5 core.
/// This file never substitutes an opaque capture grant for a Clerk JWT.
@MainActor public final class ClerkKitWorkspaceDriver: NativeAuthDriver {
    private let clerk: Clerk
    private let configuration: NativeClerkConfiguration

    public init(configuration: NativeClerkConfiguration) throws {
        guard Bundle.main.bundleIdentifier == configuration.bundleIdentifier else {
            throw NativeAuthError.unavailable
        }
        self.configuration = configuration
        clerk = Clerk.configure(publishableKey: configuration.publishableKey, options: .init(
            logLevel: .error,
            telemetryEnabled: false,
            keychainConfig: .init(service: configuration.bundleIdentifier + ".clerk"),
            redirectConfig: .init(redirectUrl: configuration.callbackURL,
                                  callbackUrlScheme: configuration.bundleIdentifier),
            watchConnectivityEnabled: false,
            sharedSessionSync: nil,
            loggerHandler: nil,
            middleware: .init(request: [NativeOriginMiddleware(configuration: configuration)])
        ))
    }

    public var loaded: Bool { clerk.isLoaded }

    public var identity: NativeAuthIdentity? {
        guard let session = clerk.session, session.status == .active,
              session.expireAt > Date(), let user = clerk.user,
              session.lastActiveOrganizationId == configuration.organizationID else { return nil }
        if let organizationID = configuration.organizationID {
            return try? NativeAuthIdentity(userID: user.id, sessionID: session.id,
                                           organizationID: organizationID)
        }
        return try? NativeAuthIdentity(coreUserID: user.id, sessionID: session.id)
    }

    public var providerDisplayName: String? {
        guard let current = identity, let user = clerk.user, user.id == current.userID else { return nil }
        return NativeProviderDisplayName.joined(firstName: user.firstName, lastName: user.lastName)
    }

    public func signIn() async throws {
        let session = try await clerk.auth.startHostedAuth(
            redirectUrl: configuration.callbackURL, prefersEphemeralWebBrowserSession: true
        )
        try Task.checkCancellation()
        if let organizationID = configuration.organizationID {
            guard clerk.user?.organizationMemberships?.contains(where: {
                $0.organization.id == organizationID
            }) == true else { throw NativeAuthError.signInFailed }
        }
        try await clerk.auth.setActive(sessionId: session.id, organizationId: configuration.organizationID)
        guard identity != nil else { throw NativeAuthError.signInFailed }
    }

    public func freshToken() async throws -> String? {
        try await clerk.auth.getToken(.init(skipCache: true))
    }

    public func signOut() async throws {
        try await clerk.auth.signOut()
    }
}

private struct NativeOriginMiddleware: ClerkRequestMiddleware {
    let configuration: NativeClerkConfiguration
    func prepare(_ request: inout URLRequest) async throws {
        try configuration.prepareFrontendRequest(&request)
    }
}
#endif
