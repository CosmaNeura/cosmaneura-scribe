import Foundation

/// Durable, metadata-only account ownership sidecar for SecureQueue.
/// Never stores PHI, transcript text, or object URLs — only account ids and key digests.
struct SecureQueueAccountIndex: Equatable {
    static let schemaVersion = 2
    static let fileName = "account-index-v1.json"
    static let pendingWipeFileName = "pending-wipe-account-v1.json"

    var migrated: Bool
    /// Opaque / unparseable digests written after migration → owning recoveryScope.
    var ownedDigests: [String: String]
    /// Exact accountIdentitySHA256 → recoveryScope. Null identity never matches.
    var rememberedScopes: [String: String]
    /// Last rememberAccount recoveryScope; used as write-time owner for opaque keys.
    var activeWriteAccountId: String?

    static var empty: SecureQueueAccountIndex {
        SecureQueueAccountIndex(
            migrated: false,
            ownedDigests: [:],
            rememberedScopes: [:],
            activeWriteAccountId: nil
        )
    }

    mutating func remember(accountId: String, identity: String) {
        rememberedScopes[identity] = accountId
        activeWriteAccountId = accountId
    }

    func rememberedAccountId(forIdentity identity: String) -> String? {
        rememberedScopes[identity]
    }

    mutating func forgetAccount(_ accountId: String) {
        rememberedScopes = rememberedScopes.filter { $0.value != accountId }
        ownedDigests = ownedDigests.filter { $0.value != accountId }
        if activeWriteAccountId == accountId {
            activeWriteAccountId = nil
        }
    }

    mutating func assignOwner(digestHex: String, accountId: String) {
        ownedDigests[digestHex.lowercased()] = accountId
    }

    func owner(forDigestHex digestHex: String) -> String? {
        ownedDigests[digestHex.lowercased()]
    }

    func encode() throws -> Data {
        var payload: [String: Any] = [
            "v": Self.schemaVersion,
            "migrated": migrated,
            "ownedDigests": ownedDigests,
            "rememberedScopes": rememberedScopes,
        ]
        if let activeWriteAccountId {
            payload["activeWriteAccountId"] = activeWriteAccountId
        }
        return try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    }

    static func decode(_ data: Data) throws -> SecureQueueAccountIndex {
        guard
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let version = object["v"] as? Int,
            (version == 1 || version == schemaVersion),
            let migrated = object["migrated"] as? Bool
        else {
            throw SecureQueueError.corrupt
        }

        var owned: [String: String] = [:]
        if let rawOwned = object["ownedDigests"] as? [String: String] {
            for (digest, account) in rawOwned {
                guard let normalized = SecureQueueAccountScope.normalizedAccountId(account) else {
                    throw SecureQueueError.corrupt
                }
                owned[digest.lowercased()] = normalized
            }
        }

        var scopes: [String: String] = [:]
        if let rawScopes = object["rememberedScopes"] as? [String: String] {
            for (identity, account) in rawScopes {
                guard let normalizedIdentity = SecureQueueAccountScope.normalizedIdentity(identity),
                      let normalizedAccount = SecureQueueAccountScope.normalizedAccountId(account)
                else {
                    throw SecureQueueError.corrupt
                }
                scopes[normalizedIdentity] = normalizedAccount
            }
        }

        // Absorb round-1 single remembered pair into identity-keyed map.
        if let remembered = object["rememberedAccountId"] as? String,
           let normalizedAccount = SecureQueueAccountScope.normalizedAccountId(remembered) {
            if let rememberedIdentity = object["rememberedAccountIdentitySHA256"] as? String,
               let normalizedIdentity = SecureQueueAccountScope.normalizedIdentity(rememberedIdentity),
               scopes[normalizedIdentity] == nil {
                scopes[normalizedIdentity] = normalizedAccount
            }
        } else if object["rememberedAccountId"] != nil {
            throw SecureQueueError.corrupt
        }

        if let rememberedIdentity = object["rememberedAccountIdentitySHA256"] as? String,
           SecureQueueAccountScope.normalizedIdentity(rememberedIdentity) == nil {
            throw SecureQueueError.corrupt
        }

        // H4: drop legacyDigests / claimedLegacy — never rebuild claims from a corrupt or old index.
        _ = object["legacyDigests"]
        _ = object["claimedLegacy"]

        var active: String?
        if let rawActive = object["activeWriteAccountId"] as? String {
            guard let normalized = SecureQueueAccountScope.normalizedAccountId(rawActive) else {
                throw SecureQueueError.corrupt
            }
            active = normalized
        } else if scopes.count == 1, let only = scopes.values.first {
            active = only
        }

        return SecureQueueAccountIndex(
            migrated: migrated,
            ownedDigests: owned,
            rememberedScopes: scopes,
            activeWriteAccountId: active
        )
    }
}
