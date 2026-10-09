import CryptoKit
import Foundation

public enum NativeAuthError: String, Error, Sendable {
    case unavailable = "native_auth_unavailable"
    case busy = "native_auth_busy"
    case sessionChanged = "native_auth_session_changed"
    case signInFailed = "native_auth_sign_in_failed"
    case signOutPending = "native_auth_sign_out_pending"
    case tokenUnavailable = "native_auth_token_unavailable"
    case storageUnavailable = "native_auth_storage_unavailable"
}

public struct NativeAuthIdentity: Equatable, Sendable, Codable {
    public let userID: String
    public let sessionID: String
    public let organizationID: String?

    public init(userID: String, sessionID: String, organizationID: String) throws {
        guard Self.valid(userID, prefix: "user_"), Self.valid(sessionID, prefix: "sess_"),
              Self.valid(organizationID, prefix: "org_") else { throw NativeAuthError.unavailable }
        self.userID = userID
        self.sessionID = sessionID
        self.organizationID = organizationID
    }

    public init(coreUserID: String, sessionID: String) throws {
        guard Self.valid(coreUserID, prefix: "user_"), Self.valid(sessionID, prefix: "sess_")
        else { throw NativeAuthError.unavailable }
        self.userID = coreUserID
        self.sessionID = sessionID
        self.organizationID = nil
    }

    public var bridgePayload: [String: Any] {
        if let organizationID {
            return ["userId": userID, "sessionId": sessionID, "organizationId": organizationID]
        }
        return ["userId": userID, "sessionId": sessionID,
                "identityProfile": NativeIdentityProfile.coreStagingPersonal.rawValue]
    }

    private static func valid(_ value: String, prefix: String) -> Bool {
        value.count <= 255 && value.hasPrefix(prefix) && value.count > prefix.count &&
            value.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_") }
    }
}

public struct NativeAuthState: Equatable, Sendable, Codable {
    public enum Phase: String, Sendable, Codable {
        case disabled, loading, signedOut, signingIn, ready, signOutPending, unavailable
    }
    public let phase: Phase
    public let revision: String
    public let identity: NativeAuthIdentity?
}

@MainActor public protocol NativeAuthDriver: AnyObject {
    var loaded: Bool { get }
    var identity: NativeAuthIdentity? { get }
    var providerDisplayName: String? { get }
    func signIn() async throws
    func freshToken() async throws -> String?
    func signOut() async throws
}

public extension NativeAuthDriver {
    var providerDisplayName: String? { nil }
}

/// Display suggestions only. Never included in identity, token or custody data.
public enum NativeProviderDisplayName {
    public static func valid(_ value: String?) -> String? {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              value.utf16.count <= 120,
              value.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value != 127 }) else { return nil }
        return value
    }

    public static func joined(firstName: String?, lastName: String?) -> String? {
        let parts = [firstName, lastName].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return valid(parts.joined(separator: " "))
    }
}

/// A persisted local access block, not a token store. Write before remote logout.
@MainActor public protocol NativeAuthAccessBlock: AnyObject {
    func isBlocked() throws -> Bool
    func setBlocked(_ blocked: Bool) throws
}

/// SDK credentials remain in the native driver. Tokens are never cached here.
@MainActor public final class NativeWorkspaceAuth {
    private let driver: (any NativeAuthDriver)?
    private let accessBlock: (any NativeAuthAccessBlock)?
    private let organizationID: String?
    private let tokenPolicy: NativeTokenPolicy?
    private var phase: NativeAuthState.Phase = .disabled
    private var revision = UUID().uuidString.lowercased()
    private var identity: NativeAuthIdentity?
    private var transition: UUID?
    private var pendingSignIns: Set<UUID> = []
    private var pendingSignOuts: Set<UUID> = []
    private var pendingTokens: Set<UUID> = []
    private let initializedAt = ContinuousClock.now
    // Internal overrides support deterministic fault tests; callers cannot grant
    // longer waits through native configuration or renderer options.
    var signInTimeout: Duration = .seconds(180)
    var networkTimeout: Duration = .seconds(30)
    private var storageFailed = false
    public var onChange: (@MainActor (NativeAuthState) -> Void)?

    public init(
        enabled: Bool, organizationID: String?, tokenPolicy: NativeTokenPolicy? = nil,
        driver: @MainActor () throws -> any NativeAuthDriver,
        accessBlock: @MainActor () throws -> any NativeAuthAccessBlock
    ) {
        self.organizationID = organizationID
        self.tokenPolicy = tokenPolicy
        guard enabled else { self.driver = nil; self.accessBlock = nil; return }
        guard tokenPolicy != nil else {
            self.driver = nil; self.accessBlock = nil; self.phase = .unavailable; return
        }
        guard (organizationID == nil) == (tokenPolicy?.identityProfile == .coreStagingPersonal) else {
            self.driver = nil; self.accessBlock = nil; self.phase = .unavailable; return
        }
        do {
            let block = try accessBlock()
            // Read durable state before constructing an SDK which may restore a session.
            let blocked = try block.isBlocked()
            let nativeDriver = try driver()
            self.accessBlock = block
            self.driver = nativeDriver
            self.phase = blocked ? .signOutPending : .loading
        } catch {
            self.driver = nil
            self.accessBlock = nil
            self.phase = .unavailable
        }
    }

    public func state() -> NativeAuthState {
        guard !storageFailed else { return snapshot() }
        guard transition == nil else { return snapshot() }
        guard let driver else { return snapshot() }
        do {
            if try blocked() {
                change(.signOutPending)
            } else if !driver.loaded {
                change(initializedAt.duration(to: .now) >= networkTimeout ? .unavailable : .loading)
            } else if let current = driver.identity, current.organizationID == organizationID {
                change(.ready, identity: current)
            } else {
                change(.signedOut)
            }
        } catch { change(.unavailable) }
        return snapshot()
    }

    /// Synchronous metadata from the loaded SDK, scoped to this ready revision.
    /// Missing/invalid names do not change authorization or request a token.
    public func providerDisplayName(expectedRevision: String) -> String? {
        let before = state()
        guard before.phase == .ready, before.revision == expectedRevision,
              let expected = before.identity, let driver, driver.loaded else { return nil }
        let name = NativeProviderDisplayName.valid(driver.providerDisplayName)
        let after = state()
        guard after.phase == .ready, after.revision == expectedRevision,
              after.identity == expected, driver.identity == expected else { return nil }
        return name
    }

    /// Stable device-custody namespace, never a credential or capture grant.
    /// A new SDK session for the same account must reopen its existing keys.
    /// Environment, identity profile and account changes must isolate them.
    public func recordingAccountDigest(expectedRevision: String) throws -> String {
        let current = state()
        guard current.phase == .ready, current.revision == expectedRevision,
              let identity = current.identity, let policy = tokenPolicy else {
            throw NativeAuthError.sessionChanged
        }
        let data = try JSONSerialization.data(withJSONObject: [
            "purpose": "scribe-native-recording-account-v1",
            "issuer": policy.issuer,
            "audience": policy.audience as Any? ?? NSNull(),
            "profile": policy.identityProfile.rawValue,
            "authorizedParty": policy.authorizedParty,
            "user": identity.userID,
            "organization": identity.organizationID as Any? ?? NSNull(),
        ], options: [.sortedKeys, .withoutEscapingSlashes])
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    public func signIn() async throws -> NativeAuthState {
        guard transition == nil, pendingSignIns.isEmpty, pendingSignOuts.isEmpty else { throw NativeAuthError.busy }
        guard !storageFailed, let driver else { throw NativeAuthError.unavailable }
        let operation = UUID()
        transition = operation
        pendingSignIns.insert(operation)
        change(.signingIn)
        defer { if transition == operation { transition = nil } }
        var launched = false
        do {
            let previouslyBlocked = try blocked()
            // A crash or cancellation during hosted auth must not activate an
            // SDK session later without an explicit successful completion here.
            try block(true)
            launched = true
            try await NativeAuthAwait<Void>().run(timeout: signInTimeout,
                onAbandon: { self.abandonMutation(operation) }) {
                // Keep the guard until the actual SDK call ends, even if its
                // caller has already timed out. Late sign-in cannot undo logout.
                defer { self.pendingSignIns.remove(operation) }
                try Task.checkCancellation()
                if previouslyBlocked { try await driver.signOut() }
                try Task.checkCancellation()
                guard self.transition == operation else { throw NativeAuthError.sessionChanged }
                try await driver.signIn()
            }
            // Only this caller can open access; an abandoned SDK task cannot.
            try Task.checkCancellation()
            guard transition == operation, let current = driver.identity,
                  current.organizationID == organizationID else { throw NativeAuthError.sessionChanged }
            try block(false)
            change(.ready, identity: current)
            return snapshot()
        } catch {
            if !launched { pendingSignIns.remove(operation) }
            abandonMutation(operation)
            throw NativeAuthError.signInFailed
        }
    }

    public func token(expectedRevision: String, nativeSessionWithoutOrigin: Bool = false) async throws -> String {
        let before = state()
        guard before.phase == .ready, before.revision == expectedRevision,
              let expected = before.identity, let driver, let tokenPolicy else {
            throw NativeAuthError.sessionChanged
        }
        // Bound abandoned token tasks if an SDK transport never settles.
        guard pendingTokens.count < 8 else { throw NativeAuthError.tokenUnavailable }
        let operation = UUID()
        pendingTokens.insert(operation)
        do {
            let token = try await NativeAuthAwait<String?>().run(timeout: networkTimeout,
                onAbandon: { if self.revision == expectedRevision { self.change(.unavailable) } }) {
                defer { self.pendingTokens.remove(operation) }
                try Task.checkCancellation()
                return try await driver.freshToken()
            }
            try Task.checkCancellation()
            guard transition == nil, revision == expectedRevision,
                  driver.identity == expected, !(try blocked()) else {
                throw NativeAuthError.sessionChanged
            }
            guard let token else { throw NativeAuthError.tokenUnavailable }
            try tokenPolicy.validate(token, identity: expected, nativeSessionWithoutOrigin: nativeSessionWithoutOrigin)
            return token
        } catch {
            if revision == expectedRevision { change(.unavailable) }
            throw NativeAuthError.tokenUnavailable
        }
    }

    public func signOut() async throws -> NativeAuthState {
        guard !storageFailed, let driver else { throw NativeAuthError.unavailable }
        guard pendingSignOuts.isEmpty, transition == nil || phase == .signingIn else { throw NativeAuthError.busy }
        // Immediately fence a concurrent hosted flow or token, before any await.
        let operation = UUID()
        transition = operation
        pendingSignOuts.insert(operation)
        change(.signOutPending)
        defer { if transition == operation { transition = nil } }
        var launched = false
        do {
            try block(true)
            launched = true
            try await NativeAuthAwait<Void>().run(timeout: networkTimeout,
                onAbandon: { self.abandonMutation(operation) }) {
                defer { self.pendingSignOuts.remove(operation) }
                try Task.checkCancellation()
                try await driver.signOut()
            }
            try Task.checkCancellation()
            guard transition == operation, driver.identity == nil, pendingSignIns.isEmpty else {
                throw NativeAuthError.signOutPending
            }
            try block(false)
            change(.signedOut)
            return snapshot()
        } catch {
            // Keep the durable block and a safe UI even if logout's response is lost.
            if !launched { pendingSignOuts.remove(operation) }
            abandonMutation(operation)
            throw NativeAuthError.signOutPending
        }
    }

    private func abandonMutation(_ operation: UUID) {
        guard transition == operation else { return }
        transition = nil
        if !storageFailed { change(.signOutPending) }
    }

    private func snapshot() -> NativeAuthState {
        NativeAuthState(phase: phase, revision: revision, identity: identity)
    }

    private func blocked() throws -> Bool {
        guard let accessBlock, !storageFailed else { throw NativeAuthError.storageUnavailable }
        do { return try accessBlock.isBlocked() }
        catch {
            storageFailed = true
            change(.unavailable)
            throw NativeAuthError.storageUnavailable
        }
    }

    private func block(_ blocked: Bool) throws {
        guard let accessBlock, !storageFailed else { throw NativeAuthError.storageUnavailable }
        do { try accessBlock.setBlocked(blocked) }
        catch {
            storageFailed = true
            change(.unavailable)
            throw NativeAuthError.storageUnavailable
        }
    }

    private func change(_ next: NativeAuthState.Phase, identity nextIdentity: NativeAuthIdentity? = nil) {
        guard phase != next || identity != nextIdentity else { return }
        phase = next
        identity = nextIdentity
        revision = UUID().uuidString.lowercased()
        onChange?(snapshot())
    }
}
