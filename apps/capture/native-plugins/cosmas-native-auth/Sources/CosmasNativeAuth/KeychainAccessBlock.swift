import Foundation
import Security

/// One app-scoped Boolean. It never reads or writes Clerk's credential records.
@MainActor public final class KeychainAccessBlock: NativeAuthAccessBlock {
    private let query: [CFString: Any]

    public init(bundleIdentifier: String) throws {
        guard NativeWorkspaceOrigin.appleWebView.accepts(bundleIdentifier: bundleIdentifier) ||
              NativeWorkspaceOrigin.desktopApp.accepts(bundleIdentifier: bundleIdentifier) else {
            throw NativeAuthError.storageUnavailable
        }
        var value: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: bundleIdentifier + ".workspace-auth",
            kSecAttrAccount: "local-access-block-v1",
        ]
#if os(macOS) && SCRIBE_MAC_APP_STORE_XPC
        guard bundleIdentifier == NativeClerkConfiguration.desktopBundleIdentifier else {
            throw NativeAuthError.storageUnavailable
        }
        value[kSecAttrAccessGroup] = "JVV65668U6." + bundleIdentifier
        value[kSecUseDataProtectionKeychain] = true
#endif
        query = value
    }

    public func isBlocked() throws -> Bool {
        var request = query
        request[kSecReturnData] = true
        request[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return false }
        guard status == errSecSuccess, let value = result as? Data,
              value == Data([0]) || value == Data([1]) else {
            throw NativeAuthError.storageUnavailable
        }
        return value == Data([1])
    }

    public func setBlocked(_ blocked: Bool) throws {
        let data = Data([blocked ? 1 : 0])
        var item = query
        item[kSecValueData] = data
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let inserted = SecItemAdd(item as CFDictionary, nil)
        if inserted == errSecSuccess { return }
        guard inserted == errSecDuplicateItem,
              SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary) == errSecSuccess else {
            throw NativeAuthError.storageUnavailable
        }
    }
}
