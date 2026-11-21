import Foundation

/// Account-delete / launch purge. Prefer per-account wipe when a pending wipe is recorded;
/// fall back to device-wide clear only for legacy confirmed markers from before per-account SecureQueue.
public enum ClinicalSecureQueuePurge {
    public static func clearAllRemaining() throws -> Int {
        let store = try SecureQueueStore.shared.get()
        return try store.completePendingOrClearAll()
    }

    public static func wipeAccountRemaining(_ accountId: String) throws -> Int {
        let store = try SecureQueueStore.shared.get()
        return try store.wipeAccount(accountId)
    }
}
