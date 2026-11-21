import Foundation

/// Per-account SecureQueue ownership. Account id is the Core recoveryScope UUID
/// already embedded in clinical key prefixes (same custody unit desktop wipeAccount uses).
enum SecureQueueAccountScope {
    static let legacyAccountId = "legacy-unattributed"
    private static let uuidPattern =
        #"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"#

    static func normalizedAccountId(_ raw: String) -> String? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard value.range(of: uuidPattern, options: .regularExpression) != nil else { return nil }
        return value
    }

    /// Extract recoveryScope from known clinical / native key shapes. Returns nil when
    /// the key has no recoverable account field (legacy / opaque native digests).
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

    static func belongs(key: String, toAccount accountId: String) -> Bool {
        guard let expected = normalizedAccountId(accountId) else { return false }
        if let parsed = accountId(forKey: key) { return parsed == expected }
        return false
    }
}
