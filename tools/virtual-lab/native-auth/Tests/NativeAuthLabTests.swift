import Foundation
import Security
import XCTest
@testable import ClerkKit

// Actual XCTest-only SDK configuration; this never uses the system Keychain.
final class MemoryKeychain: KeychainStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    func set(_ data: Data, forKey key: String) { lock.withLock { values[key] = data } }
    func data(forKey key: String) -> Data? { lock.withLock { values[key] } }
    func deleteItem(forKey key: String) { _ = lock.withLock { values.removeValue(forKey: key) } }
    func hasItem(forKey key: String) -> Bool { lock.withLock { values[key] != nil } }
}

enum SafeFailure: Error { case configuration, signIn, token, identity, cleanup }

final class NetworkGate: ClerkRequestMiddleware, @unchecked Sendable {
    private let lock = NSLock()
    private var fault: URLError.Code?
    private var tokenRequests = 0
    private var ticketRequests = 0
    init(_ fault: URLError.Code? = nil) { self.fault = fault }
    func block(_ code: URLError.Code?) { lock.withLock { fault = code } }
    var tokens: Int { lock.withLock { tokenRequests } }
    var tickets: Int { lock.withLock { ticketRequests } }
    func prepare(_ request: inout URLRequest) async throws {
        // Store counters only: no URL/query/body/header/token retention.
        let path = request.url?.path ?? ""
        let code = lock.withLock {
            if path.contains("/tokens") { tokenRequests += 1 }
            if path == "/v1/client/sign_ins" { ticketRequests += 1 }
            return fault
        }
        if let code { throw URLError(code) }
    }
}

@MainActor
final class NativeAuthLabTests: XCTestCase {
    static let issuer = "https://resolved-emu-53.clerk.accounts.dev"
    let offlineKey = "pk_test_" + Data("virtual-lab.clerk.accounts.dev$".utf8).base64EncodedString()

    private func generatedPassword() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 40)
        let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!) }
        guard status == errSecSuccess else { throw SafeFailure.configuration }
        return "V-lab!9" + Data(bytes).base64EncodedString()
    }

    func configure(key: String, gate: NetworkGate, storage: MemoryKeychain = .init()) throws -> Clerk {
        try Clerk.configureForTesting(publishableKey: key,
            options: .init(logLevel: .error, telemetryEnabled: false,
                keychainConfig: .init(service: "scribe.virtual-lab.tests"),
                watchConnectivityEnabled: false, sharedSessionSync: nil,
                middleware: .init(request: [gate])), keychainStorage: storage)
    }

    func testPersistenceAndIdentityIsolation() throws {
        let first = try configure(key: offlineKey, gate: NetworkGate(.notConnectedToInternet))
        try first.dependencies.keychain.set(Data([1]), forKey: "synthetic-marker")
        XCTAssertTrue(try first.dependencies.appLocalKeychain.hasItem(forKey: "synthetic-marker"))
        let second = try configure(key: offlineKey, gate: NetworkGate(.notConnectedToInternet))
        XCTAssertFalse(first === second)
        XCTAssertFalse(try second.dependencies.keychain.hasItem(forKey: "synthetic-marker"))
        XCTAssertNil(second.session)
    }

    func testTicketUsesRealSDKPipelineAndFailsClosedOffline() async throws {
        let gate = NetworkGate(.notConnectedToInternet)
        let clerk = try configure(key: offlineKey, gate: gate)
        do { _ = try await clerk.auth.signInWithTicket("synthetic-invalid-ticket"); XCTFail("Expected blocked request") }
        catch { /* Deliberately do not interpolate SDK/network errors. */ }
        XCTAssertGreaterThan(gate.tickets, 0)
        XCTAssertNil(clerk.session)
        for _ in 0..<3 {
            let token = try await clerk.auth.getToken(.init(skipCache: true))
            XCTAssertTrue(token == nil)
        }
    }

    func testForcedTokenFailuresDoNotYieldTokenAndReconfigurationDropsSession() async throws {
        let gate = NetworkGate(.timedOut)
        let clerk = try configure(key: offlineKey, gate: gate)
        // Synthetic source state, not a real login. Exercise the actual forced-token path.
        let now = Date()
        let session = Session(id: "sess_synthetic_A", status: .active,
            expireAt: now.addingTimeInterval(3600), abandonAt: now.addingTimeInterval(3600),
            lastActiveAt: now, createdAt: now, updatedAt: now)
        clerk.client = Client(id: "client_synthetic_A", sessions: [session],
            lastActiveSessionId: session.id, updatedAt: now)
        for fault in [URLError.Code.timedOut, .notConnectedToInternet, .cancelled] {
            gate.block(fault)
            do { _ = try await clerk.auth.getToken(.init(skipCache: true)); XCTFail("Expected forced-token failure") }
            catch { }
        }
        XCTAssertGreaterThanOrEqual(gate.tokens, 3)
        let fresh = try configure(key: offlineKey, gate: NetworkGate(.notConnectedToInternet))
        XCTAssertNil(fresh.session)
        let token = try await fresh.auth.getToken(.init(skipCache: true))
        XCTAssertTrue(token == nil)
    }

    func testPersistentSharedSessionModeRejectedWithInjectedStorage() {
        do {
            _ = try Clerk.configureForTesting(publishableKey: offlineKey,
                options: .init(telemetryEnabled: false, sharedSessionSync: .enabled),
                keychainStorage: MemoryKeychain())
            XCTFail("Persistent sharing must reject test storage")
        } catch { }
    }

    func testLiveEmailCodeTwoSyntheticIdentitiesAndRecovery() async throws {
        try await live(strategy: "email")
    }

    func testLiveTicketTwoSyntheticIdentitiesAndRecovery() async throws {
        try await live(strategy: "ticket")
    }

    func testLivePublicStagingEnvironment() async throws {
        guard ProcessInfo.processInfo.environment["SCRIBE_LAB_AUTH_STRATEGY"] == "public" else {
            throw XCTSkip("Public network lane not selected")
        }
        let key = "pk_test_" + Data("resolved-emu-53.clerk.accounts.dev$".utf8).base64EncodedString()
        let clerk = try configure(key: key, gate: NetworkGate())
        do {
            _ = try await clerk.refreshEnvironment()
            XCTAssertNotNil(clerk.environment)
            XCTAssertNil(clerk.session)
        } catch { throw SafeFailure.configuration }
    }

    private func live(strategy: String) async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["SCRIBE_LAB_LIVE"] == "1", env["SCRIBE_LAB_AUTH_STRATEGY"] == strategy else {
            throw XCTSkip("Live lane not selected; no account or network proof claimed")
        }
        let bootstrap = strategy == "email" && env["SCRIBE_LAB_BOOTSTRAP"] == "1"
        let bootstrapDomain = env["SCRIBE_LAB_BOOTSTRAP_DOMAIN"] ?? "example.com"
        guard ["example.com", "cosmaneura.com"].contains(bootstrapDomain) else { throw SafeFailure.configuration }
        let key = env["SCRIBE_LAB_CLERK_PUBLISHABLE_KEY"] ??
            ("pk_test_" + Data("resolved-emu-53.clerk.accounts.dev$".utf8).base64EncodedString())
        let userA = env["SCRIBE_LAB_USER_A_ID"], userB = env["SCRIBE_LAB_USER_B_ID"]
        guard env["SCRIBE_LAB_SYNTHETIC_ONLY"] == "1", key.hasPrefix("pk_test_"),
              let data = Data(base64Encoded: String(key.dropFirst(8))),
              String(data: data, encoding: .utf8) == "resolved-emu-53.clerk.accounts.dev$",
              bootstrap || (userA != nil && userB != nil && userA != userB) else { throw SafeFailure.configuration }
        var accountMetadata: [[String: String]] = []
        for (label, expectedUser) in [("A", userA), ("B", userB)] {
            let gate = NetworkGate()
            let clerk = try configure(key: key, gate: gate)
            var ownedSession: String?
            var phase = "sign_in"
            var missingFields = ""
            func record(_ extra: [String: String] = [:]) throws {
                if let path = env["SCRIBE_LAB_PHASE_RECEIPT"] {
                    let values = ["label": label, "phase": phase, "missing_fields": missingFields].merging(extra) { _, new in new }
                    try JSONSerialization.data(withJSONObject: values).write(to: URL(fileURLWithPath: path))
                }
            }
            do {
                var attempt: SignIn
                if strategy == "ticket" {
                    guard let ticket = env["SCRIBE_LAB_TICKET_\(label)"], !ticket.isEmpty else { throw SafeFailure.configuration }
                    attempt = try await clerk.auth.signInWithTicket(ticket)
                } else {
                    let email = bootstrap ? "scribe-lab-\(label.lowercased())+clerk_test@\(bootstrapDomain)" : env["SCRIBE_LAB_EMAIL_\(label)"]
                    guard let email,
                          email.split(separator: "@").count == 2,
                          email.split(separator: "@")[0].hasSuffix("+clerk_test") else { throw SafeFailure.configuration }
                    if bootstrap {
                        do {
                            phase = "bootstrap_create"; try record()
                            // Only the two approved synthetic users; password never retained.
                            var signUp = try await clerk.auth.signUp(emailAddress: email, password: generatedPassword())
                            if signUp.missingFields.contains(.password) {
                                signUp = try await signUp.update(password: generatedPassword())
                            }
                            phase = "bootstrap_prepare"; try record()
                            signUp = try await signUp.sendEmailCode()
                            phase = "bootstrap_verify"; try record()
                            signUp = try await signUp.verifyEmailCode("424242")
                            ownedSession = signUp.createdSessionId
                            let safeFields: Set<String> = ["email_address", "password", "first_name", "last_name", "username", "phone_number", "legal_accepted"]
                            missingFields = signUp.missingFields.map(\.rawValue).filter { safeFields.contains($0) }.joined(separator: ",")
                            try record()
                            guard let sid = ownedSession, signUp.createdUserId != nil else { throw SafeFailure.signIn }
                            phase = "bootstrap_sign_out"; try record()
                            try await clerk.auth.signOut(sessionId: sid)
                            ownedSession = nil
                        } catch let error as ClerkAPIError where error.code == "form_identifier_exists" {
                            // Reuse only the same explicitly named synthetic test account.
                        }
                    }
                    phase = "email_sign_in"; try record()
                    attempt = try await clerk.auth.signInWithEmailCode(emailAddress: email)
                    phase = "email_verify"; try record()
                    attempt = try await attempt.verifyCode("424242")
                }
                ownedSession = attempt.createdSessionId
                guard attempt.status == .complete, let sid = ownedSession else { throw SafeFailure.signIn }
                phase = "activate"; try record()
                try await clerk.auth.setActive(sessionId: sid, organizationId: nil)
                guard let user = clerk.user?.id, (expectedUser == nil || user == expectedUser),
                      clerk.session?.id == sid, !accountMetadata.contains(where: { $0["user_id"] == user }) else { throw SafeFailure.identity }
                accountMetadata.append(["label": label, "user_id": user])
                if let path = env["SCRIBE_LAB_ACCOUNT_RECEIPT"] {
                    try JSONSerialization.data(withJSONObject: accountMetadata).write(to: URL(fileURLWithPath: path))
                }
                phase = "fresh_token"; try record()
                try await checkFreshToken(clerk, gate: gate, user: user, session: sid)
                gate.block(.notConnectedToInternet)
                phase = "offline_failure"; try record()
                for _ in 0..<2 {
                    do { _ = try await clerk.auth.getToken(.init(skipCache: true)); throw SafeFailure.token }
                    catch is SafeFailure { throw SafeFailure.token }
                    catch { }
                }
                gate.block(nil)
                phase = "recovery_token"; try record()
                try await checkFreshToken(clerk, gate: gate, user: user, session: sid)
                phase = "sign_out"; try record()
                try await clerk.auth.signOut(sessionId: sid)
                ownedSession = nil
                guard try await clerk.auth.getToken(.init(skipCache: true)) == nil else { throw SafeFailure.cleanup }
                phase = "complete"; try record(["status": "passed"])
            } catch {
                let code = (error as? ClerkAPIError)?.code ?? "non_api_failure"
                let safeCode = code.count <= 64 && code.range(of: "^[a-z][a-z0-9_]+$", options: .regularExpression) != nil
                let kind = error is ClerkAPIError ? "api" : error is ClerkClientError ? "client" : error is SafeFailure ? "lab" : error is URLError ? "network" : "other"
                try? record(["status": "failed", "error_code": safeCode ? code : "other_failure", "error_kind": kind])
                gate.block(nil)
                if let sid = ownedSession {
                    do { try await clerk.auth.signOut(sessionId: sid) }
                    catch { throw SafeFailure.cleanup }
                }
                // Never retain raw Clerk errors (which may contain email/account context).
                throw (error as? SafeFailure) ?? SafeFailure.signIn
            }
        }
    }

    private func checkFreshToken(_ clerk: Clerk, gate: NetworkGate, user: String, session: String) async throws {
        let before = gate.tokens
        guard let jwt = try await clerk.auth.getToken(.init(skipCache: true)) else { throw SafeFailure.token }
        let parts = jwt.split(separator: ".")
        func decode(_ part: Substring) throws -> [String: Any] {
            var base = String(part).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            base += String(repeating: "=", count: (4 - base.count % 4) % 4)
            guard let data = Data(base64Encoded: base),
                  let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw SafeFailure.token }
            return value
        }
        guard parts.count == 3 else { throw SafeFailure.token }
        let header = try decode(parts[0]), claims = try decode(parts[1])
        guard gate.tokens > before, header["alg"] as? String == "RS256",
              claims["iss"] as? String == Self.issuer, claims["sub"] as? String == user,
              claims["sid"] as? String == session, claims["org_id"] == nil, claims["o"] == nil,
              let exp = claims["exp"] as? Double, exp > Date().timeIntervalSince1970 else { throw SafeFailure.token }
        // Claims binding only; Core must independently verify signature and practice grants.
    }
}
