import Foundation
import CosmasNativeAuth

// Offline only: the real retained native session owner and token policy run with
// an in-memory access block, fake SDK driver and controllable wire. No Keychain,
// SDK account, network, device, microphone or clinical operation is accessed.
@MainActor final class Block: NativeAuthAccessBlock {
    var blocked = false
    func isBlocked() -> Bool { blocked }
    func setBlocked(_ value: Bool) { blocked = value }
}
@MainActor final class Driver: NativeAuthDriver {
    var loaded = true
    var identity: NativeAuthIdentity? = try! .init(userID: "user_offline", sessionID: "sess_offline", organizationID: "org_offline")
    var tokens = 0, expired = false, holdToken = false
    var tokenWait: CheckedContinuation<String?, Never>?
    func signIn() async throws { throw NativeAuthError.signInFailed }
    func signOut() async throws { identity = nil }
    func freshToken() async throws -> String? {
        tokens += 1
        if holdToken { return await withCheckedContinuation { tokenWait = $0 } }
        return try token()
    }
    func token() throws -> String {
        let now = Int(Date().timeIntervalSince1970)
        let header: [String: Any] = ["alg": "RS256", "kid": "offline"]
        let claims: [String: Any] = ["iss": "https://identity.clerk.accounts.dev", "aud": "offline-provider",
            "sub": "user_offline", "sid": "sess_offline", "org_id": "org_offline",
            "iat": now - 10, "nbf": now - 10, "exp": now + (expired ? -10 : 120)]
        func encode(_ data: Data) -> String {
            data.base64EncodedString().replacingOccurrences(of: "=", with: "")
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        }
        return try encode(JSONSerialization.data(withJSONObject: header)) + "." +
            encode(JSONSerialization.data(withJSONObject: claims)) + "." + encode(Data("offline-signature".utf8))
    }
}
actor Wire: ProviderNativeWire {
    var count = 0
    var pause = false
    var continuation: CheckedContinuation<Void, Never>?
    var response = ProviderNativeReply(status: 200, body: Data("{}".utf8))
    func hold() { pause = true }
    func setResponse(_ value: ProviderNativeReply) { response = value }
    func resume() { continuation?.resume(); continuation = nil }
    func send(_ request: ProviderNativeRequest, token: String) async throws -> ProviderNativeReply {
        count += 1
        guard token.split(separator: ".").count == 3 else { throw CheckFailure.failed }
        if pause { await withCheckedContinuation { continuation = $0 } } // Deliberately ignores cancellation.
        return response
    }
}
enum CheckFailure: Error { case failed }
func require(_ value: Bool) throws { if !value { throw CheckFailure.failed } }

@main struct CheckNativeProvider {
    @MainActor static func make() throws -> (NativeWorkspaceAuth, Driver, Wire, NativeProviderConnection) {
        let driver = Driver(), wire = Wire()
        let policy = try NativeTokenPolicy(issuer: "https://identity.clerk.accounts.dev", audience: "offline-provider")
        let auth = NativeWorkspaceAuth(enabled: true, organizationID: "org_offline", tokenPolicy: policy,
            driver: { driver }, accessBlock: { Block() })
        let connection = NativeProviderConnection(auth: auth, wire: wire)
        auth.onChange = { [weak connection] state in connection?.authChanged(state) }
        return (auth, driver, wire, connection)
    }
    @MainActor static func request(_ auth: NativeWorkspaceAuth, id: String = UUID().uuidString.lowercased(),
                                   action: String = "catalog", body: String = "{}") throws -> ProviderNativeRequest {
        try ProviderNativeRequest(id: id, revision: auth.state().revision, action: action,
            key: "offline-provider-key", body: body)
    }
    @MainActor static func wait(_ condition: @MainActor () async -> Bool) async throws {
        for _ in 0..<1000 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(1))
        }
        throw CheckFailure.failed
    }
    static func rejected<T: Sendable>(_ operation: Task<T, Error>) async throws {
        do { _ = try await operation.value; throw CheckFailure.failed }
        catch is CheckFailure { throw CheckFailure.failed }
        catch { }
    }
    @MainActor static func main() async throws {
        var checks = 0
        do {
            let (auth, driver, wire, connection) = try make()
            for action in ["catalog", "mount", "recorder", "capture-admissions", "capture-operations", "capture-notes"] {
                _ = try await connection.send(request(auth, action: action))
            }
            let calls = await wire.count
            try require(driver.tokens == 6 && calls == 6)
            connection.close(); checks += 1
        }
        do {
            let (auth, _, wire, connection) = try make()
            let limit = ProviderNativeAction.operation.responseLimit
            var data = Data("{\"padding\":\"".utf8)
            data.append(Data(repeating: 120, count: limit - data.count - 2))
            data.append(Data("\"}".utf8))
            await wire.setResponse(ProviderNativeReply(status: 200, body: data))
            let response = try await connection.send(request(auth, action: "capture-operations"))
            try require(response.body.count == limit && limit == 32 * 1024 * 1024 + 8192)
            try await rejected(Task { try await connection.send(request(auth, action: "capture-notes")) })
            data.append(32)
            await wire.setResponse(ProviderNativeReply(status: 200, body: data))
            try await rejected(Task { try await connection.send(request(auth, action: "capture-operations")) })
            connection.close(); checks += 1
        }
        do {
            let (auth, driver, wire, connection) = try make()
            let id = UUID().uuidString.lowercased(); connection.cancel(UUID(uuidString: id)!)
            let operation = Task { try await connection.send(request(auth, id: id)) }
            try await rejected(operation)
            let calls = await wire.count
            try require(driver.tokens == 0 && calls == 0); checks += 1
        }
        do {
            let (auth, _, wire, connection) = try make()
            await wire.hold()
            let request = try request(auth)
            let operation = Task { try await connection.send(request) }
            try await wait { await wire.count == 1 }
            _ = try await auth.signOut()
            await wire.resume(); try await rejected(operation)
            try require(auth.state().phase == .signedOut); checks += 1
        }
        do {
            let (auth, driver, wire, connection) = try make()
            await wire.hold()
            let original = try request(auth)
            let operation = Task { try await connection.send(original) }
            try await wait { await wire.count == 1 }
            driver.identity = try .init(userID: "user_other", sessionID: "sess_other", organizationID: "org_offline")
            _ = auth.state()
            await wire.resume(); try await rejected(operation); checks += 1
        }
        do {
            let (auth, driver, wire, connection) = try make()
            driver.holdToken = true
            let original = try request(auth)
            let operation = Task { try await connection.send(original) }
            try await wait { driver.tokenWait != nil }
            connection.cancel(original.id)
            driver.tokenWait?.resume(returning: try driver.token()); driver.tokenWait = nil
            try await rejected(operation)
            try require(await wire.count == 0); checks += 1
        }
        do {
            let (auth, driver, wire, connection) = try make()
            driver.expired = true
            let operation = Task { try await connection.send(request(auth)) }
            try await rejected(operation)
            try require(await wire.count == 0); checks += 1
        }
        do {
            let (auth, _, wire, connection) = try make()
            await wire.setResponse(ProviderNativeReply(status: 409, body: Data("private-error-sentinel".utf8)))
            let reply = try await connection.send(request(auth))
            try require(reply.status == 409 && !String(decoding: reply.body, as: UTF8.self).contains("sentinel"))
            await wire.setResponse(ProviderNativeReply(status: 200, body: Data("[]".utf8)))
            try await rejected(Task { try await connection.send(request(auth)) }); checks += 1
        }
        do {
            let (auth, _, _, connection) = try make()
            for (action, body) in [("https://foreign.invalid", "{}"), ("catalog", "{\"extra\":1}")] {
                do { _ = try request(auth, action: action, body: body); throw CheckFailure.failed }
                catch is CheckFailure { throw CheckFailure.failed }
                catch { }
            }
            connection.close()
            try await rejected(Task { try await connection.send(request(auth)) }); checks += 1
        }
        do {
            guard CommandLine.arguments.count == 2 else { throw CheckFailure.failed }
            let ca = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])).base64EncodedString()
            let profile: [String: Any] = ["endpoint": "https://192.168.50.40:8447", "caDER": ca,
                "leafSHA256": String(repeating: "0", count: 64)]
            _ = try ProviderNativeTransport(settings: profile) // Construction only; no request.
            for endpoint in ["http://192.168.50.40:8447", "https://127.0.0.1:8447", "https://public.invalid:8447",
                             "https://192.168.50.40:8447/path", "https://user@192.168.50.40:8447"] {
                var changed = profile; changed["endpoint"] = endpoint
                do { _ = try ProviderNativeTransport(settings: changed); throw CheckFailure.failed }
                catch is CheckFailure { throw CheckFailure.failed }
                catch { }
            }
            checks += 1
        }
        print("Passed \(checks) native provider checks with unchanged native session policy, offline driver/wire and in-memory access block. No network, Keychain, app, device or microphone was accessed.")
    }
}
