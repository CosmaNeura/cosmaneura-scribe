import Foundation

/// Account-scoped clinical SecureQueue purge helpers for CosmasWorkspaceAuth launch retry.
public enum ClinicalSecureQueuePurge {
    /// v1 marker only (no account id key): full-device clinical wipe. Ignores pending-wipe file.
    public static func clearAllRemaining() throws -> Int {
        let store = try SecureQueueStore.shared.get()
        return try store.clearAllIgnoringPendingWipe()
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

    public static func setActiveWriteAccount(_ accountId: String?) throws {
        let store = try SecureQueueStore.shared.get()
        try store.setActiveWriteAccount(accountId)
    }
}
