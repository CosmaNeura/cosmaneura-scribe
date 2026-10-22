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

    @Test func failedNativeTokenCannotBecomeReadyFromMetadataPolling() async throws {
        let driver = NativeFixtureDriver(identity: identity, token: try token())
        driver.tokenOperation = { throw NativeAuthError.tokenUnavailable }
        let auth = coordinator(driver)
        var phases: [NativeAuthState.Phase] = []
        auth.onChange = { phases.append($0.phase) }
        let ready = auth.state()
        await #expect(throws: NativeAuthError.tokenUnavailable) {
            try await auth.token(expectedRevision: ready.revision, nativeSessionWithoutOrigin: true)
        }
        #expect(phases == [.ready, .unavailable])
        let failed = auth.state()
        #expect(failed.phase == .unavailable)
        for _ in 0..<5 {
            #expect(auth.state() == failed)
        }
        #expect(phases == [.ready, .unavailable])
        #expect(driver.tokenRequests == 1)
        await #expect(throws: NativeAuthError.sessionChanged) {
            try await auth.token(expectedRevision: failed.revision, nativeSessionWithoutOrigin: true)
        }
        #expect(driver.tokenRequests == 1)
    }

    @Test func failedSpeculativeTokenDoesNotFenceReadySession() async throws {
        let driver = NativeFixtureDriver(identity: identity, token: try token())
        driver.tokenOperation = { throw NativeAuthError.tokenUnavailable }
        let auth = coordinator(driver)
        let ready = auth.state()
        await #expect(throws: NativeAuthError.tokenUnavailable) {
            try await auth.prepareToken(expectedRevision: ready.revision)
        }
        #expect(auth.state() == ready)
        driver.tokenOperation = nil
        #expect(try await auth.token(expectedRevision: ready.revision,
                                    nativeSessionWithoutOrigin: true) == driver.value)
    }

    @Test func rejectedTokenPolicyAlsoFencesMetadataReadiness() async throws {
        let driver = NativeFixtureDriver(identity: identity, token: try token(["aud": "wrong-api"]))
        let auth = coordinator(driver)
        let ready = auth.state()
        await #expect(throws: NativeAuthError.tokenUnavailable) {
            try await auth.token(expectedRevision: ready.revision, nativeSessionWithoutOrigin: true)
        }
        #expect(auth.state().phase == .unavailable)
        #expect(driver.tokenRequests == 1)
    }

    @Test func tokenFailureFencePrecedesReentrantMetadataObserver() async throws {
        let driver = NativeFixtureDriver(identity: identity, token: try token())
        driver.tokenOperation = { throw NativeAuthError.tokenUnavailable }
        let auth = coordinator(driver)
        var failuresObserved = 0
        auth.onChange = { failed in
            if failed.phase == .unavailable {
                failuresObserved += 1
                #expect(auth.state() == failed)
            }
        }
        let ready = auth.state()
        await #expect(throws: NativeAuthError.tokenUnavailable) {
            try await auth.token(expectedRevision: ready.revision, nativeSessionWithoutOrigin: true)
        }
        #expect(failuresObserved == 1)
        #expect(auth.state().phase == .unavailable)
    }

    @Test func failedLogoutCannotClearFailedTokenFence() async throws {
        let driver = NativeFixtureDriver(identity: identity, token: try token())
        driver.tokenOperation = { throw NativeAuthError.tokenUnavailable }
        let auth = coordinator(driver)
        let ready = auth.state()
        await #expect(throws: NativeAuthError.tokenUnavailable) {
            try await auth.token(expectedRevision: ready.revision, nativeSessionWithoutOrigin: true)
        }
        driver.signOutOperation = { throw NativeAuthError.unavailable }
        await #expect(throws: NativeAuthError.signOutPending) { try await auth.signOut() }
        #expect(driver.identity == identity)
        for _ in 0..<5 { #expect(auth.state().phase == .signOutPending) }
        driver.signOutOperation = nil
        #expect(try await auth.signOut().phase == .signedOut)
    }

    @Test func signInCannotReopenTheSameFailedSessionBeforeLogoutCompletes() async throws {
        let driver = NativeFixtureDriver(identity: identity, token: try token())
        driver.tokenOperation = { throw NativeAuthError.tokenUnavailable }
        let auth = coordinator(driver)
        let ready = auth.state()
        await #expect(throws: NativeAuthError.tokenUnavailable) {
            try await auth.token(expectedRevision: ready.revision, nativeSessionWithoutOrigin: true)
        }
        driver.signInIdentity = identity
        await #expect(throws: NativeAuthError.signInFailed) { try await auth.signIn() }
        #expect(auth.state().phase == .signOutPending)
        #expect(driver.tokenRequests == 1)
        #expect(try await auth.signOut().phase == .signedOut)
    }

    @Test func completedLogoutAndSignInRecoverFailedSessionWithoutDiscardingPolicy() async throws {
        let driver = NativeFixtureDriver(identity: identity, token: try token())
        driver.tokenOperation = { throw NativeAuthError.tokenUnavailable }
        let auth = coordinator(driver)
        let ready = auth.state()
        await #expect(throws: NativeAuthError.tokenUnavailable) {
            try await auth.token(expectedRevision: ready.revision, nativeSessionWithoutOrigin: true)
        }
        #expect(auth.state().phase == .unavailable)
        #expect(try await auth.signOut().phase == .signedOut)
        let renewed = try NativeAuthIdentity(userID: identity.userID, sessionID: "sess_renewed",
                                             organizationID: "org_fixture")
        driver.signInIdentity = renewed
        driver.value = try token(["sid": renewed.sessionID])
        driver.tokenOperation = nil
        let signedIn = try await auth.signIn()
        #expect(signedIn.phase == .ready)
        #expect(signedIn.identity == renewed)
        #expect(try await auth.token(expectedRevision: signedIn.revision,
                                    nativeSessionWithoutOrigin: true) == driver.value)
        await #expect(throws: NativeAuthError.sessionChanged) {
            try await auth.token(expectedRevision: ready.revision, nativeSessionWithoutOrigin: true)
        }
    }

    @Test func shippedPersonalProfileKeepsTokenFailureFencedUntilFreshSignIn() async throws {
        let personalPolicy = try NativeTokenPolicy(issuer: "https://resolved-emu-53.clerk.accounts.dev",
            audience: nil, identityProfile: .coreStagingPersonal)
        let personal = try NativeAuthIdentity(coreUserID: "user_personal", sessionID: "sess_personal")
        func personalToken(for expected: NativeAuthIdentity) throws -> String {
            try token(["iss": personalPolicy.issuer, "sub": expected.userID, "sid": expected.sessionID],
                      omit: ["aud", "org_id"])
        }
        let initialToken = try personalToken(for: personal)
        try personalPolicy.validate(initialToken, identity: personal, nativeSessionWithoutOrigin: true)
        #expect(throws: NativeAuthError.tokenUnavailable) {
            try personalPolicy.validate(initialToken, identity: personal)
        }
        let driver = NativeFixtureDriver(identity: personal, token: initialToken)
        driver.tokenOperation = { throw NativeAuthError.tokenUnavailable }
        let auth = NativeWorkspaceAuth(enabled: true, organizationID: nil, tokenPolicy: personalPolicy,
                                       driver: { driver }, accessBlock: { NativeFixtureBlock() })
        let ready = auth.state()
        #expect(ready.identity?.organizationID == nil)
        await #expect(throws: NativeAuthError.tokenUnavailable) {
            try await auth.token(expectedRevision: ready.revision, nativeSessionWithoutOrigin: true)
        }
        let failed = auth.state()
        #expect(failed.phase == .unavailable)
        for _ in 0..<5 { #expect(auth.state() == failed) }
        #expect(driver.tokenRequests == 1)
        #expect(try await auth.signOut().phase == .signedOut)
        let renewed = try NativeAuthIdentity(coreUserID: personal.userID, sessionID: "sess_personal_renewed")
        driver.signInIdentity = renewed
        driver.value = try personalToken(for: renewed)
        driver.tokenOperation = nil
        let signedIn = try await auth.signIn()
        #expect(signedIn.phase == .ready)
        #expect(signedIn.identity == renewed)
        #expect(try await auth.token(expectedRevision: signedIn.revision,
                                    nativeSessionWithoutOrigin: true) == driver.value)
        #expect(driver.tokenRequests == 2)
        #expect(throws: NativeAuthError.tokenUnavailable) {
            try personalPolicy.validate(initialToken, identity: renewed, nativeSessionWithoutOrigin: true)
        }
    }

    @Test func genuinelyChangedSDKSessionCanRecoverFailedIdentity() async throws {
        let driver = NativeFixtureDriver(identity: identity, token: try token())
        driver.tokenOperation = { throw NativeAuthError.tokenUnavailable }
        let auth = coordinator(driver)
        let ready = auth.state()
        await #expect(throws: NativeAuthError.tokenUnavailable) {
            try await auth.token(expectedRevision: ready.revision, nativeSessionWithoutOrigin: true)
        }
        #expect(auth.state().phase == .unavailable)
        let renewed = try NativeAuthIdentity(userID: identity.userID, sessionID: "sess_renewed",
                                             organizationID: "org_fixture")
        driver.identity = renewed
        driver.value = try token(["sid": renewed.sessionID])
        driver.tokenOperation = nil
        let recovered = auth.state()
        #expect(recovered.phase == .ready)
        #expect(recovered.identity == renewed)
        #expect(recovered.revision != ready.revision)
        #expect(try await auth.token(expectedRevision: recovered.revision,
                                    nativeSessionWithoutOrigin: true) == driver.value)
    }

    @Test func lateFailedTokenCannotReviveOrFenceAReauthenticatedSession() async throws {
        let driver = NativeFixtureDriver(identity: identity, token: try token())
        var completion: CheckedContinuation<String?, Never>?
        driver.tokenOperation = {
            await withCheckedContinuation { completion = $0 }
        }
        let auth = coordinator(driver)
        auth.networkTimeout = .milliseconds(30)
        let ready = auth.state()
        let pending = Task {
            await #expect(throws: NativeAuthError.tokenUnavailable) {
                try await auth.token(expectedRevision: ready.revision, nativeSessionWithoutOrigin: true)
            }
        }
        _ = await pending.value
        #expect(completion != nil)
        #expect(auth.state().phase == .unavailable)
        #expect(try await auth.signOut().phase == .signedOut)
        let renewed = try NativeAuthIdentity(userID: identity.userID, sessionID: "sess_renewed",
                                             organizationID: "org_fixture")
        driver.signInIdentity = renewed
        driver.value = try token(["sid": renewed.sessionID])
        driver.tokenOperation = nil
        let signedIn = try await auth.signIn()
        #expect(try await auth.token(expectedRevision: signedIn.revision,
                                    nativeSessionWithoutOrigin: true) == driver.value)
        completion?.resume(returning: try token())
        for _ in 0..<5 { await Task.yield() }
        #expect(auth.state() == signedIn)
    }

    @Test func callerCancellationDiscardsLateTokenWithoutClosingReadySession() async throws {
        for speculative in [false, true] {
            let driver = NativeFixtureDriver(identity: identity, token: try token())
            var completion: CheckedContinuation<String?, Never>?
            driver.tokenOperation = {
                await withCheckedContinuation { completion = $0 }
            }
            let auth = coordinator(driver)
            let ready = auth.state()
            let pending = Task {
                await #expect(throws: NativeAuthError.tokenUnavailable) {
                    if speculative { return try await auth.prepareToken(expectedRevision: ready.revision) }
                    return try await auth.token(expectedRevision: ready.revision, nativeSessionWithoutOrigin: true)
                }
            }
            while completion == nil { await Task.yield() }
            pending.cancel()
            _ = await pending.value
            #expect(auth.state() == ready)
            driver.tokenOperation = nil
            #expect(try await auth.token(expectedRevision: ready.revision,
                                        nativeSessionWithoutOrigin: true) == driver.value)
            completion?.resume(returning: try token(["aud": "late-wrong-api"]))
            for _ in 0..<5 { await Task.yield() }
            #expect(auth.state() == ready)
            #expect(driver.tokenRequests == 2)
        }
    }

    @Test func cancelledSignInCannotActivateLateSDKIdentity() async throws {
        let driver = NativeFixtureDriver(identity: identity, token: try token())
        driver.identity = nil
        driver.signInIdentity = identity
        var completion: CheckedContinuation<Void, Never>?
        driver.signInOperation = {
            await withCheckedContinuation { completion = $0 }
        }
        let auth = coordinator(driver)
        #expect(auth.state().phase == .signedOut)
        let pending = Task {
            await #expect(throws: NativeAuthError.signInFailed) { try await auth.signIn() }
        }
        while completion == nil { await Task.yield() }
        pending.cancel()
        _ = await pending.value
        #expect(auth.state().phase == .signOutPending)
        completion?.resume()
        for _ in 0..<5 { await Task.yield() }
        #expect(driver.identity == identity)
        #expect(auth.state().phase == .signOutPending)
        #expect(driver.tokenRequests == 0)
        #expect(try await auth.signOut().phase == .signedOut)
    }

    @Test func cancelledSignOutKeepsAccessBlockedEvenAfterLateSDKCompletion() async throws {
        let driver = NativeFixtureDriver(identity: identity, token: try token())
        var completion: CheckedContinuation<Void, Never>?
        driver.signOutOperation = {
            await withCheckedContinuation { completion = $0 }
        }
        let auth = coordinator(driver)
        let ready = auth.state()
        let pending = Task {
            await #expect(throws: NativeAuthError.signOutPending) { try await auth.signOut() }
        }
        while completion == nil { await Task.yield() }
        pending.cancel()
        _ = await pending.value
        #expect(auth.state().phase == .signOutPending)
        completion?.resume()
        for _ in 0..<5 { await Task.yield() }
        #expect(driver.identity == nil)
        #expect(auth.state().phase == .signOutPending)
        await #expect(throws: NativeAuthError.sessionChanged) {
            try await auth.token(expectedRevision: ready.revision, nativeSessionWithoutOrigin: true)
        }
        #expect(driver.tokenRequests == 0)
        driver.signOutOperation = nil
        #expect(try await auth.signOut().phase == .signedOut)
    }

    private func coordinator(_ driver: NativeFixtureDriver) -> NativeWorkspaceAuth {
        NativeWorkspaceAuth(enabled: true, organizationID: identity.organizationID, tokenPolicy: policy,
                            driver: { driver }, accessBlock: { NativeFixtureBlock() })
    }
}

@MainActor private final class NativeFixtureDriver: NativeAuthDriver {
    let loaded = true
    var identity: NativeAuthIdentity?
    var value: String
    var beforeReturn: (() -> Void)?
    var tokenOperation: (@MainActor () async throws -> String?)?
    var tokenRequests = 0
    var signInIdentity: NativeAuthIdentity?
    var signInOperation: (@MainActor () async throws -> Void)?
    var signOutOperation: (@MainActor () async throws -> Void)?
    init(identity: NativeAuthIdentity, token: String) { self.identity = identity; value = token }
    func freshToken() async throws -> String? {
        tokenRequests += 1
        beforeReturn?()
        if let tokenOperation { return try await tokenOperation() }
        return value
    }
    func signIn() async throws {
        guard let signInIdentity else { throw NativeAuthError.unavailable }
        try await signInOperation?()
        identity = signInIdentity
    }
    func signOut() async throws {
        try await signOutOperation?()
        identity = nil
    }
}
@MainActor private final class NativeFixtureBlock: NativeAuthAccessBlock {
    private var blocked = false
    func isBlocked() throws -> Bool { blocked }
    func setBlocked(_ blocked: Bool) throws { self.blocked = blocked }
}
