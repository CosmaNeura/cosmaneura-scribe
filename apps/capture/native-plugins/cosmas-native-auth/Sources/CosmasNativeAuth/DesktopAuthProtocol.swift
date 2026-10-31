import Foundation
import CryptoKit

/// Dedicated parent/child pipes only. There is no TCP or renderer entry point.
public struct DesktopAuthRequest: Sendable {
    public enum Method: String, Sendable { case getState, signIn, signOut, getToken }
    public let id: String
    public let method: Method
    public let revision: String?

    public init(frame: Data) throws {
        guard !frame.isEmpty, frame.count <= 1024,
              let object = try? JSONSerialization.jsonObject(with: frame) as? [String: Any],
              let id = object["id"] as? String, Self.isRevision(id),
              let rawMethod = object["method"] as? String, let method = Method(rawValue: rawMethod) else {
            throw NativeAuthError.unavailable
        }
        let revision = object["revision"] as? String
        let fields: Set<String> = method == .getToken ? ["id", "method", "revision"] : ["id", "method"]
        guard Set(object.keys) == fields,
              method != .getToken || revision.map(Self.isRevision) == true else {
            throw NativeAuthError.unavailable
        }
        self.id = id
        self.method = method
        self.revision = revision
    }

    public static func isRevision(_ value: String) -> Bool {
        UUID(uuidString: value)?.uuidString.lowercased() == value
    }
}

/// Incremental frame bound applies before JSON decoding or buffering more data.
public struct DesktopAuthFrames: Sendable {
    private var pending = Data()
    public init() {}

    public mutating func append(_ byte: UInt8) throws -> DesktopAuthRequest? {
        if byte == 10 {
            let frame = pending
            pending.removeAll(keepingCapacity: true)
            return try DesktopAuthRequest(frame: frame)
        }
        guard pending.count < 1024 else { throw NativeAuthError.unavailable }
        pending.append(byte)
        return nil
    }

    public var hasPartialFrame: Bool { !pending.isEmpty }
}

public enum NativeAuthPayload {
    /// Optional public account correlation metadata, never authority or a session grant.
    /// The exact Clerk user ID is hashed before crossing the desktop renderer boundary.
    public static func accountIdentitySHA256(_ state: NativeAuthState) -> String? {
        guard state.phase == .ready, let identity = state.identity else { return nil }
        return SHA256.hash(data: Data(identity.userID.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public static func state(_ state: NativeAuthState, identityProfile: NativeIdentityProfile? = nil) -> [String: Any] {
        let identity: Any = state.identity.map { value in
            var payload = value.bridgePayload
            if value.organizationID == nil, let identityProfile, identityProfile.isPersonalSession {
                payload["identityProfile"] = identityProfile.rawValue
            }
            return payload
        } ?? NSNull()
        return ["phase": state.phase.rawValue, "revision": state.revision, "identity": identity]
    }
}
