import Foundation

/// Shared Cosmas T-REL-8a / PR #940 self-delete contract (iPhone + Mac).
public enum AccountSelfDeleteContract {
    public enum Outcome: Equatable, Sendable {
        case deleted(status: String, practiceLeftOwnerless: Bool, clerkIdentityRemoved: Bool)
        case unauthorized
        case gone
        case unavailable
        case retryable
        case recordingActive
        case rejected
    }

    /// HTTPS Cosmas + exact localhost HTTP; never arbitrary plain-http Bearer.
    public static func allowsCoreOrigin(_ origin: String) -> Bool {
        if origin == "https://staging-app.cosmaneura.com" || origin == "https://app.cosmaneura.com" {
            return true
        }
        return isExactLocalhostHTTP(origin)
    }

    /// DELETE URL after origin allow-list; call before minting a Clerk token.
    public static func accountDeleteURL(origin: String) -> URL? {
        guard allowsCoreOrigin(origin) else { return nil }
        return URL(string: origin + "/v1/me/account")
    }

    /// Authenticated DELETE request, or nil when the origin is refused.
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

    /// Map sealed Clerk frontendOrigin → Cosmas coreOrigin.
    public static func coreOrigin(forFrontendOrigin frontend: String) -> String? {
        switch frontend {
        case "https://resolved-emu-53.clerk.accounts.dev":
            return "https://staging-app.cosmaneura.com"
        case "https://clerk.cosmaneura.com":
            return "https://app.cosmaneura.com"
        default:
            return nil
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
                  Set(object.keys) == ["status", "practice_left_ownerless", "clerk_identity_removed"],
                  let status = object["status"] as? String,
                  status == "deleted" || status == "already_deleted",
                  let practiceLeftOwnerless = object["practice_left_ownerless"] as? Bool,
                  let clerkIdentityRemoved = object["clerk_identity_removed"] as? Bool
            else { return .rejected }
            return .deleted(status: status, practiceLeftOwnerless: practiceLeftOwnerless,
                            clerkIdentityRemoved: clerkIdentityRemoved)
        default:
            return .rejected
        }
    }

    public static func bridgePayload(for outcome: Outcome) -> [String: Any]? {
        switch outcome {
        case let .deleted(status, practiceLeftOwnerless, clerkIdentityRemoved):
            return [
                "status": status,
                "practiceLeftOwnerless": practiceLeftOwnerless,
                "clerkIdentityRemoved": clerkIdentityRemoved,
            ]
        case .unauthorized: return ["unauthorized": true]
        case .gone: return ["gone": true]
        case .unavailable: return ["unavailable": true]
        case .retryable: return ["retryable": true]
        case .recordingActive: return ["recordingActive": true]
        case .rejected: return nil
        }
    }

    /// Origin fence then HTTP interpret; nil when forbidden/rejected.
    public static func resolve(origin: String, statusCode: Int, body: Data?) -> [String: Any]? {
        guard allowsCoreOrigin(origin) else { return nil }
        return bridgePayload(for: interpret(statusCode: statusCode, body: body))
    }

    /// Production deleteAccount core. Recording refuse before mintToken/send.
    @MainActor
    public static func attempt(
        holdsOrOpeningRecording: Bool, origin: String?,
        mintToken: () async throws -> String,
        send: (URLRequest) async throws -> (Data, URLResponse)
    ) async -> [String: Any]? {
        if holdsOrOpeningRecording { return bridgePayload(for: .recordingActive) }
        guard let origin, accountDeleteURL(origin: origin) != nil else { return nil }
        do {
            let token = try await mintToken()
            guard let request = makeAuthorizedAccountDeleteRequest(origin: origin, bearerToken: token)
            else { return nil }
            let (data, response) = try await send(request)
            guard let http = response as? HTTPURLResponse else { return nil }
            return resolve(origin: origin, statusCode: http.statusCode, body: data)
        } catch { return nil }
    }

    private static func isExactLocalhostHTTP(_ origin: String) -> Bool {
        guard let url = URL(string: origin), url.scheme == "http",
              let host = url.host, host == "127.0.0.1" || host == "localhost",
              let port = url.port, (1...65_535).contains(port),
              url.user == nil, url.password == nil,
              url.path.isEmpty || url.path == "/",
              url.query == nil, url.fragment == nil
        else { return false }
        let expected = "http://\(host):\(port)"
        return origin == expected || origin == expected + "/"
    }
}
