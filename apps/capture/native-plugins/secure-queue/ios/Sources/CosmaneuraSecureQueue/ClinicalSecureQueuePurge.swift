import Foundation

/// Account-delete / launch purge: clear every SecureQueue key; return remaining count.
public enum ClinicalSecureQueuePurge {
    public static func clearAllRemaining() throws -> Int {
        let store = try SecureQueueStore.shared.get()
        _ = try store.clear(forRenderer: false)
        return try store.list().count
    }
}
