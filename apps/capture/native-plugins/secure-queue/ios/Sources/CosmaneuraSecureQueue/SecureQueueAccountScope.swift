import Foundation

/// Per-account SecureQueue ownership. Account id is the Core recoveryScope UUID
/// already embedded in clinical key prefixes (same custody unit desktop wipeAccount uses).
enum SecureQueueAccountScope {
    private static let uuidPattern =
        #"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"#
    private static let identityPattern = #"^[0-9a-f]{64}$"#

    /// Clinical key prefixes that must not remain after a successful account wipe.
    static let clinicalPrefixes: [String] = [
        "provider-workspace-v1:",
        "creator-transcript-edit-v1:",
        "creator-review-v1:",
        "provider-encounter-creation-v1:",
        "provider-hidden-visits-v1:",
        "provider-patient-match-v1:",
        "scribe-provider-queue:v1:",
        "scribe-native-",
    ]

    static func normalizedAccountId(_ raw: String) -> String? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard value.range(of: uuidPattern, options: .regularExpression) != nil else { return nil }
        return value
    }

    static func normalizedIdentity(_ raw: String) -> String? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard value.range(of: identityPattern, options: .regularExpression) != nil else { return nil }
        return value
    }

    static func isClinicalKey(_ key: String) -> Bool {
        clinicalPrefixes.contains { key.hasPrefix($0) }
    }

    /// Extract recoveryScope from known clinical / native key shapes. Returns nil when
    /// the key has no recoverable account field (opaque native digests / legacy).
    static func accountId(forKey key: String) -> String? {
        let parts = key.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 2 else { return nil }

        func uuid(at index: Int) -> String? {
            guard index < parts.count else { return nil }
            return normalizedAccountId(parts[index])
        }

        switch parts[0] {
        case "provider-workspace-v1",
             "creator-transcript-edit-v1",
             "creator-review-v1",
             "provider-encounter-creation-v1",
             "provider-hidden-visits-v1",
             "provider-patient-match-v1":
            return uuid(at: 1)
        case "scribe-provider-queue":
            // scribe-provider-queue:v1:{recoveryScope}:{workspaceId}:{sessionId}:...
            guard parts.count >= 3, parts[1] == "v1" else { return nil }
            return uuid(at: 2)
        case "scribe-native-flow",
             "scribe-native-reservations",
             "scribe-native-initial-window",
             "scribe-native-resume-window":
            // scribe-native-*:v1:{keyAccount}:{recoveryScope}...
            guard parts.count >= 4, parts[1] == "v1" else { return nil }
            return uuid(at: 3)
        default:
            return nil
        }
    }

    static func belongs(key: String, toAccount account: String) -> Bool {
        guard let expected = normalizedAccountId(account) else { return false }
        if let parsed = accountId(forKey: key) { return parsed == expected }
        return false
    }

    static func digestHex(for key: String) throws -> String {
        try SecureQueueRecordCodec.digest(for: key).map { String(format: "%02x", $0) }.joined()
    }

    static func digestHex(fromDigest digest: Data) -> String {
        digest.map { String(format: "%02x", $0) }.joined()
    }
}
