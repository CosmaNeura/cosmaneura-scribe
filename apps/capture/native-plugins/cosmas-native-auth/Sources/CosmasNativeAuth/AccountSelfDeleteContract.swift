import Foundation

/// Shared Cosmas T-REL-8a / PR #940 self-delete contract for iPhone and Mac.
/// Pure parsing and origin fencing — no network, tokens, or UI.
public enum AccountSelfDeleteContract {
    public enum Outcome: Equatable, Sendable {
        case deleted(status: String, practiceLeftOwnerless: Bool, clerkIdentityRemoved: Bool)
        case unauthorized
        case gone
        case unavailable
        case retryable
        case rejected
    }

    /// HTTPS Cosmas hosts plus exact localhost HTTP for sealed local dev only.
    /// Never allow arbitrary plain-http hosts to carry a Bearer token.
    public static func allowsCoreOrigin(_ origin: String) -> Bool {
        if origin == "https://staging-app.cosmaneura.com" || origin == "https://app.cosmaneura.com" {
            return true
        }
        return isExactLocalhostHTTP(origin)
    }

    /// Map sealed Clerk frontendOrigin → Cosmas coreOrigin (Mac Info.plist path).
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
        case .rejected: return nil
        }
    }

    /// Shared iPhone + Mac deleteAccount decision: origin fence then HTTP interpret.
    /// Returns nil when the origin is forbidden or the response is rejected.
    public static func resolve(origin: String, statusCode: Int, body: Data?) -> [String: Any]? {
        guard allowsCoreOrigin(origin) else { return nil }
        return bridgePayload(for: interpret(statusCode: statusCode, body: body))
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
