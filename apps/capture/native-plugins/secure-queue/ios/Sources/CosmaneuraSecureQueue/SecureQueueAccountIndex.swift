import Foundation

/// Durable, metadata-only account ownership sidecar for SecureQueue migration.
/// Never stores PHI, transcript text, or object URLs — only account ids and key digests.
struct SecureQueueAccountIndex: Equatable {
    static let schemaVersion = 1
    static let fileName = "account-index-v1.json"
    static let pendingWipeFileName = "pending-wipe-account-v1.json"

    var migrated: Bool
    /// Digests of keys that could not be attributed from the key shape.
    var legacyDigests: Set<String>
    /// Digests claimed to a specific account (legacy attribution).
    var claimedLegacy: [String: Set<String>]
    /// Last signed-in recoveryScope remembered for purge when catalog is unavailable.
    var rememberedAccountId: String?
    var rememberedAccountIdentitySHA256: String?

    static var empty: SecureQueueAccountIndex {
        SecureQueueAccountIndex(
            migrated: false,
            legacyDigests: [],
            claimedLegacy: [:],
            rememberedAccountId: nil,
            rememberedAccountIdentitySHA256: nil
        )
    }

    func encode() throws -> Data {
        var claimed: [String: [String]] = [:]
        for (account, digests) in claimedLegacy {
            claimed[account] = digests.sorted()
        }
        var payload: [String: Any] = [
            "v": Self.schemaVersion,
            "migrated": migrated,
            "legacyDigests": legacyDigests.sorted(),
            "claimedLegacy": claimed,
        ]
        if let rememberedAccountId {
            payload["rememberedAccountId"] = rememberedAccountId
        }
        if let rememberedAccountIdentitySHA256 {
            payload["rememberedAccountIdentitySHA256"] = rememberedAccountIdentitySHA256
        }
        return try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    }

    static func decode(_ data: Data) throws -> SecureQueueAccountIndex {
        guard
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let version = object["v"] as? Int,
            version == schemaVersion,
            let migrated = object["migrated"] as? Bool
        else {
            throw SecureQueueError.corrupt
        }
        let legacyList = object["legacyDigests"] as? [String] ?? []
        var claimed: [String: Set<String>] = [:]
        if let rawClaimed = object["claimedLegacy"] as? [String: [String]] {
            for (account, digests) in rawClaimed {
                guard let normalized = SecureQueueAccountScope.normalizedAccountId(account) else {
                    throw SecureQueueError.corrupt
                }
                claimed[normalized] = Set(digests)
            }
        }
        let remembered = object["rememberedAccountId"] as? String
        let rememberedIdentity = object["rememberedAccountIdentitySHA256"] as? String
        if let remembered, SecureQueueAccountScope.normalizedAccountId(remembered) == nil {
            throw SecureQueueError.corrupt
        }
        if let rememberedIdentity,
           rememberedIdentity.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) == nil
        {
            throw SecureQueueError.corrupt
        }
        return SecureQueueAccountIndex(
            migrated: migrated,
            legacyDigests: Set(legacyList),
            claimedLegacy: claimed,
            rememberedAccountId: remembered.flatMap(SecureQueueAccountScope.normalizedAccountId),
            rememberedAccountIdentitySHA256: rememberedIdentity
        )
    }
}
