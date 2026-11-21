import Foundation

/// Account-scoped clinical SecureQueue purge helpers for CosmasWorkspaceAuth launch retry.
public enum ClinicalSecureQueuePurge {
    /// v1 marker only (no account id): full-device clinical wipe. Returns remaining key count.
    public static func clearAllRemaining() throws -> Int {
        let store = try SecureQueueStore.shared.get()
        return try store.completePendingOrClearAll()
    }

    /// Per-account wipe + unconditional unattributable residue delete. Returns remaining (0 = empty).
    public static func wipeAccountRemaining(_ accountId: String) throws -> Int {
        let store = try SecureQueueStore.shared.get()
        return try store.wipeAccount(accountId)
    }

    public static func rememberedAccountId(forIdentity identity: String) throws -> String? {
        let store = try SecureQueueStore.shared.get()
        return try store.rememberedAccount(accountIdentitySHA256: identity)?.accountId
    }
}
