import Foundation

/// Durable, metadata-only account ownership sidecar for SecureQueue.
/// Never stores PHI, transcript text, or object URLs — only account ids and key digests.
struct SecureQueueAccountIndex: Equatable {
    static let schemaVersion = 2
    static let fileName = "account-index-v1.json"
    static let pendingWipeFileName = "pending-wipe-account-v1.json"
    private static let digestPattern = #"^[0-9a-f]{64}$"#

    var migrated: Bool
    /// Opaque / unparseable digests written after migration → owning recoveryScope.
    var ownedDigests: [String: String]
    /// Exact accountIdentitySHA256 → recoveryScope. Null identity never matches.
    var rememberedScopes: [String: String]
    /// Explicit write-time owner from the live signed-in session. Never inferred.
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

    mutating func setActiveWriteAccountId(_ accountId: String?) {
        if let accountId {
            activeWriteAccountId = SecureQueueAccountScope.normalizedAccountId(accountId)
        } else {
            activeWriteAccountId = nil
        }
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
        // Explicit null — never infer a write owner from rememberedScopes.
        if let activeWriteAccountId {
            payload["activeWriteAccountId"] = activeWriteAccountId
        } else {
            payload["activeWriteAccountId"] = NSNull()
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

        let owned: [String: String]
        let scopes: [String: String]
        if version >= schemaVersion {
            // v2: missing or wrong-typed maps are corrupt; digests must be 64 hex chars.
            guard let rawOwned = object["ownedDigests"] as? [String: String] else {
                throw SecureQueueError.corrupt
            }
            guard let rawScopes = object["rememberedScopes"] as? [String: String] else {
                throw SecureQueueError.corrupt
            }
            owned = try decodeOwnedDigests(rawOwned)
            scopes = try decodeRememberedScopes(rawScopes)
        } else {
            // Round-1: ownedDigests absent; absorb remembered pair; drop claims.
            if let rawOwned = object["ownedDigests"] as? [String: String] {
                owned = try decodeOwnedDigests(rawOwned)
            } else if object["ownedDigests"] != nil {
                throw SecureQueueError.corrupt
            } else {
                owned = [:]
            }
            if let rawScopes = object["rememberedScopes"] as? [String: String] {
                scopes = try decodeRememberedScopes(rawScopes)
            } else {
                scopes = try absorbRound1Remembered(object)
            }
            _ = object["legacyDigests"]
            _ = object["claimedLegacy"]
        }

        let active: String?
        if object["activeWriteAccountId"] is NSNull || object["activeWriteAccountId"] == nil {
            active = nil
        } else if let rawActive = object["activeWriteAccountId"] as? String {
            guard let normalized = SecureQueueAccountScope.normalizedAccountId(rawActive) else {
                throw SecureQueueError.corrupt
            }
            active = normalized
        } else {
            throw SecureQueueError.corrupt
        }

        return SecureQueueAccountIndex(
            migrated: migrated,
            ownedDigests: owned,
            rememberedScopes: scopes,
            activeWriteAccountId: active
        )
    }

    private static func decodeOwnedDigests(_ raw: [String: String]) throws -> [String: String] {
        var owned: [String: String] = [:]
        for (digest, account) in raw {
            let hex = digest.lowercased()
            guard hex.range(of: digestPattern, options: .regularExpression) != nil else {
                throw SecureQueueError.corrupt
            }
            guard let normalized = SecureQueueAccountScope.normalizedAccountId(account) else {
                throw SecureQueueError.corrupt
            }
            owned[hex] = normalized
        }
        return owned
    }

    private static func decodeRememberedScopes(_ raw: [String: String]) throws -> [String: String] {
        var scopes: [String: String] = [:]
        for (identity, account) in raw {
            guard let normalizedIdentity = SecureQueueAccountScope.normalizedIdentity(identity),
                  let normalizedAccount = SecureQueueAccountScope.normalizedAccountId(account)
            else {
                throw SecureQueueError.corrupt
            }
            scopes[normalizedIdentity] = normalizedAccount
        }
        return scopes
    }

    private static func absorbRound1Remembered(_ object: [String: Any]) throws -> [String: String] {
        var scopes: [String: String] = [:]
        if let remembered = object["rememberedAccountId"] as? String {
            guard let normalizedAccount = SecureQueueAccountScope.normalizedAccountId(remembered) else {
                throw SecureQueueError.corrupt
            }
            if let rememberedIdentity = object["rememberedAccountIdentitySHA256"] as? String {
                guard let normalizedIdentity = SecureQueueAccountScope.normalizedIdentity(rememberedIdentity)
                else {
                    throw SecureQueueError.corrupt
                }
                scopes[normalizedIdentity] = normalizedAccount
            }
        } else if object["rememberedAccountId"] != nil {
            throw SecureQueueError.corrupt
        }
        if let rememberedIdentity = object["rememberedAccountIdentitySHA256"] as? String,
           SecureQueueAccountScope.normalizedIdentity(rememberedIdentity) == nil {
            throw SecureQueueError.corrupt
        }
        return scopes
    }
}
