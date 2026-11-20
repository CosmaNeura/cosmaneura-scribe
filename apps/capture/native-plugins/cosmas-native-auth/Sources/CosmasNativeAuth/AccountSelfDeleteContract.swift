import Foundation

public enum AccountSelfDeleteContract {
    public enum Outcome: Equatable, Sendable {
        case deleted(status: String, practiceLeftOwnerless: Bool, clerkIdentityRemoved: Bool)
        case unauthorized, gone, unavailable, retryable, recordingActive, rejected
    }
    public static func allowsCoreOrigin(_ origin: String) -> Bool {
        origin == "https://staging-app.cosmaneura.com" || origin == "https://app.cosmaneura.com"
            || isExactLocalhostHTTP(origin)
    }

    public static func accountDeleteURL(origin: String) -> URL? {
        allowsCoreOrigin(origin) ? URL(string: origin + "/v1/me/account") : nil
    }

    public static func makeAuthorizedAccountDeleteRequest(origin: String, bearerToken: String) -> URLRequest? {
        guard let url = accountDeleteURL(origin: origin) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer " + bearerToken, forHTTPHeaderField: "Authorization")
        request.httpBody = Data(#"{"confirm":"DELETE"}"#.utf8)
        request.timeoutInterval = 30
        return request
    }

    public static func coreOrigin(forFrontendOrigin frontend: String) -> String? {
        switch frontend {
        case "https://resolved-emu-53.clerk.accounts.dev": return "https://staging-app.cosmaneura.com"
        case "https://clerk.cosmaneura.com": return "https://app.cosmaneura.com"
        default: return nil
        }
    }

    public static func interpret(statusCode: Int, body: Data?) -> Outcome {
        switch statusCode {
        case 401: return .unauthorized
        case 410: return .gone
        case 404: return .unavailable
        case 503: return .retryable
        case 200:
            guard let body,
                  let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let status = object["status"] as? String,
                  status == "deleted" || status == "already_deleted",
                  let practiceLeftOwnerless = object["practice_left_ownerless"] as? Bool,
                  let clerkIdentityRemoved = object["clerk_identity_removed"] as? Bool
            else { return .rejected }
            // H11: require the three fields; ignore extras.
            return .deleted(status: status, practiceLeftOwnerless: practiceLeftOwnerless,
                            clerkIdentityRemoved: clerkIdentityRemoved)
        default: return .rejected
        }
    }

    public static func bridgePayload(for outcome: Outcome) -> [String: Any]? {
        switch outcome {
        case let .deleted(status, practiceLeftOwnerless, clerkIdentityRemoved):
            return ["status": status, "practiceLeftOwnerless": practiceLeftOwnerless,
                    "clerkIdentityRemoved": clerkIdentityRemoved]
        case .unauthorized: return ["unauthorized": true]
        case .gone: return ["gone": true]
        case .unavailable: return ["unavailable": true]
        case .retryable: return ["retryable": true]
        case .recordingActive: return ["recordingActive": true]
        case .rejected: return nil
        }
    }

    public static func resolve(origin: String, statusCode: Int, body: Data?) -> [String: Any]? {
        allowsCoreOrigin(origin) ? bridgePayload(for: interpret(statusCode: statusCode, body: body)) : nil
    }

    /// Wipe only on definitive 200 deleted/already_deleted. Never on throw or same-attempt 401.
    /// `sent` markers from an earlier attempt may confirm when a later answer is definitive 200.
    @MainActor
    public static func attempt(
        holdsOrOpeningRecording: () -> Bool, origin: String?,
        mintToken: () async throws -> String,
        send: (URLRequest) async throws -> (Data, URLResponse),
        beginDeletion: (() -> Void)? = nil,
        endDeletion: (() -> Void)? = nil,
        markerPrepared: (() -> Void)? = nil,
        markerSent: (() -> Void)? = nil,
        markerConfirm: (() -> Void)? = nil,
        markerAbandonPrepared: (() -> Void)? = nil
    ) async -> [String: Any]? {
        if holdsOrOpeningRecording() { return bridgePayload(for: .recordingActive) }
        guard let origin, accountDeleteURL(origin: origin) != nil else { return nil }
        var reachedSend = false
        markerPrepared?()
        beginDeletion?()
        defer { endDeletion?(); if !reachedSend { markerAbandonPrepared?() } }
        do {
            let token = try await mintToken()
            // H9: recheck recording after mint await (deletion flag is not part of holds).
            if holdsOrOpeningRecording() { return bridgePayload(for: .recordingActive) }
            guard let request = makeAuthorizedAccountDeleteRequest(
                origin: origin, bearerToken: token) else { return nil }
            markerSent?()
            reachedSend = true
            let (data, response) = try await send(request)
            guard let http = response as? HTTPURLResponse else { return nil }
            // 401 is never a delete — keepSession / re-auth upstream; leave sent marker if any.
            if http.statusCode == 401 { return bridgePayload(for: .unauthorized) }
            let payload = resolve(origin: origin, statusCode: http.statusCode, body: data)
            if payload?["status"] != nil { markerConfirm?() }
            else if http.statusCode != 401 { markerAbandonPrepared?() }
            return payload
        } catch {
            // Offline / mint / transport throw: never invent already_deleted.
            return nil
        }
    }

    private static func isExactLocalhostHTTP(_ origin: String) -> Bool {
        guard let url = URL(string: origin), url.scheme == "http",
              let host = url.host, host == "127.0.0.1" || host == "localhost",
              let port = url.port, (1...65_535).contains(port),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { return false }
        let expected = "http://\(host):\(port)"
        return origin == expected || origin == expected + "/"
    }
}
